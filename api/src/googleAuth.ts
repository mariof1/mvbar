import { FastifyInstance, FastifyPluginCallback } from 'fastify';
import fp from 'fastify-plugin';
import { OAuth2Client } from 'google-auth-library';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import https from 'https';
import { db } from './db.js';
import { config } from './config.js';

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GOOGLE_CALLBACK_URL = process.env.GOOGLE_CALLBACK_URL || '';
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';
const AVATARS_DIR = process.env.AVATARS_DIR || '/avatars';

// Check if Google OAuth is configured
export function isGoogleOAuthEnabled(): boolean {
  return !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && GOOGLE_CALLBACK_URL);
}

let oauthClient: OAuth2Client | null = null;

function getOAuthClient(): OAuth2Client {
  if (!oauthClient) {
    oauthClient = new OAuth2Client(
      GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET,
      GOOGLE_CALLBACK_URL
    );
  }
  return oauthClient;
}

// Download avatar from URL and save locally
async function downloadAvatar(url: string, userId: string): Promise<string | null> {
  try {
    // Ensure avatars directory exists
    if (!fs.existsSync(AVATARS_DIR)) {
      fs.mkdirSync(AVATARS_DIR, { recursive: true });
    }

    const filename = `${userId}.jpg`;
    const filepath = path.join(AVATARS_DIR, filename);

    return new Promise((resolve) => {
      https.get(url, (response) => {
        // Follow redirects
        if (response.statusCode === 301 || response.statusCode === 302) {
          const redirectUrl = response.headers.location;
          if (redirectUrl) {
            https.get(redirectUrl, (redirectResponse) => {
              const fileStream = fs.createWriteStream(filepath);
              redirectResponse.pipe(fileStream);
              fileStream.on('finish', () => {
                fileStream.close();
                resolve(filename);
              });
              fileStream.on('error', () => resolve(null));
            }).on('error', () => resolve(null));
          } else {
            resolve(null);
          }
          return;
        }

        if (response.statusCode !== 200) {
          resolve(null);
          return;
        }

        const fileStream = fs.createWriteStream(filepath);
        response.pipe(fileStream);
        fileStream.on('finish', () => {
          fileStream.close();
          resolve(filename);
        });
        fileStream.on('error', () => resolve(null));
      }).on('error', () => resolve(null));
    });
  } catch {
    return null;
  }
}

// Generate JWT token (same as auth.ts)
function signJwt(payload: object, expiresInSeconds = 86400 * 7): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const fullPayload = { ...payload, iat: now, exp: now + expiresInSeconds };
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${b64(header)}.${b64(fullPayload)}`;
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(unsigned).digest('base64url');
  return `${unsigned}.${sig}`;
}

const googleAuthPlugin: FastifyPluginCallback = (fastify: FastifyInstance, _opts, done) => {
  // Check if Google OAuth is enabled
  fastify.get('/api/auth/google/enabled', async () => {
    return { enabled: isGoogleOAuthEnabled() };
  });

  // Initiate Google OAuth flow
  fastify.get('/api/auth/google', async (request, reply) => {
    if (!isGoogleOAuthEnabled()) {
      return reply.status(400).send({ error: 'Google OAuth not configured' });
    }

    const client = getOAuthClient();
    const authUrl = client.generateAuthUrl({
      access_type: 'offline',
      scope: [
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/userinfo.profile',
      ],
      prompt: 'consent', // Always show consent to get refresh token
    });

    return reply.redirect(authUrl);
  });

  // Google OAuth callback
  fastify.get<{ Querystring: { code?: string; error?: string } }>(
    '/api/auth/google/callback',
    async (request, reply) => {
      if (!isGoogleOAuthEnabled()) {
        return reply.status(400).send({ error: 'Google OAuth not configured' });
      }

      const { code, error } = request.query;

      if (error) {
        // User cancelled or error occurred
        return reply.redirect('/?error=google_auth_cancelled');
      }

      if (!code) {
        return reply.redirect('/?error=google_auth_no_code');
      }

      try {
        const client = getOAuthClient();
        const { tokens } = await client.getToken(code);
        client.setCredentials(tokens);

        // Get user info
        const ticket = await client.verifyIdToken({
          idToken: tokens.id_token!,
          audience: GOOGLE_CLIENT_ID,
        });
        const payload = ticket.getPayload();

        if (!payload || !payload.email) {
          return reply.redirect('/?error=google_auth_no_email');
        }

        const googleId = payload.sub;
        const email = payload.email;
        const name = payload.name || email.split('@')[0];
        const pictureUrl = payload.picture;
        const refreshToken = tokens.refresh_token;

        // Check if user exists by Google ID
        const pool = db();
        let result = await pool.query(
          'SELECT id, email, role, session_version, approval_status, avatar_path FROM users WHERE google_id = $1',
          [googleId]
        );

        let user = result.rows[0];
        let isNewUser = false;

        if (!user) {
          // Check if user exists by email (for migration)
          result = await pool.query(
            'SELECT id, email, role, session_version, approval_status, avatar_path FROM users WHERE email = $1',
            [email]
          );
          user = result.rows[0];

          if (user) {
            // Existing local user - link Google account
            // Only allow linking for non-admin users
            if (user.role === 'admin') {
              return reply.redirect('/?error=admin_cannot_use_google');
            }

            await pool.query(
              'UPDATE users SET google_id = $1, google_refresh_token = $2 WHERE id = $3',
              [googleId, refreshToken || null, user.id]
            );
            fastify.log.info(`Linked Google account to existing user: ${email}`);
          } else {
            // New user - create with pending approval
            const userId = crypto.randomUUID();
            isNewUser = true;

            await pool.query(
              `INSERT INTO users (id, email, role, google_id, google_refresh_token, approval_status, session_version)
               VALUES ($1, $2, 'user', $3, $4, 'pending', 0)`,
              [userId, email, googleId, refreshToken || null]
            );

            user = {
              id: userId,
              email,
              role: 'user',
              session_version: 0,
              approval_status: 'pending',
              avatar_path: null,
            };

            fastify.log.info(`Created new Google user (pending approval): ${email}`);
          }
        } else if (refreshToken) {
          // Update refresh token for existing user (Google returns new one occasionally)
          await pool.query(
            'UPDATE users SET google_refresh_token = $1 WHERE id = $2',
            [refreshToken, user.id]
          );
        }

        // Download/update avatar
        if (pictureUrl) {
          const avatarFilename = await downloadAvatar(pictureUrl, user.id);
          if (avatarFilename && avatarFilename !== user.avatar_path) {
            await pool.query(
              'UPDATE users SET avatar_path = $1 WHERE id = $2',
              [avatarFilename, user.id]
            );
            user.avatar_path = avatarFilename;
          }
        }

        // Check approval status
        if (user.approval_status === 'pending') {
          return reply.redirect('/?pending=true');
        }

        if (user.approval_status === 'rejected') {
          return reply.redirect('/?error=account_rejected');
        }

        // Generate JWT token
        const token = signJwt({
          sub: user.id,
          email: user.email,
          role: user.role,
          sv: user.session_version,
        });

        // Set cookie and redirect
        reply.setCookie(config.cookieName, token, {
          path: '/',
          httpOnly: true,
          secure: true,
          sameSite: 'lax',
          maxAge: 60 * 60 * 24 * 7, // 7 days
        });

        return reply.redirect('/');
      } catch (err) {
        fastify.log.error(err, 'Google OAuth callback error');
        return reply.redirect('/?error=google_auth_failed');
      }
    }
  );

  // Serve avatar images
  fastify.get<{ Params: { filename: string } }>(
    '/api/avatars/:filename',
    async (request, reply) => {
      const { filename } = request.params;
      const filepath = path.join(AVATARS_DIR, filename);

      if (!fs.existsSync(filepath)) {
        return reply.status(404).send({ error: 'Avatar not found' });
      }

      const stream = fs.createReadStream(filepath);
      reply.header('Content-Type', 'image/jpeg');
      reply.header('Cache-Control', 'public, max-age=86400');
      return reply.send(stream);
    }
  );

  // Admin: Get pending users
  fastify.get('/api/admin/users/pending', async (request, reply) => {
    const user = (request as any).user;
    if (!user || user.role !== 'admin') {
      return reply.status(403).send({ error: 'Admin access required' });
    }

    const pool = db();
    const result = await pool.query(
      `SELECT id, email, created_at, avatar_path 
       FROM users 
       WHERE approval_status = 'pending' 
       ORDER BY created_at DESC`
    );

    return { users: result.rows };
  });

  // Admin: Approve user
  fastify.post<{ Params: { userId: string } }>(
    '/api/admin/users/:userId/approve',
    async (request, reply) => {
      const user = (request as any).user;
      if (!user || user.role !== 'admin') {
        return reply.status(403).send({ error: 'Admin access required' });
      }

      const { userId } = request.params;
      const pool = db();

      const result = await pool.query(
        `UPDATE users SET approval_status = 'approved' WHERE id = $1 AND approval_status = 'pending' RETURNING email`,
        [userId]
      );

      if (result.rowCount === 0) {
        return reply.status(404).send({ error: 'User not found or already processed' });
      }

      fastify.log.info(`Admin approved user: ${result.rows[0].email}`);
      return { success: true };
    }
  );

  // Admin: Reject user
  fastify.post<{ Params: { userId: string } }>(
    '/api/admin/users/:userId/reject',
    async (request, reply) => {
      const user = (request as any).user;
      if (!user || user.role !== 'admin') {
        return reply.status(403).send({ error: 'Admin access required' });
      }

      const { userId } = request.params;
      const pool = db();

      const result = await pool.query(
        `UPDATE users SET approval_status = 'rejected' WHERE id = $1 AND approval_status = 'pending' RETURNING email`,
        [userId]
      );

      if (result.rowCount === 0) {
        return reply.status(404).send({ error: 'User not found or already processed' });
      }

      fastify.log.info(`Admin rejected user: ${result.rows[0].email}`);
      return { success: true };
    }
  );

  // Admin: Trigger avatar sync manually
  fastify.post('/api/admin/sync-avatars', async (request, reply) => {
    const user = (request as any).user;
    if (!user || user.role !== 'admin') {
      return reply.status(403).send({ error: 'Admin access required' });
    }

    // Run sync in background
    syncGoogleAvatars(fastify.log).catch(err => fastify.log.error(err, 'Manual avatar sync error'));
    return { success: true, message: 'Avatar sync started' };
  });

  // Get current user profile (with avatar and account type)
  fastify.get('/api/users/profile', async (request, reply) => {
    const user = (request as any).user;
    if (!user) {
      return reply.status(401).send({ error: 'Not authenticated' });
    }

    const pool = db();
    const result = await pool.query(
      `SELECT id, email, role, avatar_path, google_id, created_at FROM users WHERE id = $1`,
      [user.userId]
    );

    if (result.rowCount === 0) {
      return reply.status(404).send({ error: 'User not found' });
    }

    const u = result.rows[0];
    return {
      id: u.id,
      email: u.email,
      role: u.role,
      avatar_path: u.avatar_path,
      auth_type: u.google_id ? 'google' : 'local',
      created_at: u.created_at,
    };
  });

  // Upload avatar for current user
  fastify.post('/api/users/avatar', async (request, reply) => {
    const user = (request as any).user;
    if (!user) {
      return reply.status(401).send({ error: 'Not authenticated' });
    }

    try {
      const data = await request.file();
      if (!data) {
        return reply.status(400).send({ error: 'No file uploaded' });
      }

      // Validate file type
      const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
      if (!allowedTypes.includes(data.mimetype)) {
        return reply.status(400).send({ error: 'Invalid file type. Use JPEG, PNG, GIF, or WebP' });
      }

      // Ensure avatars directory exists
      if (!fs.existsSync(AVATARS_DIR)) {
        fs.mkdirSync(AVATARS_DIR, { recursive: true });
      }

      // Save file
      const ext = data.mimetype.split('/')[1] === 'jpeg' ? 'jpg' : data.mimetype.split('/')[1];
      const filename = `${user.userId}.${ext}`;
      const filepath = path.join(AVATARS_DIR, filename);

      // Delete old avatar if exists with different extension
      const existingFiles = fs.readdirSync(AVATARS_DIR).filter(f => f.startsWith(user.userId + '.'));
      for (const f of existingFiles) {
        fs.unlinkSync(path.join(AVATARS_DIR, f));
      }

      // Write new file
      const buffer = await data.toBuffer();
      fs.writeFileSync(filepath, buffer);

      // Update database
      const pool = db();
      await pool.query(
        'UPDATE users SET avatar_path = $1 WHERE id = $2',
        [filename, user.userId]
      );

      return { success: true, avatar_path: filename };
    } catch (err) {
      fastify.log.error(err, 'Avatar upload error');
      return reply.status(500).send({ error: 'Failed to upload avatar' });
    }
  });

  // Delete avatar for current user
  fastify.delete('/api/users/avatar', async (request, reply) => {
    const user = (request as any).user;
    if (!user) {
      return reply.status(401).send({ error: 'Not authenticated' });
    }

    const pool = db();
    const result = await pool.query(
      'SELECT avatar_path FROM users WHERE id = $1',
      [user.userId]
    );

    if (result.rows[0]?.avatar_path) {
      const filepath = path.join(AVATARS_DIR, result.rows[0].avatar_path);
      if (fs.existsSync(filepath)) {
        fs.unlinkSync(filepath);
      }
    }

    await pool.query(
      'UPDATE users SET avatar_path = NULL WHERE id = $1',
      [user.userId]
    );

    return { success: true };
  });

  // Unlink Google account
  fastify.post<{ Body: { action: 'convert' | 'delete'; password?: string } }>(
    '/api/users/unlink-google',
    async (request, reply) => {
      const user = (request as any).user;
      if (!user) {
        return reply.status(401).send({ error: 'Not authenticated' });
      }

      const { action, password } = request.body || {};

      const pool = db();
      const result = await pool.query(
        'SELECT id, email, google_id, password_hash FROM users WHERE id = $1',
        [user.userId]
      );

      if (result.rowCount === 0) {
        return reply.status(404).send({ error: 'User not found' });
      }

      const u = result.rows[0];

      if (!u.google_id) {
        return reply.status(400).send({ error: 'Account is not linked to Google' });
      }

      if (action === 'delete') {
        // Delete the account entirely
        await pool.query('DELETE FROM users WHERE id = $1', [user.userId]);
        reply.clearCookie(config.cookieName, { path: '/' });
        return { success: true, action: 'deleted' };
      }

      if (action === 'convert') {
        // Convert to local account - requires setting a password
        if (!password || password.length < 8) {
          return reply.status(400).send({ error: 'Password must be at least 8 characters' });
        }

        // Hash the password using scrypt (same as auth.ts)
        const salt = crypto.randomBytes(16).toString('hex');
        const hash = crypto.scryptSync(password, salt, 64).toString('hex');
        const passwordHash = `${salt}:${hash}`;

        await pool.query(
          'UPDATE users SET google_id = NULL, google_refresh_token = NULL, password_hash = $1 WHERE id = $2',
          [passwordHash, user.userId]
        );

        return { success: true, action: 'converted' };
      }

      return reply.status(400).send({ error: 'Invalid action. Use "convert" or "delete"' });
    }
  );

  done();
};

// Sync Google avatars for all users with refresh tokens
export async function syncGoogleAvatars(logger?: { info: (...args: any[]) => void; error: (...args: any[]) => void }): Promise<void> {
  if (!isGoogleOAuthEnabled()) {
    return;
  }

  const log = logger || console;
  const pool = db();
  
  // Get all users with Google accounts and refresh tokens
  const result = await pool.query(
    `SELECT id, email, google_refresh_token, avatar_path 
     FROM users 
     WHERE google_id IS NOT NULL AND google_refresh_token IS NOT NULL`
  );

  log.info(`Avatar sync: checking ${result.rowCount} Google users`);

  for (const user of result.rows) {
    try {
      const client = new OAuth2Client(
        GOOGLE_CLIENT_ID,
        GOOGLE_CLIENT_SECRET,
        GOOGLE_CALLBACK_URL
      );
      
      client.setCredentials({ refresh_token: user.google_refresh_token });
      
      // Get new access token
      const { credentials } = await client.refreshAccessToken();
      client.setCredentials(credentials);
      
      // Fetch user info using the access token
      const userInfoResponse = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: {
          Authorization: `Bearer ${credentials.access_token}`,
        },
      });
      
      if (userInfoResponse.ok) {
        const userInfo = await userInfoResponse.json() as { picture?: string };
        
        if (userInfo.picture) {
          const avatarFilename = await downloadAvatar(userInfo.picture, user.id);
          if (avatarFilename) {
            await pool.query(
              'UPDATE users SET avatar_path = $1 WHERE id = $2',
              [avatarFilename, user.id]
            );
            log.info(`Avatar sync: updated avatar for ${user.email}`);
          }
        }
      } else {
        log.error(`Avatar sync: failed to fetch userinfo for ${user.email}: ${userInfoResponse.status}`);
      }
      
      // Update refresh token if a new one was provided
      if (credentials.refresh_token && credentials.refresh_token !== user.google_refresh_token) {
        await pool.query(
          'UPDATE users SET google_refresh_token = $1 WHERE id = $2',
          [credentials.refresh_token, user.id]
        );
      }
    } catch (err: any) {
      log.error(`Avatar sync: failed for ${user.email}: ${err.message}`);
      // If refresh token is invalid, clear it
      if (err.message?.includes('invalid_grant') || err.message?.includes('Token has been expired')) {
        await pool.query(
          'UPDATE users SET google_refresh_token = NULL WHERE id = $1',
          [user.id]
        );
        log.info(`Avatar sync: cleared invalid refresh token for ${user.email}`);
      }
    }
  }

  log.info('Avatar sync: complete');
}

// Start avatar sync scheduler (runs daily)
let syncInterval: NodeJS.Timeout | null = null;

export function startAvatarSyncScheduler(logger?: { info: (...args: any[]) => void; error: (...args: any[]) => void }): void {
  if (!isGoogleOAuthEnabled()) {
    return;
  }

  const log = logger || console;
  const SYNC_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours

  // Run initial sync after 5 minutes (let server stabilize)
  setTimeout(() => {
    syncGoogleAvatars(log).catch(err => log.error('Avatar sync error:', err));
  }, 5 * 60 * 1000);

  // Schedule daily sync
  syncInterval = setInterval(() => {
    syncGoogleAvatars(log).catch(err => log.error('Avatar sync error:', err));
  }, SYNC_INTERVAL);

  log.info('Avatar sync scheduler started (runs every 24 hours)');
}

export function stopAvatarSyncScheduler(): void {
  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = null;
  }
}

export default fp(googleAuthPlugin, { name: 'googleAuth' });

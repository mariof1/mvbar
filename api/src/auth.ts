import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import { config } from './config.js';
import { store, type Role } from './store.js';
import { hashPassword, normalizeEmail, randomId, verifyPassword } from './security.js';
import { audit } from './db.js';
import * as users from './userRepo.js';
import { db } from './db.js';
import cookie from '@fastify/cookie';

declare module 'fastify' {
  interface FastifyInstance {
    auth: {
      signToken: (userId: string, role: Role, sessionVersion: number) => string;
      verifyToken: (token: string) => { userId: string; role: Role; sessionVersion: number } | null;
    };
  }

  interface FastifyRequest {
    user?: { userId: string; role: Role; sessionVersion: number };
  }
}

import crypto from 'node:crypto';

function signToken(userId: string, role: Role, sessionVersion: number) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ sub: userId, role, sv: sessionVersion, iat: Math.floor(Date.now() / 1000) })
  ).toString('base64url');
  const data = `${header}.${payload}`;
  const sig = crypto.createHmac('sha256', config.jwtSecret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

function verifyToken(token: string) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  const data = `${h}.${p}`;
  const expected = crypto.createHmac('sha256', config.jwtSecret).update(data).digest('base64url');
  if (expected !== s) return null;
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as { sub: string; role: Role; sv?: number };
  return { userId: payload.sub, role: payload.role, sessionVersion: payload.sv ?? 0 };
}

export const authPlugin: FastifyPluginAsync = fp(async (app) => {
  await app.register(cookie);

  function isSecureCookie(req: any) {
    if (config.cookieSecure === 'true') return true;
    if (config.cookieSecure === 'false') return false;
    // auto: respect external scheme when behind trusted proxy
    return Boolean(req.protocol === 'https');
  }

  function setAuthCookie(reply: any, token: string, secure: boolean) {
    reply.setCookie(config.cookieName, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure,
      path: '/',
      maxAge: 60 * 60 * 24 * 30
    });
  }

  function clearAuthCookie(reply: any, secure: boolean) {
    reply.clearCookie(config.cookieName, {
      httpOnly: true,
      sameSite: 'lax',
      secure,
      path: '/'
    });
  }

  // bootstrap admin if empty
  if ((await users.countUsers()) === 0) {
    const email = normalizeEmail(config.adminEmail);
    const id = randomId('u');
    await users.createUser({ id, email, passwordHash: hashPassword(config.adminPassword), role: 'admin' });
    await audit('bootstrap_admin', { email });
    app.log.info({ email }, 'bootstrapped admin user');
  }

  app.decorate('auth', { signToken, verifyToken });

  app.addHook('preHandler', async (req) => {
    const h = req.headers.authorization;
    let token: string | null = null;
    if (h?.startsWith('Bearer ')) token = h.slice('Bearer '.length);
    if (!token) token = (req.cookies as any)?.[config.cookieName] ?? null;
    if (!token) return;
    const verified = verifyToken(token);
    if (!verified) return;

    const user = await users.getUserById(verified.userId);
    if (!user) return;
    if (user.session_version !== verified.sessionVersion) return;

    req.user = verified;
  });

  // routes
  app.post('/api/auth/login', async (req, reply) => {
    const body = req.body as { email?: string; password?: string };
    const email = normalizeEmail(body.email ?? '');
    const password = body.password ?? '';

    const ip = req.ip;
    const now = Date.now();

    // Check if IP is whitelisted (bypass rate limiting)
    if (!store.rateLimitBypassIPs.has(ip)) {
      // lightweight rate limit (per IP)
      const rlKey = `rl:${ip}`;
      const rl = store.failedLoginsByKey.get(rlKey);
      if (!rl || now - rl.lastFailedAt > 60_000) {
        store.failedLoginsByKey.set(rlKey, { count: 1, lastFailedAt: now });
      } else {
        rl.count += 1;
        rl.lastFailedAt = now;
        if (rl.count > 5) return reply.code(429).send({ ok: false, error: 'rate_limited' });
      }
    }

    // account lockout (per IP + email)
    const key = `${ip}:${email}`;
    const state = store.failedLoginsByKey.get(key);
    if (state?.lockedUntil && now < state.lockedUntil) {
      await audit('login_locked', { email, ip });
      return reply.code(429).send({ ok: false, error: 'locked' });
    }

    const user = await users.getUserByEmail(email);

    if (!user || !verifyPassword(password, user.password_hash)) {
      const next = state ?? { count: 0, lastFailedAt: 0 };
      next.count += 1;
      next.lastFailedAt = now;
      if (next.count >= 8) next.lockedUntil = now + 15 * 60_000;
      store.failedLoginsByKey.set(key, next);
      await audit('login_failed', { email, ip });
      return reply.code(401).send({ ok: false, error: 'invalid_credentials' });
    }

    store.failedLoginsByKey.delete(key);
    const token = signToken(user.id, user.role, user.session_version);
    await audit('login_ok', { email, ip });

    // Save password for Subsonic token auth
    await db().query('UPDATE users SET subsonic_password = $1 WHERE id = $2', [password, user.id]);

    const secure = isSecureCookie(req);
    setAuthCookie(reply, token, secure);

    return { ok: true, token, user: { id: user.id, email: user.email, role: user.role } };
  });

  app.get('/api/auth/me', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });
    const user = await users.getUserById(req.user.userId);
    if (!user) return reply.code(401).send({ ok: false });
    if (user.session_version !== req.user.sessionVersion) {
      const secure = isSecureCookie(req);
      clearAuthCookie(reply, secure);
      return reply.code(401).send({ ok: false, error: 'session_invalid' });
    }
    return { ok: true, user: { id: user.id, email: user.email, role: user.role, avatar_path: user.avatar_path || null } };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const secure = isSecureCookie(req);
    clearAuthCookie(reply, secure);
    return { ok: true };
  });

  app.post('/api/auth/change-password', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });

    const body = (req.body ?? {}) as { currentPassword?: string; newPassword?: string };
    const currentPassword = body.currentPassword ?? '';
    const newPassword = body.newPassword ?? '';
    if (newPassword.length < 8) return reply.code(400).send({ ok: false });

    const user = await users.getUserById(req.user.userId);
    if (!user) return reply.code(401).send({ ok: false });
    if (user.session_version !== req.user.sessionVersion) return reply.code(401).send({ ok: false, error: 'session_invalid' });

    if (!verifyPassword(currentPassword, user.password_hash)) return reply.code(403).send({ ok: false, error: 'bad_password' });

    await users.setPassword(user.id, hashPassword(newPassword));
    // Save for Subsonic token auth
    await db().query('UPDATE users SET subsonic_password = $1 WHERE id = $2', [newPassword, user.id]);
    const sv = await users.bumpSessionVersion(user.id);
    await audit('user_change_password', { by: user.id, sessionVersion: sv });

    // Return a fresh token so the user stays logged in.
    const token = signToken(user.id, user.role, sv ?? user.session_version + 1);

    const secure = isSecureCookie(req);
    setAuthCookie(reply, token, secure);

    return { ok: true, token };
  });

  app.post('/api/admin/users', async (req, reply) => {
    if (req.user?.role !== 'admin') return reply.code(403).send({ ok: false });
    const body = req.body as { email?: string; password?: string; role?: Role };
    const email = normalizeEmail(body.email ?? '');
    const password = body.password ?? '';
    const role: Role = body.role ?? 'user';

    if (!email || password.length < 8) return reply.code(400).send({ ok: false });
    if (await users.getUserByEmail(email)) return reply.code(409).send({ ok: false });

    const id = randomId('u');
    await users.createUser({ id, email, passwordHash: hashPassword(password), role });
    // Save for Subsonic token auth
    await db().query('UPDATE users SET subsonic_password = $1 WHERE id = $2', [password, id]);

    // Default access: all current libraries (admin can later restrict).
    try {
      const r = await db().query<{ id: number }>('select id from libraries');
      for (const lib of r.rows) {
        await db().query('insert into user_libraries(user_id, library_id) values ($1,$2) on conflict do nothing', [id, lib.id]);
      }
    } catch {
      // ignore
    }

    await audit('admin_create_user', { email, role, by: req.user.userId });
    return { ok: true, user: { id, email, role } };
  });

  app.post('/api/admin/users/:id/reset-password', async (req, reply) => {
    if (req.user?.role !== 'admin') return reply.code(403).send({ ok: false });
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { password?: string };
    const password = body.password ?? '';
    if (password.length < 8) return reply.code(400).send({ ok: false });

    const user = await users.getUserById(id);
    if (!user) return reply.code(404).send({ ok: false });

    await users.setPassword(id, hashPassword(password));
    // Save for Subsonic token auth
    await db().query('UPDATE users SET subsonic_password = $1 WHERE id = $2', [password, id]);
    await users.bumpSessionVersion(id);
    await audit('admin_reset_password', { userId: id, by: req.user.userId });
    return { ok: true };
  });

  app.post('/api/admin/users/:id/force-logout', async (req, reply) => {
    if (req.user?.role !== 'admin') return reply.code(403).send({ ok: false });
    const { id } = req.params as { id: string };

    const user = await users.getUserById(id);
    if (!user) return reply.code(404).send({ ok: false });

    const sv = await users.bumpSessionVersion(id);
    await audit('admin_force_logout', { userId: id, by: req.user.userId, sessionVersion: sv });

    if (id === req.user.userId) {
      const secure = isSecureCookie(req);
      clearAuthCookie(reply, secure);
    }

    return { ok: true };
  });

  app.get('/api/admin/users', async (req, reply) => {
    if (req.user?.role !== 'admin') return reply.code(403).send({ ok: false });
    const rows = await users.listUsers();
    return { ok: true, users: rows };
  });

  app.get('/api/admin/users/:id/libraries', async (req, reply) => {
    if (req.user?.role !== 'admin') return reply.code(403).send({ ok: false });
    const { id } = req.params as { id: string };
    const u = await users.getUserById(id);
    if (!u) return reply.code(404).send({ ok: false });

    const r = await db().query<{ library_id: number }>('select library_id from user_libraries where user_id=$1 order by library_id asc', [id]);
    return { ok: true, libraryIds: r.rows.map((x) => Number(x.library_id)) };
  });

  app.put('/api/admin/users/:id/libraries', async (req, reply) => {
    if (req.user?.role !== 'admin') return reply.code(403).send({ ok: false });
    const { id } = req.params as { id: string };
    const u = await users.getUserById(id);
    if (!u) return reply.code(404).send({ ok: false });

    const body = (req.body ?? {}) as { libraryIds?: number[] };
    const libraryIds = Array.isArray(body.libraryIds) ? body.libraryIds.map((x) => Number(x)).filter((x) => Number.isFinite(x)) : null;
    if (!libraryIds) return reply.code(400).send({ ok: false });

    await db().query('begin');
    try {
      await db().query('delete from user_libraries where user_id=$1', [id]);
      for (const lid of libraryIds) {
        await db().query('insert into user_libraries(user_id, library_id) values ($1,$2) on conflict do nothing', [id, lid]);
      }
      await db().query('commit');
    } catch (e) {
      await db().query('rollback');
      throw e;
    }

    const sv = await users.bumpSessionVersion(id);
    await audit('admin_set_user_libraries', { by: req.user.userId, userId: id, libraryIds, sessionVersion: sv });
    return { ok: true };
  });

  app.put('/api/admin/users/:id/role', async (req, reply) => {
    if (req.user?.role !== 'admin') return reply.code(403).send({ ok: false });
    const { id } = req.params as { id: string };
    if (id === req.user.userId) return reply.code(400).send({ ok: false, error: 'cannot_change_self_role' });

    const body = (req.body ?? {}) as { role?: Role };
    const role: Role = body.role === 'admin' ? 'admin' : body.role === 'user' ? 'user' : null as any;
    if (!role) return reply.code(400).send({ ok: false });

    const u = await users.getUserById(id);
    if (!u) return reply.code(404).send({ ok: false });

    await users.setRole(id, role);
    await users.bumpSessionVersion(id);
    await audit('admin_set_role', { by: req.user.userId, userId: id, role });
    return { ok: true };
  });

  app.delete('/api/admin/users/:id', async (req, reply) => {
    if (req.user?.role !== 'admin') return reply.code(403).send({ ok: false });
    const { id } = req.params as { id: string };
    if (id === req.user.userId) return reply.code(400).send({ ok: false, error: 'cannot_delete_self' });

    const u = await users.getUserById(id);
    if (!u) return reply.code(404).send({ ok: false });

    await users.deleteUser(id);
    await audit('admin_delete_user', { by: req.user.userId, userId: id, email: u.email });
    return { ok: true };
  });

  app.get('/api/admin/audit', async (req, reply) => {
    if (req.user?.role !== 'admin') return reply.code(403).send({ ok: false });
    const events = await users.listAudit(200);
    return { ok: true, events };
  });
});

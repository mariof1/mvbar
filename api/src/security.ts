import crypto from 'node:crypto';

export function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

export function hashPassword(password: string) {
  // Simple salted hash for scaffold only; will switch to argon2/bcrypt.
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string | null | undefined) {
  if (!stored) return false;
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  const storedHash = Buffer.from(hash, 'hex');
  const checkHash = Buffer.from(check, 'hex');
  return storedHash.length === checkHash.length && crypto.timingSafeEqual(storedHash, checkHash);
}

export function randomId(prefix = 'u') {
  return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
}

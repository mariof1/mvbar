import { isIP } from 'node:net';

export type Role = 'admin' | 'user';

export type User = {
  id: string;
  email: string;
  passwordHash: string;
  role: Role;
  createdAt: number;
};

export const LOGIN_RATE_LIMIT_WINDOW_MS = 60_000;
export const LOGIN_RATE_LIMIT_FAILURES = 5;
export const LOGIN_LOCK_DURATION_MS = 15 * 60_000;

type FailedLoginState = { count: number; lastFailedAt: number; lockedUntil?: number };

export type LoginRestriction = {
  blocked: boolean;
  locked: boolean;
  rateLimited: boolean;
  blockedUntil: number | null;
  failedAttempts: number;
  ips: string[];
};

// Minimal in-memory store for v0 scaffolding.
// Will be replaced with Postgres-backed store.
export const store = {
  users: new Map<string, User>(),
  usersByEmail: new Map<string, string>(),
  failedLoginsByKey: new Map<string, FailedLoginState>(),
  audit: [] as Array<{ ts: number; event: string; meta?: Record<string, unknown> }>,
  // IPs that bypass rate limiting (for testing/automation)
  rateLimitBypassIPs: new Set<string>()
};

export function normalizeRateLimitBypassIP(value: string) {
  const candidate = value.trim();
  const version = isIP(candidate);
  if (version === 4) return candidate;
  if (version !== 6) return null;
  const hostname = new URL(`http://[${candidate}]/`).hostname;
  return hostname.slice(1, -1).toLowerCase();
}

export function isRateLimitBypassed(ip: string) {
  const normalized = normalizeRateLimitBypassIP(ip);
  return normalized !== null && store.rateLimitBypassIPs.has(normalized);
}

function accountLoginFailures(email: string) {
  const normalizedEmail = email.trim().toLowerCase();
  const suffix = `:${normalizedEmail}`;
  return [...store.failedLoginsByKey.entries()]
    .filter(([key]) => !key.startsWith('rl:') && key.endsWith(suffix))
    .map(([key, state]) => ({
      key,
      ip: key.slice(0, -suffix.length),
      state,
    }));
}

export function loginRateLimitKey(ip: string, email: string) {
  return `rl:${ip}:${email.trim().toLowerCase()}`;
}

export function getLoginRestriction(email: string, now = Date.now()): LoginRestriction {
  const failures = accountLoginFailures(email);
  let locked = false;
  let rateLimited = false;
  let blockedUntil: number | null = null;

  for (const { ip, state } of failures) {
    if (state.lockedUntil && state.lockedUntil > now) {
      locked = true;
      blockedUntil = Math.max(blockedUntil ?? 0, state.lockedUntil);
    }

    const ipState = store.failedLoginsByKey.get(loginRateLimitKey(ip, email));
    if (
      !isRateLimitBypassed(ip)
      && ipState
      && ipState.count >= LOGIN_RATE_LIMIT_FAILURES
      && now - ipState.lastFailedAt <= LOGIN_RATE_LIMIT_WINDOW_MS
    ) {
      rateLimited = true;
      blockedUntil = Math.max(blockedUntil ?? 0, ipState.lastFailedAt + LOGIN_RATE_LIMIT_WINDOW_MS);
    }
  }

  return {
    blocked: locked || rateLimited,
    locked,
    rateLimited,
    blockedUntil,
    failedAttempts: failures.reduce((total, failure) => total + failure.state.count, 0),
    ips: [...new Set(failures.map((failure) => failure.ip))].sort(),
  };
}

export function clearLoginRestrictions(email: string, now = Date.now()) {
  const failures = accountLoginFailures(email);
  const before = getLoginRestriction(email, now);
  const ips = [...new Set(failures.map((failure) => failure.ip))].sort();

  for (const failure of failures) store.failedLoginsByKey.delete(failure.key);
  for (const ip of ips) store.failedLoginsByKey.delete(loginRateLimitKey(ip, email));

  return {
    before,
    clearedKeys: failures.length + ips.length,
    ips,
  };
}

export type Role = 'admin' | 'user';

export type User = {
  id: string;
  email: string;
  passwordHash: string;
  role: Role;
  createdAt: number;
};

// Minimal in-memory store for v0 scaffolding.
// Will be replaced with Postgres-backed store.
export const store = {
  users: new Map<string, User>(),
  usersByEmail: new Map<string, string>(),
  failedLoginsByKey: new Map<string, { count: number; lastFailedAt: number; lockedUntil?: number }>(),
  audit: [] as Array<{ ts: number; event: string; meta?: Record<string, unknown> }>,
  // IPs that bypass rate limiting (for testing/automation)
  rateLimitBypassIPs: new Set<string>()
};

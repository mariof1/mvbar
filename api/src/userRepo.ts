import { db } from './db.js';
import type { Role } from './store.js';

export type DbUser = {
  id: string;
  email: string;
  password_hash: string;
  role: Role;
  session_version: number;
  avatar_path?: string | null;
};

export async function countUsers() {
  const r = await db().query('select count(*)::int as c from users');
  return r.rows[0].c as number;
}

export async function getUserByEmail(email: string) {
  const r = await db().query<DbUser>(
    'select id, email, password_hash, role, session_version from users where email=$1',
    [email]
  );
  return r.rows[0] ?? null;
}

export async function getUserById(id: string) {
  const r = await db().query<DbUser>(
    'select id, email, password_hash, role, session_version, avatar_path from users where id=$1',
    [id]
  );
  return r.rows[0] ?? null;
}

export async function createUser(params: { id: string; email: string; passwordHash: string; role: Role }) {
  await db().query(
    'insert into users(id, email, password_hash, role) values ($1,$2,$3,$4)',
    [params.id, params.email, params.passwordHash, params.role]
  );
}

export async function setPassword(userId: string, passwordHash: string) {
  await db().query('update users set password_hash=$2 where id=$1', [userId, passwordHash]);
}

export async function bumpSessionVersion(userId: string) {
  const r = await db().query<{ session_version: number }>(
    'update users set session_version=session_version+1 where id=$1 returning session_version',
    [userId]
  );
  return r.rows[0]?.session_version ?? null;
}

export async function listAudit(limit = 200) {
  const r = await db().query('select ts, event, meta from audit_events order by id desc limit $1', [limit]);
  return r.rows;
}

export async function listUsers() {
  const r = await db().query<{ id: string; email: string; role: Role }>('select id, email, role from users order by created_at asc');
  return r.rows;
}

export async function setRole(userId: string, role: Role) {
  await db().query('update users set role=$2 where id=$1', [userId, role]);
}

export async function deleteUser(userId: string) {
  await db().query('delete from users where id=$1', [userId]);
}


import { db } from './db.js';
import type { Role } from './store.js';
import { clientAuditMeta, type ClientInfo } from './clientInfo.js';

export type DbUser = {
  id: string;
  email: string;
  password_hash: string | null;
  role: Role;
  session_version: number;
  avatar_path?: string | null;
  google_id?: string | null;
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
    'select id, email, password_hash, role, session_version, avatar_path, google_id from users where id=$1',
    [id]
  );
  return r.rows[0] ?? null;
}

export async function markUserActive(userId: string, ip: string) {
  await db().query(
    'update users set last_seen_at=now(), last_seen_ip=$2 where id=$1',
    [userId, ip]
  );
}

export async function touchClientActivity(userId: string, ip: string, client: ClientInfo) {
  await db().query(
    `
    insert into user_client_activity (
      user_id, client_id, client_type, app_version, device_name,
      platform, user_agent, first_seen_at, last_seen_at, last_seen_ip
    )
    values ($1, $2, $3, $4, $5, $6, $7, now(), now(), $8)
    on conflict (user_id, client_id) do update set
      client_type = excluded.client_type,
      app_version = coalesce(excluded.app_version, user_client_activity.app_version),
      device_name = coalesce(excluded.device_name, user_client_activity.device_name),
      platform = coalesce(excluded.platform, user_client_activity.platform),
      user_agent = coalesce(excluded.user_agent, user_client_activity.user_agent),
      last_seen_at = now(),
      last_seen_ip = excluded.last_seen_ip
    `,
    [
      userId,
      client.id,
      client.type,
      client.version,
      client.device,
      client.platform,
      client.userAgent,
      ip,
    ]
  );
}

export async function ensureSessionLogin(params: {
  email: string;
  method: 'password' | 'google';
  sessionIat: number;
  ip?: string | null;
  client?: ClientInfo;
}) {
  const clientMeta = params.client ? clientAuditMeta(params.client) : {};
  await db().query(
    `
    insert into audit_events(ts, event, meta)
    values (
      to_timestamp($1),
      'login_ok',
      jsonb_build_object(
        'email', $2::text,
        'method', $3::text,
        'sessionIat', $1::bigint
      )
      || case when $4::text is null then '{}'::jsonb else jsonb_build_object('ip', $4::text) end
      || $5::jsonb
    )
    on conflict do nothing
    `,
    [params.sessionIat, params.email, params.method, params.ip ?? null, JSON.stringify(clientMeta)]
  );
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
  const r = await db().query<{ id: string; email: string; role: Role; avatar_path: string | null }>(
    'select id, email, role, avatar_path from users order by created_at asc'
  );
  return r.rows;
}

export async function setRole(userId: string, role: Role) {
  await db().query('update users set role=$2 where id=$1', [userId, role]);
}

export async function deleteUser(userId: string) {
  await db().query('delete from users where id=$1', [userId]);
}

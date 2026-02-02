import { db } from './db.js';
import type { Role } from './store.js';

export async function allowedLibrariesForUser(userId: string, role: Role) {
  if (role === 'admin') return null as number[] | null; // null means "all"
  const r = await db().query<{ library_id: number }>('select library_id from user_libraries where user_id=$1 order by library_id asc', [userId]);
  return r.rows.map((x) => Number(x.library_id));
}

export function isLibraryAllowed(libraryId: number, allowed: number[] | null) {
  if (allowed === null) return true;
  return allowed.includes(libraryId);
}

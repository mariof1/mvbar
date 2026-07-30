import { db } from './db.js';
import type { Role } from './store.js';

export async function allowedLibrariesForUser(userId: string, role: Role) {
  if (role === 'admin') return null as number[] | null; // null means "all"
  const r = await db().query<{ library_id: number }>(
    `select user_library.library_id
     from user_libraries as user_library
     join libraries as library on library.id = user_library.library_id
     where user_library.user_id = $1 and library.enabled = true
     order by user_library.library_id asc`,
    [userId]
  );
  return r.rows.map((x) => Number(x.library_id));
}

export function isLibraryAllowed(libraryId: number, allowed: number[] | null) {
  if (allowed === null) return true;
  return allowed.includes(libraryId);
}

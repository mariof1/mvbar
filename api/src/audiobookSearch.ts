import { db } from './db.js';

export function audiobookSearchQuery(query: string, allowed: number[] | null) {
  const terms = query.trim().split(/\s+/).filter(Boolean).slice(0, 12);
  if (!terms.length || allowed?.length === 0) return null;
  const patterns = terms.map(term => `%${term.replace(/[\\%_]/g, '\\$&')}%`);
  return {
    sql: `SELECT a.id::int, a.title, a.author, (a.cover_path IS NOT NULL) AS has_cover
          FROM active_audiobooks a
          WHERE ($1::bigint[] IS NULL OR a.library_id = ANY($1::bigint[]))
            AND ${patterns.map((_, i) => `(concat_ws(' ', a.title, a.author) ILIKE $${i + 2})`).join(' AND ')}
          ORDER BY lower(a.title), a.id LIMIT 12`,
    params: [allowed, ...patterns],
  };
}

export async function searchAudiobooks(query: string, allowed: number[] | null) {
  const search = audiobookSearchQuery(query, allowed);
  if (!search) return [];
  return (await db().query(search.sql, search.params)).rows;
}

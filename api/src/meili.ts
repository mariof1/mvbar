import { MeiliSearch } from 'meilisearch';

export function meili() {
  const host = process.env.MEILI_HOST;
  const apiKey = process.env.MEILI_MASTER_KEY;
  if (!host) throw new Error('MEILI_HOST is required');
  if (!apiKey) throw new Error('MEILI_MASTER_KEY is required');
  return new MeiliSearch({ host, apiKey });
}

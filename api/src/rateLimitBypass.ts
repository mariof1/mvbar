import { db } from './db.js';
import { normalizeRateLimitBypassIP, store } from './store.js';

function currentBypassIPs() {
  return [...store.rateLimitBypassIPs].sort();
}

export async function refreshRateLimitBypassIPs() {
  const result = await db().query<{ ip: string }>(
    'select host(ip) as ip from rate_limit_bypass_ips order by ip'
  );
  store.rateLimitBypassIPs.clear();
  for (const row of result.rows) {
    const ip = normalizeRateLimitBypassIP(row.ip);
    if (ip) store.rateLimitBypassIPs.add(ip);
  }
  return currentBypassIPs();
}

export async function addRateLimitBypassIP(value: string, createdBy: string) {
  const ip = normalizeRateLimitBypassIP(value);
  if (!ip) return null;
  await db().query(
    `insert into rate_limit_bypass_ips(ip, created_by)
     values ($1::inet, $2)
     on conflict (ip) do nothing`,
    [ip, createdBy]
  );
  store.rateLimitBypassIPs.add(ip);
  return { ip, ips: currentBypassIPs() };
}

export async function removeRateLimitBypassIP(value: string) {
  const ip = normalizeRateLimitBypassIP(value);
  if (!ip) return null;
  await db().query('delete from rate_limit_bypass_ips where ip = $1::inet', [ip]);
  store.rateLimitBypassIPs.delete(ip);
  return { ip, ips: currentBypassIPs() };
}

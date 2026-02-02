import { cookies } from 'next/headers';

function apiUrlFor(id: string, seg: string) {
  const base = process.env.API_INTERNAL_BASE ?? 'http://api:3000';
  return `${base}/api/hls/${encodeURIComponent(id)}/${encodeURIComponent(seg)}`;
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string; seg: string }> }) {
  const { id, seg } = await ctx.params;
  const cookieStore = await cookies();
  const token = cookieStore.get('mvbar_token')?.value;
  if (!token) return new Response('Unauthorized', { status: 401 });

  const upstream = await fetch(apiUrlFor(id, seg), { headers: { authorization: `Bearer ${token}` } });

  const headers = new Headers();
  for (const k of ['content-type', 'content-length']) {
    const v = upstream.headers.get(k);
    if (v) headers.set(k, v);
  }
  headers.set('cache-control', 'public, max-age=60');

  return new Response(upstream.body, { status: upstream.status, headers });
}

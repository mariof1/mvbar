import { cookies } from 'next/headers';

function apiUrlFor(path: string[]) {
  const base = process.env.API_INTERNAL_BASE ?? 'http://api:3000';
  // Join path segments and pass to API
  return `${base}/api/art/${path.join('/')}`;
}

export async function GET(_req: Request, ctx: { params: Promise<{ path?: string[] }> }) {
  const { path } = await ctx.params;
  const cookieStore = await cookies();
  const token = cookieStore.get('mvbar_token')?.value;
  if (!token) return new Response('Unauthorized', { status: 401 });

  // If no path segments or just one (track ID), use old endpoint
  if (!path || path.length === 0) {
    return new Response('Not found', { status: 404 });
  }

  // If single segment that looks like a track ID, proxy to track art
  if (path.length === 1 && /^\d+$/.test(path[0])) {
    const base = process.env.API_INTERNAL_BASE ?? 'http://api:3000';
    const upstream = await fetch(`${base}/api/library/tracks/${path[0]}/art`, {
      headers: { authorization: `Bearer ${token}` },
    });

    const headers = new Headers();
    for (const k of ['content-type', 'content-length', 'cache-control', 'etag']) {
      const v = upstream.headers.get(k);
      if (v) headers.set(k, v);
    }
    return new Response(upstream.body, { status: upstream.status, headers });
  }

  // Otherwise, proxy to direct art path endpoint
  const upstream = await fetch(apiUrlFor(path), {
    headers: { authorization: `Bearer ${token}` },
  });

  const headers = new Headers();
  for (const k of ['content-type', 'content-length', 'cache-control', 'etag']) {
    const v = upstream.headers.get(k);
    if (v) headers.set(k, v);
  }

  return new Response(upstream.body, { status: upstream.status, headers });
}

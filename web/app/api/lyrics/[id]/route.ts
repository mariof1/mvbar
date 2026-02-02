import { cookies } from 'next/headers';

function apiUrlFor(id: string) {
  const base = process.env.API_INTERNAL_BASE ?? 'http://api:3000';
  return `${base}/api/library/tracks/${encodeURIComponent(id)}/lyrics`;
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const cookieStore = await cookies();
  const token = cookieStore.get('mvbar_token')?.value;
  if (!token) return new Response('Unauthorized', { status: 401 });

  const upstream = await fetch(apiUrlFor(id), { headers: { authorization: `Bearer ${token}` } });
  if (upstream.status === 404) return new Response(null, { status: 204 });

  const headers = new Headers();
  const ct = upstream.headers.get('content-type');
  if (ct) headers.set('content-type', ct);
  return new Response(upstream.body, { status: upstream.status, headers });
}

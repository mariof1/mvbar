import { cookies } from 'next/headers';

function apiUrlFor(id: string) {
  const base = process.env.API_INTERNAL_BASE ?? 'http://api:3000';
  return `${base}/api/hls/${encodeURIComponent(id)}/index.m3u8`;
}

function rewriteManifest(text: string, id: string) {
  // The API returns segment URIs like "seg_00000.ts".
  // The browser needs to fetch them via our Next proxy (so auth cookie works).
  return text.replace(/^(seg_[0-9]+\.ts)$/gm, `/api/hls/${encodeURIComponent(id)}/seg/$1`);
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const cookieStore = await cookies();
  const token = cookieStore.get('mvbar_token')?.value;
  if (!token) return new Response('Unauthorized', { status: 401 });

  const upstream = await fetch(apiUrlFor(id), { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' });

  const ct = upstream.headers.get('content-type') ?? 'application/vnd.apple.mpegurl';
  const body = await upstream.text();

  return new Response(rewriteManifest(body, id), {
    status: upstream.status,
    headers: {
      'content-type': ct,
      'cache-control': 'no-store'
    }
  });
}

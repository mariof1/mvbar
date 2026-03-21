import { cookies } from 'next/headers';

function apiUrlFor(id: string, chapterId: string) {
  const base = process.env.API_INTERNAL_BASE ?? 'http://api:3000';
  return `${base}/api/audiobooks/${encodeURIComponent(id)}/chapters/${encodeURIComponent(chapterId)}/stream`;
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string; chapterId: string }> }) {
  const { id, chapterId } = await ctx.params;
  const cookieStore = await cookies();
  const token = cookieStore.get('mvbar_token')?.value;
  if (!token) return new Response('Unauthorized', { status: 401 });

  const range = req.headers.get('range') ?? undefined;

  const upstream = await fetch(apiUrlFor(id, chapterId), {
    headers: {
      authorization: `Bearer ${token}`,
      ...(range ? { range } : {}),
    },
  });

  const headers = new Headers();
  for (const k of ['content-type', 'content-length', 'accept-ranges', 'content-range']) {
    const v = upstream.headers.get(k);
    if (v) headers.set(k, v);
  }

  return new Response(upstream.body, { status: upstream.status, headers });
}

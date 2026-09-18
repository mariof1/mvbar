const ORIGIN = 'https://api.deezer.com';
const TIMEOUT_MS = 12000;
const MAX_BYTES = 2 * 1024 * 1024;

export type DeezerArtist = { id: string; name: string; cover: string | null; link: string | null; score: number };
export type DeezerAlbum = {
  id: string; title: string; artistId: string; artist: string; trackCount: number;
  releaseDate: string | null; recordType: 'Album' | 'EP' | 'Single' | 'Other';
  secondaryTypes: string[]; cover: string | null; explicit: boolean; baseTitle: string;
};
export type DeezerTrack = {
  id: string; title: string; artist: string; albumId: string; album: string; isrc: string | null;
  durationMs: number | null; discNumber: number; trackNumber: number;
};
export type LocalTrack = {
  id?: number | string | null; title: string | null; isrc?: string | null; duration_ms?: number | null;
  track_number?: number | null; disc_number?: number | null;
};

type RawArtist = { id?: number; name?: string; link?: string; picture_xl?: string; picture_big?: string; picture_medium?: string };
type RawAlbum = {
  id?: number; title?: string; cover_xl?: string; cover_big?: string; cover_medium?: string; nb_tracks?: number;
  release_date?: string; record_type?: string; explicit_lyrics?: boolean; artist?: { id?: number; name?: string };
};
type RawTrack = {
  id?: number; title?: string; duration?: number; isrc?: string; disk_number?: number; track_position?: number;
  artist?: { name?: string };
};

const EDITION_SUFFIXES = [
  'super deluxe edition','super deluxe version','collectors edition',"collector's edition",'anniversary edition',
  'international version','bonus tracks version','bonus track version','remastered edition','remastered version',
  'complete edition','complete version','expanded edition','expanded version','ultimate edition','ultimate version',
  'special edition','special version','limited edition','deluxe edition','deluxe version','premium edition',
  'premium version','extended edition','extended version','tour edition','super deluxe','remastered','remaster',
  'expanded','extended','explicit','premium','deluxe','clean version','clean',
] as const;
const EDITION_RE = /remaster|deluxe|edition|version|explicit|expanded|extended|bonus|anniversary|collector|clean|premium/i;

function esc(value: string) { return value.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&'); }
export function normalizeDeezerText(value: string) {
  return value.normalize('NFKD').toLocaleLowerCase('en').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
export function deezerBaseAlbumTitle(value: string) {
  let base = value.toLocaleLowerCase('en').trim().replace(/\s*[\(\[\{]([^\)\]\}]*)[\)\]\}]\s*/g,
    (match, inner: string) => EDITION_RE.test(inner) ? ' ' : match);
  for (const suffix of EDITION_SUFFIXES) base = base.replace(new RegExp('\\s*[-–—:]?\\s*' + esc(suffix) + '\\s*$', 'i'), '');
  return normalizeDeezerText(base);
}
export function isSpecialEdition(value: string) {
  const lower = value.toLocaleLowerCase('en');
  return EDITION_SUFFIXES.some(suffix => lower.includes(suffix));
}
function cover(raw: RawArtist | RawAlbum) {
  const items = 'picture_xl' in raw ? [raw.picture_xl, raw.picture_big, raw.picture_medium] : [raw.cover_xl, raw.cover_big, raw.cover_medium];
  for (const item of items) {
    if (!item) continue;
    try { const u = new URL(item); if (u.protocol === 'https:' && u.hostname === 'cdn-images.dzcdn.net') return u.toString(); } catch {}
  }
  return null;
}
async function json(url: URL): Promise<any> {
  const response = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'MVBar-MissingMusic/2.0' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error('Deezer catalog returned ' + response.status);
  const text = await response.text();
  if (text.length > MAX_BYTES) throw new Error('Deezer catalog response is too large');
  const value = JSON.parse(text);
  if (value?.error) throw new Error(value.error.message || 'Deezer catalog rejected the request');
  return value;
}
function secondary(raw: RawAlbum) {
  const out: string[] = [];
  const type = (raw.record_type || '').toLowerCase();
  if (type === 'compile' || type === 'compilation' || raw.artist?.id === 5080) out.push('Compilation');
  if (/\blive\b/i.test(raw.title || '')) out.push('Live');
  if (/\bremix(?:es)?\b/i.test(raw.title || '')) out.push('Remix');
  if (/\bsoundtrack\b|\boriginal motion picture\b/i.test(raw.title || '')) out.push('Soundtrack');
  return [...new Set(out)];
}
function recordType(raw: RawAlbum): DeezerAlbum['recordType'] {
  const type = (raw.record_type || '').toLowerCase();
  if (type === 'album' || type === 'compile' || type === 'compilation') return 'Album';
  if (type === 'ep') return 'EP';
  if (type === 'single') return 'Single';
  return 'Other';
}
function mapAlbum(raw: RawAlbum, artistId: string, artistName: string): DeezerAlbum | null {
  if (!Number.isSafeInteger(raw.id) || !raw.id || !raw.title) return null;
  return {
    id: String(raw.id), title: raw.title, artistId: raw.artist?.id ? String(raw.artist.id) : artistId,
    artist: raw.artist?.name?.trim() || artistName, trackCount: Number.isSafeInteger(raw.nb_tracks) ? Math.max(0, raw.nb_tracks || 0) : 0,
    releaseDate: /^\d{4}-\d{2}-\d{2}$/.test(raw.release_date || '') ? raw.release_date! : null,
    recordType: recordType(raw), secondaryTypes: secondary(raw), cover: cover(raw), explicit: raw.explicit_lyrics === true,
    baseTitle: deezerBaseAlbumTitle(raw.title),
  };
}

export async function searchDeezerArtists(query: string): Promise<DeezerArtist[]> {
  const wanted = normalizeDeezerText(query); if (!wanted) return [];
  const url = new URL('/search/artist', ORIGIN); url.searchParams.set('q', query); url.searchParams.set('limit', '25');
  const data = await json(url); const seen = new Set<string>();
  return (Array.isArray(data.data) ? data.data : []).filter((r: RawArtist) => r.id && r.name?.trim()).map((r: RawArtist) => {
    const name = r.name!.trim(), n = normalizeDeezerText(name), exact = n === wanted;
    return { id: String(r.id), name, cover: cover(r), link: typeof r.link === 'string' ? r.link : null, score: exact ? 100 : (n.includes(wanted) || wanted.includes(n)) ? 80 : 60 };
  }).filter((a: DeezerArtist) => { if (seen.has(a.id)) return false; seen.add(a.id); return true; })
    .sort((a: DeezerArtist,b: DeezerArtist) => b.score-a.score || a.name.localeCompare(b.name)).slice(0,12);
}

export async function deezerArtist(id: string): Promise<DeezerArtist> {
  if (!/^\d{1,16}$/.test(id)) throw new Error('Invalid Deezer artist id');
  const r: RawArtist = await json(new URL('/artist/' + id, ORIGIN));
  if (!r.id || String(r.id) !== id || !r.name?.trim()) throw new Error('Deezer artist is unavailable');
  return { id, name: r.name.trim(), cover: cover(r), link: typeof r.link === 'string' ? r.link : null, score: 100 };
}
function albumScore(a: DeezerAlbum, preferSpecial: boolean) {
  let score = 100 + Math.min(a.trackCount,30); const special = isSpecialEdition(a.title);
  if (preferSpecial && special) score += 25; if (!preferSpecial && special) score -= 15; if (a.explicit) score += 10; return score;
}
export function dedupeDeezerAlbums(albums: DeezerAlbum[], preferSpecial=false) {
  const groups = new Map<string,DeezerAlbum[]>();
  for (const a of albums) { const k = a.baseTitle || normalizeDeezerText(a.title); groups.set(k,[...(groups.get(k)||[]),a]); }
  return [...groups.values()].map(g => g.sort((a,b) => albumScore(b,preferSpecial)-albumScore(a,preferSpecial) || b.trackCount-a.trackCount)[0]);
}
export async function deezerAlbumsForArtist(id: string, options: {
  artistName?: string; maxAlbums?: number; releaseTypes?: Set<string>; excludedTypes?: Set<string>; preferSpecial?: boolean
} = {}) {
  if (!/^\d{1,16}$/.test(id)) throw new Error('Invalid Deezer artist id');
  const artist = options.artistName || (await deezerArtist(id)).name, max = Math.max(1,Math.min(options.maxAlbums || 500,1000));
  const albums: DeezerAlbum[] = [];
  for (let index=0; index<max; index+=100) {
    const url = new URL('/artist/' + id + '/albums', ORIGIN); url.searchParams.set('limit',String(Math.min(100,max-index))); url.searchParams.set('index',String(index));
    const page = await json(url), rows = Array.isArray(page.data) ? page.data : []; if (!rows.length) break;
    for (const raw of rows) { const a=mapAlbum(raw,id,artist); if (a) albums.push(a); }
    if (rows.length < 100 || albums.length >= Math.min(Number(page.total || max),max)) break;
  }
  const types = options.releaseTypes || new Set(['album','ep']), excluded = options.excludedTypes || new Set(['compilation','live','remix','soundtrack']);
  return dedupeDeezerAlbums(albums.filter(a=>types.has(a.recordType.toLowerCase())).filter(a=>!a.secondaryTypes.some(t=>excluded.has(t.toLowerCase()))),options.preferSpecial)
    .sort((a,b)=>(a.releaseDate||'9999').localeCompare(b.releaseDate||'9999') || a.title.localeCompare(b.title));
}
export async function deezerAlbum(id: string) {
  if (!/^\d{1,16}$/.test(id)) throw new Error('Invalid Deezer album id');
  const raw: RawAlbum = await json(new URL('/album/' + id, ORIGIN)); const a=mapAlbum(raw,String(raw.artist?.id||''),raw.artist?.name||'');
  if (!a || a.id!==id) throw new Error('Deezer album is unavailable'); return a;
}
export async function deezerAlbumTracks(id: string): Promise<{album:DeezerAlbum;tracks:DeezerTrack[]}> {
  const album=await deezerAlbum(id); if (!album.trackCount || album.trackCount>300) throw new Error('Deezer album track count is unavailable or too large');
  const tracks: DeezerTrack[]=[];
  for (let index=0; index<album.trackCount; index+=100) {
    const url=new URL('/album/'+id+'/tracks',ORIGIN); url.searchParams.set('limit','100'); url.searchParams.set('index',String(index));
    const page=await json(url), rows=Array.isArray(page.data)?page.data:[]; if (!rows.length) break;
    for (const r of rows as RawTrack[]) if (r.id && r.title) tracks.push({
      id:String(r.id),title:r.title,artist:r.artist?.name?.trim()||album.artist,albumId:id,album:album.title,
      isrc:typeof r.isrc==='string'&&r.isrc.trim()?r.isrc.trim().toUpperCase():null,
      durationMs:typeof r.duration==='number'&&r.duration>0?r.duration*1000:null,
      discNumber:Number.isSafeInteger(r.disk_number)&&r.disk_number!>0?r.disk_number!:1,
      trackNumber:Number.isSafeInteger(r.track_position)&&r.track_position!>0?r.track_position!:tracks.length+1,
    });
    if (rows.length<100 || tracks.length>=Number(page.total||album.trackCount)) break;
  }
  if (tracks.length!==album.trackCount) throw new Error('Deezer returned an incomplete album track list');
  return {album,tracks};
}

export function localAlbumTitleScore(remote:string,local:string) {
  const r=normalizeDeezerText(remote),l=normalizeDeezerText(local); if (!r||!l) return 0; if (r===l) return 100;
  return deezerBaseAlbumTitle(remote)===deezerBaseAlbumTitle(local)?85:0;
}
function isrc(v:string|null|undefined){return (v||'').toUpperCase().replace(/[^A-Z0-9]/g,'');}
function trackTitle(v:string) {
  return normalizeDeezerText(v.replace(/\s*[\(\[\{]([^\)\]\}]*)[\)\]\}]\s*$/g,(m,x:string)=>/remaster|version|explicit|clean/i.test(x)?'':m)
    .replace(/\s*[-–—:]\s*(?:\d{4}\s+)?remaster(?:ed)?(?:\s+version)?\s*$/i,''));
}
export function matchDeezerTrack(remote:DeezerTrack, local:LocalTrack[]) {
  const ri=isrc(remote.isrc); let best:{score:number;row:LocalTrack;reason:string}|null=null;
  for (const row of local) {
    const li=isrc(row.isrc); if (ri&&li&&ri===li) return {present:true,confidence:100,localTrackId:row.id??null,reason:'ISRC'};
    const exact=normalizeDeezerText(remote.title)===normalizeDeezerText(row.title||''), base=trackTitle(remote.title)===trackTitle(row.title||'');
    if (!exact&&!base) continue; let score=exact?70:62; const reasons=[exact?'title':'normalized title'];
    if (row.track_number&&row.track_number===remote.trackNumber){score+=12;reasons.push('track number');}
    if (row.disc_number&&row.disc_number===remote.discNumber){score+=4;reasons.push('disc');}
    if (row.duration_ms&&remote.durationMs){const d=Math.abs(row.duration_ms-remote.durationMs);if(d<=2000){score+=14;reasons.push('duration');}else if(d<=5000){score+=10;reasons.push('duration');}else if(d<=10000){score+=5;reasons.push('duration');}else if(d>20000)score-=20;}
    if(!best||score>best.score)best={score,row,reason:reasons.join(' + ')};
  }
  if(!best)return {present:false,confidence:0,localTrackId:null,reason:null};
  const confidence=Math.max(0,Math.min(99,best.score)); return {present:confidence>=65,confidence,localTrackId:best.row.id??null,reason:best.reason};
}

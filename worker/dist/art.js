import { createHash } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
export function pickBestPicture(pictures) {
    const pics = pictures ?? [];
    if (pics.length === 0)
        return null;
    // prefer largest
    let best = pics[0];
    for (const p of pics)
        if (p.data.length > best.data.length)
            best = p;
    return best;
}
export function mimeFromFormat(format) {
    const f = (format ?? '').toLowerCase();
    if (f.includes('png'))
        return 'image/png';
    if (f.includes('jpg') || f.includes('jpeg'))
        return 'image/jpeg';
    if (f.includes('webp'))
        return 'image/webp';
    return null;
}
export async function writeArt(artDir, data, mime) {
    const hash = createHash('sha1').update(data).digest('hex');
    const ext = mime === 'image/png' ? '.png' : mime === 'image/webp' ? '.webp' : '.jpg';
    const rel = `${hash.slice(0, 2)}/${hash}${ext}`;
    const abs = path.join(artDir, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, data);
    return { hash, relPath: rel, mime };
}

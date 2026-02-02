import { readTags } from './metadata.js';

function getArgValue(name: string): string | null {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return null;
  return process.argv[idx + 1] ?? null;
}

async function main() {
  const b64 = getArgValue('--base64');
  if (!b64) {
    console.error('Missing --base64 <path>');
    process.exit(2);
  }

  const filePath = Buffer.from(b64, 'base64').toString('utf8');
  const t = await readTags(filePath);

  // Serialize Uint8Array safely.
  const artDataBase64 = t.artData ? Buffer.from(t.artData).toString('base64') : null;
  const out: any = { ...t, artDataBase64 };
  delete out.artData;

  process.stdout.write(JSON.stringify(out));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

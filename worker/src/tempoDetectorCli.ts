import { detectTempoBpm, type OnsetMethod } from "./tempoDetector.js";

const args = process.argv.slice(2);
let onsetMethod: OnsetMethod | undefined;
let hopSeconds: number | undefined;
let file: string | undefined;

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--method") {
    const v = args[++i];
    if (v === "energy" || v === "spectral" || v === "hybrid") onsetMethod = v;
    else {
      console.error(`Invalid --method: ${v}`);
      process.exit(2);
    }
    continue;
  }
  if (a === "--hop") {
    const v = Number(args[++i]);
    if (!Number.isFinite(v) || v <= 0) {
      console.error(`Invalid --hop: ${args[i]}`);
      process.exit(2);
    }
    hopSeconds = v;
    continue;
  }
  if (!a?.startsWith("--") && !file) {
    file = a;
    continue;
  }
}

if (!file) {
  console.error("Usage: node dist/tempoDetectorCli.js [--method energy|spectral|hybrid] [--hop seconds] <audio-file>");
  process.exit(2);
}

try {
  const res = await detectTempoBpm(file, { onsetMethod, hopSeconds });
  console.log(JSON.stringify(res, null, 2));
} catch (e) {
  console.error(String(e));
  process.exit(1);
}

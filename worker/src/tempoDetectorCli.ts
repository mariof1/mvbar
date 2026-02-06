import { detectTempoBpm } from "./tempoDetector.js";

const file = process.argv[2];
if (!file) {
  console.error("Usage: node dist/tempoDetectorCli.js <audio-file>");
  process.exit(2);
}

try {
  const res = await detectTempoBpm(file);
  console.log(JSON.stringify(res, null, 2));
} catch (e) {
  console.error(String(e));
  process.exit(1);
}

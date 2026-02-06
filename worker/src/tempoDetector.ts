import { spawn } from "node:child_process";

export type TempoDetectionResult = {
  bpm: number;
  confidence: number; // 0..1 heuristic
  method: "autocorr";
  debug?: {
    sampleRate: number;
    windowSeconds: number;
    hopSeconds: number;
    candidates: Array<{ bpm: number; score: number }>;
  };
};

export type TempoDetectionOptions = {
  ffmpegPath?: string;
  sampleRate?: number; // Hz
  channels?: 1 | 2;
  /** Analyze multiple windows; start/end are fractions of full duration. */
  windows?: Array<{ startFrac: number; endFrac: number }>;
  /** Tempo range we normalize into by folding half/double tempo. */
  targetBpmMin?: number;
  targetBpmMax?: number;
  /** Candidate tempo range to search in. */
  searchBpmMin?: number;
  searchBpmMax?: number;
  /** Hop size for onset envelope. */
  hopSeconds?: number;
};

const DEFAULT_OPTS: Required<Pick<
  TempoDetectionOptions,
  | "sampleRate"
  | "channels"
  | "targetBpmMin"
  | "targetBpmMax"
  | "searchBpmMin"
  | "searchBpmMax"
  | "hopSeconds"
>> & { windows: Array<{ startFrac: number; endFrac: number }> } = {
  sampleRate: 11025,
  channels: 1,
  // folding range
  targetBpmMin: 70,
  targetBpmMax: 180,
  // search range (before folding)
  searchBpmMin: 50,
  searchBpmMax: 220,
  hopSeconds: 0.01,
  // multi-window consensus (middle 80% + thirds)
  windows: [
    { startFrac: 0.10, endFrac: 0.90 },
    { startFrac: 0.20, endFrac: 0.50 },
    { startFrac: 0.50, endFrac: 0.80 },
  ],
};

function normalizeBpm(bpm: number, min: number, max: number): number {
  let x = bpm;
  if (!Number.isFinite(x) || x <= 0) return x;
  while (x < min) x *= 2;
  while (x > max) x /= 2;
  return x;
}

function median(nums: number[]): number {
  const a = [...nums].sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid]! : (a[mid - 1]! + a[mid]!) / 2;
}

function mean(nums: number[]): number {
  return nums.reduce((s, v) => s + v, 0) / nums.length;
}

function stdev(nums: number[]): number {
  const m = mean(nums);
  const v = mean(nums.map((x) => (x - m) ** 2));
  return Math.sqrt(v);
}

function autocorr(scores: Float32Array): Float32Array {
  // naive O(n^2) is too slow; we compute limited lags only upstream.
  // This helper is unused; kept for clarity.
  return scores;
}

function computeOnsetEnvelope(pcm: Float32Array, sampleRate: number, hopSeconds: number): Float32Array {
  const hop = Math.max(1, Math.round(sampleRate * hopSeconds));
  const nHops = Math.floor(pcm.length / hop);
  const env = new Float32Array(nHops);

  // Simple energy-based novelty: positive flux of absolute amplitude.
  let prev = 0;
  for (let i = 0; i < nHops; i++) {
    const start = i * hop;
    const end = Math.min(pcm.length, start + hop);
    let acc = 0;
    for (let j = start; j < end; j++) acc += Math.abs(pcm[j]!);
    const cur = acc / (end - start);
    const diff = cur - prev;
    env[i] = diff > 0 ? diff : 0;
    prev = cur;
  }

  // Light smoothing (moving average 3)
  for (let i = 1; i < env.length - 1; i++) {
    env[i] = (env[i - 1]! + env[i]! + env[i + 1]!) / 3;
  }

  // Normalize
  let max = 0;
  for (let i = 0; i < env.length; i++) max = Math.max(max, env[i]!);
  if (max > 0) {
    for (let i = 0; i < env.length; i++) env[i] /= max;
  }
  return env;
}

function scoreBpmByAutocorr(env: Float32Array, hopSeconds: number, bpmMin: number, bpmMax: number) {
  const lagMin = Math.floor((60 / bpmMax) / hopSeconds);
  const lagMax = Math.ceil((60 / bpmMin) / hopSeconds);
  const lagLo = Math.max(1, lagMin);
  const lagHi = Math.min(env.length - 2, lagMax);

  const candidates: Array<{ bpm: number; score: number }> = [];

  // Precompute mean for zero-mean correlation
  let m = 0;
  for (let i = 0; i < env.length; i++) m += env[i]!;
  m /= env.length;

  // For each lag, compute correlation
  for (let lag = lagLo; lag <= lagHi; lag++) {
    let num = 0;
    let denA = 0;
    let denB = 0;
    for (let i = 0; i + lag < env.length; i++) {
      const a = env[i]! - m;
      const b = env[i + lag]! - m;
      num += a * b;
      denA += a * a;
      denB += b * b;
    }
    const denom = Math.sqrt(denA * denB);
    const corr = denom > 0 ? num / denom : 0;
    const bpm = 60 / (lag * hopSeconds);
    candidates.push({ bpm, score: corr });
  }

  candidates.sort((x, y) => y.score - x.score);
  return candidates;
}

function pickTempoFromCandidates(
  cands: Array<{ bpm: number; score: number }>,
  targetBpmMin: number,
  targetBpmMax: number,
): { bpm: number; score: number; runnerUpScore: number } {
  // Normalize into target range and bucket by rounded BPM.
  // Use MAX score per BPM (not sum) to avoid broad plateaus winning over sharp peaks.
  const scoreByBpm = new Map<number, number>();
  for (const c of cands.slice(0, 200)) {
    const b = Math.round(normalizeBpm(c.bpm, targetBpmMin, targetBpmMax));
    const s = Math.max(0, c.score);
    scoreByBpm.set(b, Math.max(scoreByBpm.get(b) ?? 0, s));
  }

  const getScoreNear = (bpm: number) => {
    let best = 0;
    for (let d = -2; d <= 2; d++) best = Math.max(best, scoreByBpm.get(bpm + d) ?? 0);
    return best;
  };

  // Base ranking: just pick the strongest bucket.
  const ranked = [...scoreByBpm.entries()]
    .map(([bpm, score]) => ({ bpm, score }))
    .sort((a, b) => b.score - a.score);

  const top = ranked[0] ?? { bpm: Math.round(normalizeBpm(cands[0]?.bpm ?? 0, targetBpmMin, targetBpmMax)), score: 0 };
  const runnerUpScore = ranked[1]?.score ?? 0;

  // Half/double-tempo fix-up:
  // If a slow tempo (<90 BPM) wins, but ~double has reasonably close evidence,
  // prefer the double tempo. Same for very fast tempos (>160) preferring half.
  const topScore = top.score || 1e-9;

  if (top.bpm < 90) {
    const dbl = top.bpm * 2;
    if (dbl >= targetBpmMin && dbl <= targetBpmMax) {
      const dblScore = getScoreNear(dbl);
      if (dblScore / topScore >= 0.55) {
        // promote double
        return { bpm: dbl, score: dblScore, runnerUpScore: top.score };
      }
    }
  }


  return { bpm: top.bpm, score: top.score, runnerUpScore };
}

async function decodeWindowToPCM(
  filename: string,
  startSeconds: number,
  durationSeconds: number,
  sampleRate: number,
  channels: 1 | 2,
  ffmpegPath = "ffmpeg",
): Promise<Float32Array> {
  // Decode to 32-bit float PCM for simplicity.
  const args = [
    "-v",
    "error",
    "-ss",
    String(startSeconds),
    "-t",
    String(durationSeconds),
    "-i",
    filename,
    "-vn",
    "-ac",
    String(channels),
    "-ar",
    String(sampleRate),
    "-f",
    "f32le",
    "pipe:1",
  ];

  const child = spawn(ffmpegPath, args, { stdio: ["ignore", "pipe", "pipe"] });

  const chunks: Buffer[] = [];
  const errChunks: Buffer[] = [];

  child.stdout.on("data", (d) => chunks.push(d as Buffer));
  child.stderr.on("data", (d) => errChunks.push(d as Buffer));

  const code: number = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });

  if (code !== 0) {
    const msg = Buffer.concat(errChunks).toString("utf8").trim();
    throw new Error(`ffmpeg decode failed (code ${code}): ${msg || "unknown"}`);
  }

  const buf = Buffer.concat(chunks);
  const floats = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));

  if (channels === 1) return new Float32Array(floats);

  // Downmix stereo -> mono (average)
  const mono = new Float32Array(Math.floor(floats.length / 2));
  for (let i = 0, o = 0; i + 1 < floats.length; i += 2, o++) {
    mono[o] = (floats[i]! + floats[i + 1]!) / 2;
  }
  return mono;
}

async function getDurationSeconds(filename: string, ffprobePath = "ffprobe"): Promise<number> {
  const args = [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    filename,
  ];
  const child = spawn(ffprobePath, args, { stdio: ["ignore", "pipe", "pipe"] });
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  child.stdout.on("data", (d) => out.push(d as Buffer));
  child.stderr.on("data", (d) => err.push(d as Buffer));
  const code: number = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  if (code !== 0) {
    const msg = Buffer.concat(err).toString("utf8").trim();
    throw new Error(`ffprobe failed (code ${code}): ${msg || "unknown"}`);
  }
  const s = Buffer.concat(out).toString("utf8").trim();
  const d = Number(s);
  if (!Number.isFinite(d) || d <= 0) throw new Error(`invalid duration: ${s}`);
  return d;
}

export async function detectTempoBpm(filename: string, opts: TempoDetectionOptions = {}): Promise<TempoDetectionResult> {
  const sampleRate = opts.sampleRate ?? DEFAULT_OPTS.sampleRate;
  const channels = opts.channels ?? DEFAULT_OPTS.channels;
  const windows = opts.windows ?? DEFAULT_OPTS.windows;
  const targetBpmMin = opts.targetBpmMin ?? DEFAULT_OPTS.targetBpmMin;
  const targetBpmMax = opts.targetBpmMax ?? DEFAULT_OPTS.targetBpmMax;
  const searchBpmMin = opts.searchBpmMin ?? DEFAULT_OPTS.searchBpmMin;
  const searchBpmMax = opts.searchBpmMax ?? DEFAULT_OPTS.searchBpmMax;
  const hopSeconds = opts.hopSeconds ?? DEFAULT_OPTS.hopSeconds;
  const ffmpegPath = opts.ffmpegPath ?? "ffmpeg";

  const duration = await getDurationSeconds(filename);

  const windowBpms: number[] = [];
  const windowChoiceStrength: number[] = [];
  const allCandidates: Map<number, number> = new Map();

  for (const w of windows) {
    const start = Math.max(0, duration * w.startFrac);
    const end = Math.min(duration, duration * w.endFrac);
    const winDur = Math.max(10, end - start);

    const pcm = await decodeWindowToPCM(filename, start, winDur, sampleRate, channels, ffmpegPath);
    const env = computeOnsetEnvelope(pcm, sampleRate, hopSeconds);
    const cands = scoreBpmByAutocorr(env, hopSeconds, searchBpmMin, searchBpmMax);

    if (!cands[0]) continue;

    const pick = pickTempoFromCandidates(cands, targetBpmMin, targetBpmMax);
    windowBpms.push(pick.bpm);

    // Strength is separation vs runner-up (bounded 0..1-ish)
    const sep = pick.score > 0 ? (pick.score - pick.runnerUpScore) / pick.score : 0;
    windowChoiceStrength.push(Math.max(0, Math.min(1, sep)));

    // Vote: bucket by rounded bpm
    for (const c of cands.slice(0, 5)) {
      const b = Math.round(normalizeBpm(c.bpm, targetBpmMin, targetBpmMax));
      allCandidates.set(b, (allCandidates.get(b) ?? 0) + c.score);
    }
  }

  if (windowBpms.length === 0) throw new Error("tempo detection produced no windows");

  const bpmMed = median(windowBpms);
  const bpmStd = stdev(windowBpms);
  const strength = windowChoiceStrength.length ? mean(windowChoiceStrength) : 0;

  // Candidate list
  const candidates = [...allCandidates.entries()]
    .map(([bpm, score]) => ({ bpm, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);

  // Confidence heuristic:
  // - window consistency (std <= 2 => high; std >= 10 => low)
  // - candidate separation strength (helps with half/double ambiguity)
  const confStd = Math.max(0, Math.min(1, 1 - (bpmStd - 2) / 8));
  const conf = Math.max(0, Math.min(1, confStd * (0.65 + 0.35 * strength)));

  return {
    bpm: Math.round(bpmMed),
    confidence: conf,
    method: "autocorr",
    debug: {
      sampleRate,
      windowSeconds: duration,
      hopSeconds,
      candidates,
    },
  };
}

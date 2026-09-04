import type { RecommendationContext } from './recommendationTelemetry.js';

export type PlaybackSignalBody = {
  currentMs?: unknown;
  durationMs?: unknown;
  listenedMs?: unknown;
  completionPct?: unknown;
  slateId?: unknown;
  bucketKey?: unknown;
};

export type NormalizedPlaybackSignal = {
  listenedMs: number;
  completionPct: number | null;
  context: RecommendationContext;
};

function finiteNonNegative(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function shortString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, 160) : null;
}

export function normalizeCompletionRatio(value: unknown): number | null {
  const number = finiteNonNegative(value);
  if (number == null) return null;
  return Math.max(0, Math.min(1, number > 1 ? number / 100 : number));
}

export function normalizePlaybackSignal(
  body: PlaybackSignalBody | null | undefined,
  libraryDurationMs: number | null,
  fallbackCompletionPct: number | null,
): NormalizedPlaybackSignal {
  const suppliedDuration = finiteNonNegative(body?.durationMs);
  const durationMs = libraryDurationMs && libraryDurationMs > 0
    ? libraryDurationMs
    : suppliedDuration && suppliedDuration > 0
      ? suppliedDuration
      : null;
  const currentMs = finiteNonNegative(body?.currentMs);
  const explicitPct = normalizeCompletionRatio(body?.completionPct);
  const hasCompletionEvidence = explicitPct != null
    || (durationMs != null && currentMs != null)
    || fallbackCompletionPct != null;
  const completionPct = Math.max(0, Math.min(1,
    explicitPct
      ?? (durationMs && currentMs != null ? currentMs / durationMs : fallbackCompletionPct ?? 0),
  ));
  const suppliedListenedMs = finiteNonNegative(body?.listenedMs);
  const inferredListenedMs = suppliedListenedMs
    ?? currentMs
    ?? (durationMs ? durationMs * completionPct : 0);
  const upperBound = durationMs ?? 24 * 60 * 60_000;

  return {
    listenedMs: Math.trunc(Math.max(0, Math.min(inferredListenedMs, upperBound))),
    completionPct: hasCompletionEvidence ? completionPct : null,
    context: {
      slateId: shortString(body?.slateId),
      bucketKey: shortString(body?.bucketKey),
    },
  };
}

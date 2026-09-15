const unitMs: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

const maxTimerIntervalMs = 2_147_483_647;

export function parseRescanInterval(
  duration: string | undefined,
  legacyMilliseconds: string | undefined,
): number {
  const setting = duration?.trim() ? 'RESCAN_INTERVAL' : 'RESCAN_INTERVAL_MS';
  const value = duration?.trim() || legacyMilliseconds?.trim() || '5m';
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/i.exec(value);
  const intervalMs = match ? Number(match[1]) * unitMs[(match[2] ?? 'ms').toLowerCase()] : NaN;

  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1_000 || intervalMs > maxTimerIntervalMs) {
    throw new Error(
      `Invalid ${setting} value "${value}". Use a positive duration such as 60s, 1m, 1h, or 2d ` +
      `(at least 1s and no more than ${maxTimerIntervalMs}ms). Bare numbers are milliseconds.`
    );
  }

  return intervalMs;
}

export function formatRescanInterval(intervalMs: number): string {
  for (const unit of ['d', 'h', 'm', 's']) {
    if (intervalMs % unitMs[unit] === 0) return `${intervalMs / unitMs[unit]}${unit}`;
  }
  return `${intervalMs}ms`;
}

export function validateSmartPlaylistFilters(raw: any): string | null {
  raw = raw || {};
  const optional = (value: any) => value == null || String(value).trim() === '';
  const fields: [any, string, number, number][] = [
    [raw.maxResults, 'Max Tracks', 1, 2000],
    [raw.duration?.min, 'Min Duration', 0, 86400],
    [raw.duration?.max, 'Max Duration', 0, 86400],
    [raw.bpm?.min, 'Min BPM', 0, 400],
    [raw.bpm?.max, 'Max BPM', 0, 400],
  ];
  for (const [value, label, min, max] of fields) {
    if (!optional(value) && (typeof value === 'boolean' || !['number', 'string'].includes(typeof value) || !Number.isInteger(Number(value)) || Number(value) < min || Number(value) > max)) {
      return `${label} must be a whole number from ${min} to ${max}.`;
    }
  }
  for (const [range, label] of [[raw.duration, 'Duration'], [raw.bpm, 'BPM']] as const) {
    if (range && !optional(range.min) && !optional(range.max) && Number(range.min) > Number(range.max)) return `${label} minimum must not exceed maximum.`;
  }
  const dates = raw.dateAdded || raw.date_added || {};
  const from = dates.from ?? dates.min ?? dates.start;
  const to = dates.to ?? dates.max ?? dates.end;
  for (const value of [from, to]) {
    if (!optional(value)) {
      const date = new Date(String(value));
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value)) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) return 'Date Added must be a valid date.';
    }
  }
  if (!optional(from) && !optional(to) && from > to) return 'Date Added From must not be after Date Added To.';
  return null;
}

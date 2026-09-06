import { artistNamesFromValue } from './artistDisplay.js';

/** Canonical, comparison-safe representation for recommendation features. */
export function normalizeRecommendationFeature(value: unknown): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ł/g, 'l')
    .replace(/Ł/g, 'L')
    .replace(/ø/g, 'o')
    .replace(/Ø/g, 'O')
    .replace(/ß/g, 'ss')
    .replace(/æ/g, 'ae')
    .replace(/œ/g, 'oe')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase();
}

export function recommendationArtistKeys(value: unknown): string[] {
  return artistNamesFromValue(value)
    .map(normalizeRecommendationFeature)
    .filter(Boolean);
}

export function splitRecommendationFeatures(value: unknown): string[] {
  if (typeof value !== 'string' || !value) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const part of value.split(/[;,/|]/)) {
    const normalized = normalizeRecommendationFeature(part);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

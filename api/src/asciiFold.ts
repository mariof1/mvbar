/**
 * Convert a string to ASCII-safe form for searching.
 * Allows searching "Sokol" to find "Sokół", "Zabson" to find "Żabson", etc.
 */
export function asciiFold(str: string): string {
  if (!str) return '';
  
  // First, normalize to NFC for consistent input
  let s = str.normalize('NFC');
  
  // Handle specific characters that don't decompose well
  const specificMappings: [RegExp, string][] = [
    // German
    [/ß/g, 'ss'],
    [/Ä/g, 'A'], [/ä/g, 'a'],
    [/Ö/g, 'O'], [/ö/g, 'o'],
    [/Ü/g, 'U'], [/ü/g, 'u'],
    // Polish
    [/Ł/g, 'L'], [/ł/g, 'l'],
    [/Ą/g, 'A'], [/ą/g, 'a'],
    [/Ć/g, 'C'], [/ć/g, 'c'],
    [/Ę/g, 'E'], [/ę/g, 'e'],
    [/Ń/g, 'N'], [/ń/g, 'n'],
    [/Ó/g, 'O'], [/ó/g, 'o'],
    [/Ś/g, 'S'], [/ś/g, 's'],
    [/Ź/g, 'Z'], [/ź/g, 'z'],
    [/Ż/g, 'Z'], [/ż/g, 'z'],
    // Nordic
    [/Å/g, 'A'], [/å/g, 'a'],
    [/Ø/g, 'O'], [/ø/g, 'o'],
    [/Æ/g, 'AE'], [/æ/g, 'ae'],
    // Czech/Slovak
    [/Ř/g, 'R'], [/ř/g, 'r'],
    [/Ď/g, 'D'], [/ď/g, 'd'],
    [/Ť/g, 'T'], [/ť/g, 't'],
    [/Ň/g, 'N'], [/ň/g, 'n'],
    [/Ů/g, 'U'], [/ů/g, 'u'],
    // Romanian
    [/Ș/g, 'S'], [/ș/g, 's'],
    [/Ț/g, 'T'], [/ț/g, 't'],
    [/Ă/g, 'A'], [/ă/g, 'a'],
    [/Â/g, 'A'], [/â/g, 'a'],
    [/Î/g, 'I'], [/î/g, 'i'],
    // Turkish
    [/İ/g, 'I'], [/ı/g, 'i'],
    [/Ğ/g, 'G'], [/ğ/g, 'g'],
    [/Ş/g, 'S'], [/ş/g, 's'],
    // Icelandic
    [/Þ/g, 'Th'], [/þ/g, 'th'],
    [/Ð/g, 'D'], [/ð/g, 'd'],
  ];
  
  for (const [pattern, replacement] of specificMappings) {
    s = s.replace(pattern, replacement);
  }
  
  // Use NFKD decomposition to handle remaining accented characters
  // This separates base characters from combining diacritical marks
  s = s.normalize('NFKD');
  
  // Remove combining diacritical marks (Unicode category M)
  s = s.replace(/[\u0300-\u036f]/g, '');
  
  // Remove any remaining non-ASCII characters (except basic punctuation/spaces)
  // Keep: a-z, A-Z, 0-9, space, common punctuation
  s = s.replace(/[^\x20-\x7E]/g, '');
  
  return s.trim().toLowerCase();
}

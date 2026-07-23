/**
 * Computes the Levenshtein edit distance between two strings.
 */
export function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previousRow = Array.from({ length: b.length + 1 }, (_, i) => i);

  for (let i = 0; i < a.length; i++) {
    const currentRow = [i + 1];
    for (let j = 0; j < b.length; j++) {
      const insertCost = currentRow[j] + 1;
      const deleteCost = previousRow[j + 1] + 1;
      const substituteCost = previousRow[j] + (a[i] === b[j] ? 0 : 1);
      currentRow.push(Math.min(insertCost, deleteCost, substituteCost));
    }
    previousRow = currentRow;
  }

  return previousRow[b.length];
}

/**
 * Fuzzy similarity between two strings, normalized to [0, 1] where 1 is an
 * exact match (case-insensitive, whitespace-trimmed) and 0 is completely
 * dissimilar. Based on Levenshtein distance relative to the longer string's length.
 */
export function stringSimilarity(a: string, b: string): number {
  const normalizedA = a.trim().toLowerCase();
  const normalizedB = b.trim().toLowerCase();

  if (normalizedA.length === 0 && normalizedB.length === 0) return 1;
  if (normalizedA.length === 0 || normalizedB.length === 0) return 0;

  const maxLength = Math.max(normalizedA.length, normalizedB.length);
  const distance = levenshteinDistance(normalizedA, normalizedB);

  return 1 - distance / maxLength;
}

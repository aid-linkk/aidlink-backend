import { levenshteinDistance, stringSimilarity } from './similarity';

describe('levenshteinDistance', () => {
  it('is 0 for identical strings', () => {
    expect(levenshteinDistance('hello', 'hello')).toBe(0);
  });

  it('equals the length of the other string when one is empty', () => {
    expect(levenshteinDistance('', 'hello')).toBe(5);
    expect(levenshteinDistance('hello', '')).toBe(5);
  });

  it('counts a single substitution', () => {
    expect(levenshteinDistance('cat', 'bat')).toBe(1);
  });

  it('counts insertions and deletions', () => {
    expect(levenshteinDistance('cat', 'cats')).toBe(1);
    expect(levenshteinDistance('cats', 'cat')).toBe(1);
  });
});

describe('stringSimilarity', () => {
  it('is 1 for identical strings', () => {
    expect(stringSimilarity('Emergency Relief Fund', 'Emergency Relief Fund')).toBe(1);
  });

  it('is 1 for strings differing only in case/whitespace', () => {
    expect(stringSimilarity('  Emergency Relief Fund  ', 'emergency relief fund')).toBe(1);
  });

  it('is close to 1 for near-duplicate titles', () => {
    expect(stringSimilarity('Emergency Relief Fund', 'Emergency Relief Fund!')).toBeGreaterThan(0.9);
  });

  it('is low for unrelated strings', () => {
    expect(stringSimilarity('Emergency Relief Fund', 'Annual Charity Gala')).toBeLessThan(0.3);
  });

  it('is 0 when one string is empty and the other is not', () => {
    expect(stringSimilarity('', 'Emergency Relief Fund')).toBe(0);
  });

  it('is 1 when both strings are empty', () => {
    expect(stringSimilarity('', '')).toBe(1);
  });
});

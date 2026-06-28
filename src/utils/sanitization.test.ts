import { escapeHtml, sanitizeString, sanitizeObject } from './sanitization';

describe('sanitization utilities', () => {
  describe('escapeHtml', () => {
    it('escapes HTML special characters', () => {
      expect(escapeHtml('<script>alert("xss")</script>')).toBe('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
    });

    it('preserves normal text', () => {
      expect(escapeHtml('Hello world')).toBe('Hello world');
    });
  });

  describe('sanitizeString', () => {
    it('returns escaped string', () => {
      expect(sanitizeString('<b>bold</b>')).toBe('&lt;b&gt;bold&lt;/b&gt;');
    });
  });

  describe('sanitizeObject', () => {
    it('sanitizes nested strings in objects', () => {
      const input = {
        title: '<img src=x onerror=alert(1)>',
        meta: { description: 'Hello <script>alert(1)</script>' },
      };

      expect(sanitizeObject(input)).toEqual({
        title: '&lt;img src=x onerror=alert(1)&gt;',
        meta: { description: 'Hello &lt;script&gt;alert(1)&lt;/script&gt;' },
      });
    });

    it('preserves dates and non-string values', () => {
      const input = { date: new Date('2026-06-28T00:00:00.000Z'), count: 5 };
      expect(sanitizeObject(input)).toEqual(input);
    });
  });
});

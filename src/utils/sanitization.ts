export const escapeHtml = (value: string): string =>
  value.replace(/[&<>"]/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return char;
    }
  });

export const sanitizeString = (value: string): string => escapeHtml(value);

export const sanitizeObject = (value: unknown): unknown => {
  if (typeof value === 'string') {
    return escapeHtml(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeObject(item));
  }

  if (value instanceof Date) {
    return value;
  }

  if (value && typeof value === 'object') {
    return Object.entries(value).reduce((acc, [key, item]) => {
      acc[key] = sanitizeObject(item);
      return acc;
    }, {} as Record<string, unknown>);
  }

  return value;
};

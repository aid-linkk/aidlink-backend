/**
 * Escapes a single CSV field per RFC 4180: wraps in quotes and doubles any
 * embedded quotes whenever the value contains a comma, quote, or newline.
 */
const escapeCsvField = (value: unknown): string => {
  if (value === null || value === undefined) {
    return '';
  }

  const stringValue = value instanceof Date ? value.toISOString() : String(value);

  if (/[",\n\r]/.test(stringValue)) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }

  return stringValue;
};

/**
 * Serializes an array of flat row objects into a CSV string using the given
 * column order. Missing keys on a row are rendered as empty fields.
 */
export const toCsv = (columns: string[], rows: Array<Record<string, unknown>>): string => {
  const header = columns.map(escapeCsvField).join(',');
  const lines = rows.map((row) => columns.map((col) => escapeCsvField(row[col])).join(','));
  return [header, ...lines].join('\r\n');
};

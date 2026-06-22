import Handlebars from 'handlebars';

/**
 * Register all Handlebars helpers used across email templates.
 * Called once at app startup by EmailTemplateService.initialize().
 */
export function registerHelpers(): void {
  // ── Formatting ────────────────────────────────────────────────

  /** Format a number as currency (e.g. "1,234.56 XLM") */
  Handlebars.registerHelper('formatCurrency', (amount: number, currency: string) => {
    if (amount == null) return '';
    const formatted = Number(amount).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    return `${formatted} ${currency || ''}`.trim();
  });

  /** Format an ISO date string to a readable format */
  Handlebars.registerHelper('formatDate', (dateStr: string) => {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  });

  /** Format an ISO date string to include time */
  Handlebars.registerHelper('formatDateTime', (dateStr: string) => {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'short',
    });
  });

  // ── Equality / Comparison ────────────────────────────────────

  /** Strict equality check: {{#ifEq a b}}...{{/ifEq}} */
  Handlebars.registerHelper('ifEq', function (this: unknown, a: unknown, b: unknown, opts: Handlebars.HelperOptions) {
    if (a === b) return opts.fn(this);
    return opts.inverse(this);
  });

  /** Check if a value is included in an array: {{#ifIncludes arr val}}...{{/ifIncludes}} */
  Handlebars.registerHelper('ifIncludes', function (this: unknown, arr: unknown[], val: unknown, opts: Handlebars.HelperOptions) {
    if (Array.isArray(arr) && arr.includes(val)) return opts.fn(this);
    return opts.inverse(this);
  });

  // ── Truthiness ───────────────────────────────────────────────

  /** Render block only if value is truthy: {{#ifPresent value}}...{{/ifPresent}} */
  Handlebars.registerHelper('ifPresent', function (this: unknown, value: unknown, opts: Handlebars.HelperOptions) {
    if (value != null && value !== '' && value !== false) return opts.fn(this);
    return opts.inverse(this);
  });

  /** Render block only if value is falsy/empty: {{#ifMissing value}}...{{/ifMissing}} */
  Handlebars.registerHelper('ifMissing', function (this: unknown, value: unknown, opts: Handlebars.HelperOptions) {
    if (value == null || value === '' || value === false) return opts.fn(this);
    return opts.inverse(this);
  });

  // ── Default value ────────────────────────────────────────────

  /** Provide a fallback: {{defaultName name "there"}} */
  Handlebars.registerHelper('defaultName', (name: string, fallback: string) => {
    return name || fallback || 'there';
  });
}

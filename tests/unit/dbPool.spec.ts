import {
  buildPooledDatabaseUrl,
  effectiveConnectionLimit,
  redactDatabaseUrl,
  resolveConnectionLimit,
  MIN_CONNECTION_LIMIT,
  MAX_CONNECTION_LIMIT,
  PoolSettings,
} from '../../src/config/dbPool';

const settings: PoolSettings = {
  connectionLimit: 17,
  poolTimeoutSeconds: 10,
  connectTimeoutSeconds: 8,
  socketTimeoutSeconds: 0,
};

describe('resolveConnectionLimit', () => {
  const base = { cpuCount: 4, instances: 1, serverConnectionBudget: 80 };

  it('derives the limit from CPU count for an IO-bound workload', () => {
    // 4 CPUs -> 4 * 2 + 1 + 4 = 13
    expect(resolveConnectionLimit(base)).toBe(13);
  });

  it('divides the server budget across replicas', () => {
    expect(resolveConnectionLimit({ ...base, cpuCount: 16, instances: 4 })).toBe(20);
  });

  it('honours an explicit override', () => {
    expect(resolveConnectionLimit({ ...base, override: 42 })).toBe(42);
  });

  it('clamps an oversized override to the guardrail', () => {
    expect(resolveConnectionLimit({ ...base, override: 5000 })).toBe(MAX_CONNECTION_LIMIT);
  });

  it('ignores a non-positive override and falls back to the heuristic', () => {
    expect(resolveConnectionLimit({ ...base, override: 0 })).toBe(13);
    expect(resolveConnectionLimit({ ...base, override: NaN })).toBe(13);
  });

  it('never drops below the floor when the budget is tiny', () => {
    expect(
      resolveConnectionLimit({ cpuCount: 1, instances: 20, serverConnectionBudget: 20 })
    ).toBe(MIN_CONNECTION_LIMIT);
  });

  it('treats zero or missing CPU/instance counts as one', () => {
    expect(resolveConnectionLimit({ ...base, cpuCount: 0, instances: 0 })).toBe(5);
  });
});

describe('buildPooledDatabaseUrl', () => {
  it('appends pool parameters to a plain connection URL', () => {
    const url = new URL(buildPooledDatabaseUrl('postgresql://u:p@host:5432/db', settings));

    expect(url.searchParams.get('connection_limit')).toBe('17');
    expect(url.searchParams.get('pool_timeout')).toBe('10');
    expect(url.searchParams.get('connect_timeout')).toBe('8');
  });

  it('preserves existing query parameters', () => {
    const url = new URL(
      buildPooledDatabaseUrl('postgresql://u:p@host:5432/db?schema=public', settings)
    );

    expect(url.searchParams.get('schema')).toBe('public');
    expect(url.searchParams.get('connection_limit')).toBe('17');
  });

  it('does not override operator-set parameters (e.g. behind PgBouncer)', () => {
    const url = new URL(
      buildPooledDatabaseUrl('postgresql://u:p@host:5432/db?connection_limit=1', settings)
    );

    expect(url.searchParams.get('connection_limit')).toBe('1');
  });

  it('omits socket_timeout when disabled and includes it when set', () => {
    const disabled = new URL(buildPooledDatabaseUrl('postgresql://u:p@h/db', settings));
    expect(disabled.searchParams.has('socket_timeout')).toBe(false);

    const enabled = new URL(
      buildPooledDatabaseUrl('postgresql://u:p@h/db', { ...settings, socketTimeoutSeconds: 30 })
    );
    expect(enabled.searchParams.get('socket_timeout')).toBe('30');
  });

  it('returns non-PostgreSQL and unparseable URLs untouched', () => {
    expect(buildPooledDatabaseUrl('mysql://u:p@h/db', settings)).toBe('mysql://u:p@h/db');
    expect(buildPooledDatabaseUrl('not-a-url', settings)).toBe('not-a-url');
    expect(buildPooledDatabaseUrl('', settings)).toBe('');
  });
});

describe('effectiveConnectionLimit', () => {
  it('reads the limit in force from the URL', () => {
    expect(effectiveConnectionLimit('postgresql://u:p@h/db?connection_limit=3', 17)).toBe(3);
  });

  it('falls back when the parameter is absent, empty or invalid', () => {
    expect(effectiveConnectionLimit('postgresql://u:p@h/db', 17)).toBe(17);
    expect(effectiveConnectionLimit('postgresql://u:p@h/db?connection_limit=', 17)).toBe(17);
    expect(effectiveConnectionLimit('postgresql://u:p@h/db?connection_limit=0', 17)).toBe(17);
    expect(effectiveConnectionLimit('not-a-url', 17)).toBe(17);
  });
});

describe('redactDatabaseUrl', () => {
  it('masks the password', () => {
    expect(redactDatabaseUrl('postgresql://user:secret@host:5432/db')).toContain(':***@');
    expect(redactDatabaseUrl('postgresql://user:secret@host:5432/db')).not.toContain('secret');
  });

  it('handles unparseable input', () => {
    expect(redactDatabaseUrl('nonsense')).toBe('<unparseable database url>');
  });
});

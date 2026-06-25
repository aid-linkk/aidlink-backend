/**
 * Validates required environment variables on startup.
 * Fails fast with clear error messages when critical config is missing.
 */

interface EnvVar {
  name: string;
  description: string;
  required: boolean;
}

const REQUIRED_VARS: EnvVar[] = [
  { name: 'DATABASE_URL', description: 'PostgreSQL database connection string', required: true },
  { name: 'JWT_SECRET', description: 'Secret key for JWT token signing', required: true },
  { name: 'WALLET_AUTH_SECRET', description: 'Secret for wallet-based authentication', required: true },
  { name: 'SMTP_HOST', description: 'SMTP server hostname for email delivery', required: true },
  { name: 'SMTP_USER', description: 'SMTP username', required: true },
  { name: 'SMTP_PASSWORD', description: 'SMTP password', required: true },
  { name: 'SOROBAN_NETWORK_URL', description: 'Soroban RPC endpoint URL', required: true },
  { name: 'SOROBAN_NETWORK_PASSPHRASE', description: 'Stellar network passphrase', required: true },
];

const OPTIONAL_VARS: EnvVar[] = [
  { name: 'REDIS_HOST', description: 'Redis hostname (default: localhost)', required: false },
  { name: 'REDIS_PASSWORD', description: 'Redis password (optional)', required: false },
  { name: 'CONTRACT_ADDRESS', description: 'Soroban contract address (optional)', required: false },
  { name: 'CORS_ORIGIN', description: 'Allowed CORS origin (default: http://localhost:3000)', required: false },
  { name: 'LOG_LEVEL', description: 'Logging level (default: info)', required: false },
];

export function validateEnv(): void {
  const missing: string[] = [];
  const empty: string[] = [];

  for (const envVar of REQUIRED_VARS) {
    const value = process.env[envVar.name];
    if (value === undefined) {
      missing.push(`  - ${envVar.name}: ${envVar.description}`);
    } else if (value.trim() === '') {
      empty.push(`  - ${envVar.name}: ${envVar.description}`);
    }
  }

  if (missing.length > 0 || empty.length > 0) {
    const lines: string[] = ['\n❌ Missing required environment variables:\n'];

    if (missing.length > 0) {
      lines.push('Not set:');
      lines.push(...missing);
      lines.push('');
    }

    if (empty.length > 0) {
      lines.push('Set but empty:');
      lines.push(...empty);
      lines.push('');
    }

    lines.push('Fix: Set these variables in your .env file or deployment config.');
    lines.push('Example .env entry:');
    lines.push('  DATABASE_URL=postgresql://user:***@localhost:5432/aidlink\n');

    // eslint-disable-next-line no-console
    console.error(lines.join('\n'));
    process.exit(1);
  }

  // Warn about optional vars that aren't set
  const missingOptional = OPTIONAL_VARS.filter((v) => !process.env[v.name]);
  if (missingOptional.length > 0) {
    const warnings = missingOptional.map((v) => `  - ${v.name}: ${v.description}`).join('\n');
    // eslint-disable-next-line no-console
    console.warn(`\n⚠️  Optional environment variables not set (using defaults):\n${warnings}\n`);
  }
}

export default validateEnv;

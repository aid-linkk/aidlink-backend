import { config } from './index';
import logger from './logger';

export const RECEIPT_TEMPLATE_VERSION = 'v1';

export interface RegionalTaxRequirement {
  taxDeductible: boolean;
  requiredTaxId: string;
  language: string;
  statement: string;
}

export const DEFAULT_REGIONAL_REQUIREMENTS: Record<string, RegionalTaxRequirement> = {
  US: {
    taxDeductible: true,
    requiredTaxId: 'EIN',
    language: 'en-US',
    statement:
      'This donation is tax-deductible to the extent allowed by law. No goods or services were provided in exchange for this contribution.',
  },
  UK: {
    taxDeductible: true,
    requiredTaxId: 'CHN',
    language: 'en-GB',
    statement: 'This is a record of your donation. Gift Aid may be available on eligible donations.',
  },
  CA: {
    taxDeductible: true,
    requiredTaxId: 'BN',
    language: 'en-CA',
    statement: 'Official receipt for income tax purposes. This donation may be eligible for a tax credit.',
  },
  EU: {
    taxDeductible: true,
    requiredTaxId: 'VAT',
    language: 'en-IE',
    statement: 'This is a record of your donation. Tax deductibility depends on your country of residence.',
  },
  AU: {
    taxDeductible: true,
    requiredTaxId: 'ABN',
    language: 'en-AU',
    statement: 'This receipt is for a gift of $2 or more and may be tax-deductible.',
  },
  DEFAULT: {
    taxDeductible: false,
    requiredTaxId: '',
    language: 'en-US',
    statement:
      'This is a record of your donation. Tax deductibility is not guaranteed and depends on your local jurisdiction.',
  },
};

let cachedRequirements: Record<string, RegionalTaxRequirement> | null = null;

export function loadRegionalRequirements(): Record<string, RegionalTaxRequirement> {
  if (cachedRequirements) {
    return cachedRequirements;
  }

  let merged = { ...DEFAULT_REGIONAL_REQUIREMENTS };

  if (config.receipts.regionalRequirements) {
    try {
      const override = JSON.parse(config.receipts.regionalRequirements) as Record<
        string,
        Partial<RegionalTaxRequirement>
      >;
      for (const [region, req] of Object.entries(override)) {
        merged[region.toUpperCase()] = {
          ...(merged[region.toUpperCase()] || merged.DEFAULT),
          ...req,
        } as RegionalTaxRequirement;
      }
    } catch (error) {
      logger.error('Invalid REGIONAL_TAX_REQUIREMENTS JSON; using built-in defaults', error);
    }
  }

  cachedRequirements = merged;
  return merged;
}

export function getRegionRequirement(region?: string | null): RegionalTaxRequirement {
  const requirements = loadRegionalRequirements();
  const key = (region || '').toUpperCase();
  return requirements[key] || requirements.DEFAULT;
}

/** Normalises a region code, falling back to the configured default region. */
export function resolveRegion(region?: string | null): string {
  const requirements = loadRegionalRequirements();
  const key = (region || '').toUpperCase();
  if (key && requirements[key]) {
    return key;
  }
  return config.receipts.defaultRegion.toUpperCase();
}

export function formatCurrency(
  amount: number | string,
  currency: string,
  language = 'en-US',
): string {
  const numeric = typeof amount === 'string' ? Number(amount) : amount;
  const safeNumeric = Number.isFinite(numeric) ? numeric : 0;

  try {
    return new Intl.NumberFormat(language, {
      style: 'currency',
      currency: currency.toUpperCase(),
    }).format(safeNumeric);
  } catch {
    // Non-ISO / crypto currency — Intl throws on an unknown currency code.
    const formatted = new Intl.NumberFormat(language, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 7,
    }).format(safeNumeric);
    return `${formatted} ${currency.toUpperCase()}`;
  }
}

// Exposed for tests so the env-driven cache can be reset between cases.
export function __resetRegionalRequirementsCache(): void {
  cachedRequirements = null;
}

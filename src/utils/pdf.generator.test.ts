import { generateReceiptPdf, ReceiptPdfData } from './pdf.generator';
import {
  formatCurrency,
  getRegionRequirement,
  resolveRegion,
  __resetRegionalRequirementsCache,
} from '../config/receipt.config';

const baseData: ReceiptPdfData = {
  receiptNumber: 'RCPT-2026-ABCDE',
  donationDate: new Date('2026-01-15T00:00:00Z'),
  generatedAt: new Date('2026-01-16T00:00:00Z'),
  amount: '125.50',
  currency: 'USD',
  region: 'US',
  donor: { name: 'Jane Donor', email: 'jane@example.com' },
  organization: {
    name: 'Helping Hands',
    taxId: '12-3456789',
    website: 'https://helpinghands.org',
    contactEmail: 'contact@helpinghands.org',
  },
  campaign: { title: 'Clean Water Initiative' },
};

describe('receipt.config', () => {
  beforeEach(() => {
    __resetRegionalRequirementsCache();
  });

  describe('formatCurrency', () => {
    it('formats ISO currencies with the currency symbol', () => {
      expect(formatCurrency(1000, 'USD', 'en-US')).toBe('$1,000.00');
      expect(formatCurrency('2500.5', 'EUR', 'en-IE')).toContain('2,500.50');
    });

    it('falls back gracefully for non-ISO / crypto currencies', () => {
      const result = formatCurrency(100, 'XLM', 'en-US');
      expect(result).toContain('XLM');
      expect(result).toContain('100');
    });

    it('treats non-numeric amounts as zero', () => {
      expect(formatCurrency('not-a-number', 'USD', 'en-US')).toBe('$0.00');
    });
  });

  describe('getRegionRequirement', () => {
    it('returns the configured requirement for a known region', () => {
      const req = getRegionRequirement('US');
      expect(req.taxDeductible).toBe(true);
      expect(req.requiredTaxId).toBe('EIN');
    });

    it('is case-insensitive', () => {
      expect(getRegionRequirement('uk').requiredTaxId).toBe('CHN');
    });

    it('falls back to DEFAULT for unknown regions', () => {
      const req = getRegionRequirement('ZZ');
      expect(req.taxDeductible).toBe(false);
    });
  });

  describe('resolveRegion', () => {
    it('normalises known regions to uppercase', () => {
      expect(resolveRegion('ca')).toBe('CA');
    });

    it('falls back to the default region for unknown input', () => {
      expect(resolveRegion('zz')).toBe('US');
    });
  });
});

describe('generateReceiptPdf', () => {
  it('produces a non-empty PDF buffer with a valid PDF header', async () => {
    const buffer = await generateReceiptPdf(baseData);
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.length).toBeGreaterThan(500);
    // %PDF magic bytes
    expect(buffer.subarray(0, 4).toString('latin1')).toBe('%PDF');
  });

  it('renders for a different region and crypto currency without throwing', async () => {
    const buffer = await generateReceiptPdf({
      ...baseData,
      region: 'UK',
      currency: 'XLM',
      amount: '4200.1234567',
    });
    expect(buffer.subarray(0, 4).toString('latin1')).toBe('%PDF');
  });

  it('renders when optional organization fields are missing', async () => {
    const buffer = await generateReceiptPdf({
      ...baseData,
      organization: { name: 'Bare Org' },
    });
    expect(buffer.subarray(0, 4).toString('latin1')).toBe('%PDF');
  });
});

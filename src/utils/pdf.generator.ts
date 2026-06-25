import PDFDocument from 'pdfkit';
import {
  formatCurrency,
  getRegionRequirement,
  RECEIPT_TEMPLATE_VERSION,
} from '../config/receipt.config';

export interface ReceiptPdfData {
  receiptNumber: string;
  donationDate: Date;
  generatedAt: Date;
  amount: number | string;
  currency: string;
  region: string;
  donor: {
    name: string;
    email: string;
    address?: string | null;
  };
  organization: {
    name: string;
    taxId?: string | null;
    website?: string | null;
    contactEmail?: string | null;
  };
  campaign: {
    title: string;
  };
  /** Optional impact statement, e.g. "Your donation will provide 20 meals". */
  impactSummary?: string;
}

const BRAND = '#1f7a5a';
const MUTED = '#666666';
const TEXT = '#222222';

function formatDate(date: Date, language: string): string {
  try {
    return new Intl.DateTimeFormat(language, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

/**
 * Renders a branded, print-friendly tax receipt PDF and resolves with the
 * complete file as a Buffer. Regional tax language and currency formatting are
 * driven by the receipt's region. Pure function with no I/O beyond PDF assembly.
 */
export function generateReceiptPdf(data: ReceiptPdfData): Promise<Buffer> {
  const requirement = getRegionRequirement(data.region);
  const language = requirement.language;

  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margin: 50,
        info: {
          Title: `Tax Receipt ${data.receiptNumber}`,
          Author: data.organization.name,
          Subject: `Donation receipt for ${data.campaign.title}`,
        },
      });

      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // ── Header ──────────────────────────────────────────────
      doc
        .fillColor(BRAND)
        .fontSize(22)
        .font('Helvetica-Bold')
        .text(data.organization.name, { align: 'left' });

      doc
        .moveDown(0.2)
        .fillColor(MUTED)
        .fontSize(10)
        .font('Helvetica')
        .text('Official Donation Receipt');

      doc
        .fontSize(18)
        .fillColor(TEXT)
        .font('Helvetica-Bold')
        .text('TAX RECEIPT', 50, 50, { align: 'right' });

      doc
        .fontSize(10)
        .fillColor(MUTED)
        .font('Helvetica')
        .text(`Receipt No: ${data.receiptNumber}`, { align: 'right' })
        .text(`Issued: ${formatDate(data.generatedAt, language)}`, { align: 'right' });

      doc.moveDown(1.5);
      const dividerY = doc.y;
      doc
        .moveTo(50, dividerY)
        .lineTo(545, dividerY)
        .strokeColor(BRAND)
        .lineWidth(2)
        .stroke();
      doc.moveDown(1);

      // ── Donor details ───────────────────────────────────────
      doc
        .fillColor(TEXT)
        .fontSize(12)
        .font('Helvetica-Bold')
        .text('Donor');
      doc
        .fontSize(10)
        .font('Helvetica')
        .fillColor(TEXT)
        .text(data.donor.name)
        .fillColor(MUTED)
        .text(data.donor.email);
      if (data.donor.address) {
        doc.text(data.donor.address);
      }
      doc.moveDown(1);

      // ── Donation details table ──────────────────────────────
      doc
        .fillColor(TEXT)
        .fontSize(12)
        .font('Helvetica-Bold')
        .text('Donation Details');
      doc.moveDown(0.5);

      const rows: Array<[string, string]> = [
        ['Campaign', data.campaign.title],
        ['Organization', data.organization.name],
        ['Donation Date', formatDate(data.donationDate, language)],
        ['Amount', formatCurrency(data.amount, data.currency, language)],
        ['Currency', data.currency.toUpperCase()],
      ];
      if (data.organization.taxId) {
        rows.push([`${requirement.requiredTaxId || 'Tax ID'}`, data.organization.taxId]);
      }

      doc.fontSize(10).font('Helvetica');
      for (const [label, value] of rows) {
        const y = doc.y;
        doc.fillColor(MUTED).text(label, 50, y, { width: 160 });
        doc.fillColor(TEXT).text(value, 220, y, { width: 325 });
        doc.moveDown(0.4);
      }

      doc.moveDown(0.6);

      // ── Amount highlight box ────────────────────────────────
      const boxY = doc.y;
      doc
        .roundedRect(50, boxY, 495, 50, 6)
        .fillAndStroke('#f1f8f4', BRAND);
      doc
        .fillColor(MUTED)
        .fontSize(10)
        .font('Helvetica')
        .text('Total Donation', 65, boxY + 10);
      doc
        .fillColor(BRAND)
        .fontSize(20)
        .font('Helvetica-Bold')
        .text(formatCurrency(data.amount, data.currency, language), 65, boxY + 22);
      doc.y = boxY + 50;
      doc.moveDown(1.2);

      // ── Tax deductibility statement ─────────────────────────
      doc
        .fillColor(TEXT)
        .fontSize(11)
        .font('Helvetica-Bold')
        .text(
          requirement.taxDeductible
            ? `Tax Deductible (Region: ${data.region.toUpperCase()})`
            : `Tax Status (Region: ${data.region.toUpperCase()})`,
        );
      doc
        .fontSize(9.5)
        .font('Helvetica')
        .fillColor(MUTED)
        .text(requirement.statement, { align: 'left' });

      if (data.impactSummary) {
        doc.moveDown(0.8);
        doc
          .fillColor(TEXT)
          .fontSize(11)
          .font('Helvetica-Bold')
          .text('Your Impact');
        doc
          .fontSize(9.5)
          .font('Helvetica')
          .fillColor(MUTED)
          .text(data.impactSummary);
      }

      // ── Footer ──────────────────────────────────────────────
      const footerY = 760;
      doc
        .moveTo(50, footerY)
        .lineTo(545, footerY)
        .strokeColor('#dddddd')
        .lineWidth(1)
        .stroke();

      const contactParts = [
        data.organization.contactEmail,
        data.organization.website,
      ].filter(Boolean);

      doc
        .fontSize(8)
        .fillColor(MUTED)
        .font('Helvetica')
        .text(
          'This receipt was generated electronically and is valid without a signature. ' +
            'Please retain it for your records. ' +
            (contactParts.length ? `Contact: ${contactParts.join(' · ')}. ` : '') +
            `Template ${RECEIPT_TEMPLATE_VERSION}.`,
          50,
          footerY + 8,
          { align: 'center', width: 495 },
        );

      doc.end();
    } catch (error) {
      reject(error as Error);
    }
  });
}

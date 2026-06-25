import { ReceiptService } from './receipt.service';
import prisma from '../config/database';
import { StorageService } from './storage.service';
import { NotificationService } from './notification.service';
import { generateReceiptPdf } from '../utils/pdf.generator';
import { AppError } from '../middleware/error';

jest.mock('../config/database');
// Factory mocks avoid loading the real modules (storage.service pulls in the
// native `sharp` dependency, which is not available in the test environment).
jest.mock('./storage.service', () => ({
  StorageService: {
    uploadDocument: jest.fn(),
    delete: jest.fn(),
    download: jest.fn(),
    getSignedUrl: jest.fn(),
  },
}));
jest.mock('./notification.service', () => ({
  NotificationService: { sendEmail: jest.fn() },
}));
jest.mock('./emailTemplate.service', () => ({
  EmailTemplateService: {
    render: jest.fn().mockReturnValue({
      html: '<html><body>Receipt Email</body></html>',
      text: 'Receipt Email plain text',
    }),
    getVersion: jest.fn().mockReturnValue('1.0.0'),
    logRender: jest.fn().mockResolvedValue(undefined),
  },
}));
jest.mock('../utils/pdf.generator', () => ({
  generateReceiptPdf: jest.fn(),
}));

const mockedStorage = StorageService as jest.Mocked<typeof StorageService>;
const mockedNotification = NotificationService as jest.Mocked<typeof NotificationService>;
const mockedPdf = generateReceiptPdf as jest.MockedFunction<typeof generateReceiptPdf>;

const buildDonation = (overrides: Record<string, any> = {}) => ({
  id: 'don1',
  status: 'CONFIRMED',
  userId: 'user1',
  amount: 100,
  currency: 'USD',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  taxReceipt: null,
  user: { id: 'user1', email: 'donor@example.com', username: 'donor' },
  campaign: {
    title: 'Help Campaign',
    organizationId: 'org1',
    organization: {
      id: 'org1',
      name: 'Org One',
      taxId: 'EIN-1',
      website: 'https://org.one',
      user: { email: 'org@example.com' },
    },
  },
  ...overrides,
});

describe('ReceiptService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedPdf.mockResolvedValue(Buffer.from('%PDF-1.7 fake'));
    mockedStorage.uploadDocument.mockResolvedValue({
      key: 'receipts/org1/don1_123.pdf',
      url: 'https://files/receipts/org1/don1_123.pdf',
    });
    mockedStorage.delete.mockResolvedValue(undefined);
    mockedStorage.download.mockResolvedValue(Buffer.from('%PDF'));
    mockedStorage.getSignedUrl.mockResolvedValue('https://signed/url');
  });

  describe('generateReceipt', () => {
    it('throws 404 when the donation does not exist', async () => {
      (prisma.donation.findUnique as jest.Mock).mockResolvedValue(null);
      await expect(ReceiptService.generateReceipt('missing')).rejects.toThrow(AppError);
    });

    it('returns the existing receipt without regenerating (idempotent)', async () => {
      const existing = { id: 'rec1', receiptNumber: 'RCPT-2026-AAAAA' };
      (prisma.donation.findUnique as jest.Mock).mockResolvedValue(
        buildDonation({ taxReceipt: existing }),
      );

      const result = await ReceiptService.generateReceipt('don1');

      expect(result).toBe(existing);
      expect(mockedPdf).not.toHaveBeenCalled();
      expect(mockedStorage.uploadDocument).not.toHaveBeenCalled();
    });

    it('rejects donations that are not confirmed', async () => {
      (prisma.donation.findUnique as jest.Mock).mockResolvedValue(
        buildDonation({ status: 'PENDING' }),
      );
      await expect(ReceiptService.generateReceipt('don1')).rejects.toThrow(
        /confirmed donations/,
      );
    });

    it('rejects donations without a donor account', async () => {
      (prisma.donation.findUnique as jest.Mock).mockResolvedValue(
        buildDonation({ user: null, userId: null }),
      );
      await expect(ReceiptService.generateReceipt('don1')).rejects.toThrow(/donor account/);
    });

    it('generates the PDF, stores it, and creates the receipt record', async () => {
      (prisma.donation.findUnique as jest.Mock).mockResolvedValue(buildDonation());
      const created = { id: 'rec1', receiptNumber: 'RCPT-2026-AAAAA' };
      (prisma.taxReceipt.create as jest.Mock).mockResolvedValue(created);
      (prisma.donation.update as jest.Mock).mockResolvedValue({});

      const result = await ReceiptService.generateReceipt('don1', { region: 'US' });

      expect(result).toBe(created);
      expect(mockedPdf).toHaveBeenCalledTimes(1);
      expect(mockedStorage.uploadDocument).toHaveBeenCalledWith(
        expect.stringContaining('receipts/org1/don1_'),
        expect.any(Buffer),
        'application/pdf',
        expect.objectContaining({ donationId: 'don1', organizationId: 'org1' }),
      );

      const createArgs = (prisma.taxReceipt.create as jest.Mock).mock.calls[0][0];
      expect(createArgs.data.donationId).toBe('don1');
      expect(createArgs.data.donorId).toBe('user1');
      expect(createArgs.data.organizationId).toBe('org1');
      expect(createArgs.data.region).toBe('US');
      expect(createArgs.data.taxDeductible).toBe(true);
      expect(createArgs.data.receiptNumber).toMatch(/^RCPT-\d{4}-[0-9A-F]{10}$/);
      expect(prisma.donation.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'don1' } }),
      );
    });

    it('cleans up the uploaded file and returns the winner on a unique-constraint race', async () => {
      (prisma.donation.findUnique as jest.Mock).mockResolvedValue(buildDonation());
      const raceError: any = new Error('unique violation');
      raceError.code = 'P2002';
      (prisma.$transaction as jest.Mock).mockRejectedValueOnce(raceError);
      const winner = { id: 'winner', receiptNumber: 'RCPT-2026-WINNER' };
      (prisma.taxReceipt.findUnique as jest.Mock).mockResolvedValue(winner);

      const result = await ReceiptService.generateReceipt('don1');

      expect(result).toBe(winner);
      expect(mockedStorage.delete).toHaveBeenCalledWith('receipts/org1/don1_123.pdf');
    });
  });

  describe('sendReceiptEmail', () => {
    const receipt = {
      id: 'rec1',
      receiptNumber: 'RCPT-2026-AAAAA',
      filePath: 'receipts/org1/don1_123.pdf',
      amount: 100,
      currency: 'USD',
      donationDate: new Date('2026-01-01T00:00:00Z'),
      donor: { email: 'donor@example.com', username: 'donor' },
      organization: { name: 'Org One' },
    };

    it('sends the email with a PDF attachment and marks it SENT', async () => {
      (prisma.taxReceipt.findUnique as jest.Mock).mockResolvedValue(receipt);
      (prisma.taxReceipt.update as jest.Mock).mockResolvedValue({ ...receipt, emailDeliveryStatus: 'SENT' });

      const result = await ReceiptService.sendReceiptEmail('rec1');

      expect(mockedNotification.sendEmail).toHaveBeenCalledWith(
        'donor@example.com',
        expect.stringContaining('RCPT-2026-AAAAA'),
        expect.any(String),
        expect.objectContaining({
          text: expect.any(String),
          attachments: [
            expect.objectContaining({ filename: 'RCPT-2026-AAAAA.pdf', contentType: 'application/pdf' }),
          ],
        }),
      );
      const updateArgs = (prisma.taxReceipt.update as jest.Mock).mock.calls[0][0];
      expect(updateArgs.data.emailDeliveryStatus).toBe('SENT');
      expect(result).not.toBeNull();
    });

    it('marks the receipt FAILED and returns null when delivery fails', async () => {
      (prisma.taxReceipt.findUnique as jest.Mock).mockResolvedValue(receipt);
      mockedNotification.sendEmail.mockRejectedValueOnce(new Error('smtp down'));
      (prisma.taxReceipt.update as jest.Mock).mockResolvedValue({});

      const result = await ReceiptService.sendReceiptEmail('rec1');

      expect(result).toBeNull();
      const updateArgs = (prisma.taxReceipt.update as jest.Mock).mock.calls[0][0];
      expect(updateArgs.data.emailDeliveryStatus).toBe('FAILED');
    });

    it('rethrows on failure when throwOnError is set (for worker retries)', async () => {
      (prisma.taxReceipt.findUnique as jest.Mock).mockResolvedValue(receipt);
      mockedNotification.sendEmail.mockRejectedValueOnce(new Error('smtp down'));
      (prisma.taxReceipt.update as jest.Mock).mockResolvedValue({});

      await expect(
        ReceiptService.sendReceiptEmail('rec1', { throwOnError: true }),
      ).rejects.toThrow('smtp down');
    });
  });

  describe('createBatchJob', () => {
    it('counts matching donations and creates a PENDING job', async () => {
      (prisma.donation.count as jest.Mock).mockResolvedValue(5);
      const job = { id: 'job1', status: 'PENDING', totalCount: 5 };
      (prisma.receiptBatchJob.create as jest.Mock).mockResolvedValue(job);

      const result = await ReceiptService.createBatchJob({ organizationId: 'org1' }, 'admin1');

      expect(result.totalMatched).toBe(5);
      expect(result.job).toBe(job);
      const createArgs = (prisma.receiptBatchJob.create as jest.Mock).mock.calls[0][0];
      expect(createArgs.data.createdBy).toBe('admin1');
      expect(createArgs.data.totalCount).toBe(5);
    });
  });

  describe('processBatchJob', () => {
    it('generates receipts for each donation and completes with counts', async () => {
      (prisma.receiptBatchJob.findUnique as jest.Mock).mockResolvedValue({
        id: 'job1',
        jobMetadata: { filter: {} },
        totalCount: 2,
      });
      (prisma.receiptBatchJob.update as jest.Mock).mockResolvedValue({});
      (prisma.donation.findMany as jest.Mock).mockResolvedValue([{ id: 'd1' }, { id: 'd2' }]);

      const genSpy = jest
        .spyOn(ReceiptService, 'generateReceipt')
        .mockResolvedValueOnce({ id: 'r1' })
        .mockRejectedValueOnce(new Error('boom'));
      const emailSpy = jest
        .spyOn(ReceiptService, 'sendReceiptEmail')
        .mockResolvedValue({} as any);

      await ReceiptService.processBatchJob('job1');

      expect(genSpy).toHaveBeenCalledTimes(2);
      expect(emailSpy).toHaveBeenCalledTimes(1); // only the successful one
      const finalUpdate = (prisma.receiptBatchJob.update as jest.Mock).mock.calls.pop()![0];
      expect(finalUpdate.data.status).toBe('COMPLETED');
      expect(finalUpdate.data.generatedCount).toBe(1);
      expect(finalUpdate.data.failedCount).toBe(1);

      genSpy.mockRestore();
      emailSpy.mockRestore();
    });

    it('throws 404 for an unknown job', async () => {
      (prisma.receiptBatchJob.findUnique as jest.Mock).mockResolvedValue(null);
      await expect(ReceiptService.processBatchJob('nope')).rejects.toThrow(AppError);
    });
  });

  describe('getBatchJob', () => {
    it('computes progress percentage from processed counts', async () => {
      (prisma.receiptBatchJob.findUnique as jest.Mock).mockResolvedValue({
        id: 'job1',
        status: 'PROCESSING',
        totalCount: 4,
        generatedCount: 2,
        failedCount: 1,
        organizationId: 'org1',
        createdAt: new Date(),
        completedAt: null,
      });

      const result = await ReceiptService.getBatchJob('job1');
      expect(result.progress).toBe(75); // (2+1)/4
      expect(result.status).toBe('PROCESSING');
    });
  });

  describe('listReceipts', () => {
    it('returns paginated receipts with metadata', async () => {
      (prisma.$transaction as jest.Mock).mockResolvedValueOnce([[{ id: 'r1' }], 1]);

      const result = await ReceiptService.listReceipts({ organizationId: 'org1' }, { page: 1, limit: 20 });

      expect(result.data).toHaveLength(1);
      expect(result.pagination).toEqual({ page: 1, limit: 20, total: 1, totalPages: 1 });
    });
  });
});

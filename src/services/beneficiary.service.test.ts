import { BeneficiaryStatus, Role, KYCStatus } from '@prisma/client';

jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation(() => ({
    add: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock('../config/database', () => {
  const mock = {
    __esModule: true,
    default: {
      beneficiary: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        count: jest.fn(),
      },
      kYCSubmission: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        count: jest.fn(),
      },
      $transaction: jest.fn(),
    },
  };
  return mock;
});

jest.mock('../config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const prismaMock = require('../config/database').default;

import { BeneficiaryService } from './beneficiary.service';

const mockBeneficiary = (overrides: any = {}) => ({
  id: 'ben-1',
  userId: 'user-1',
  firstName: 'John',
  lastName: 'Doe',
  status: BeneficiaryStatus.PENDING,
  familySize: 3,
  riskScore: 0,
  dateOfBirth: new Date('1990-01-01'),
  gender: 'male',
  nationality: 'US',
  idDocumentType: 'PASSPORT',
  idDocumentNumber: 'AB123456',
  phoneNumber: '+1234567890',
  country: 'US',
  city: 'New York',
  address: '123 Main St',
  needsDescription: 'Food assistance',
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const mockKYCSubmission = (overrides: any = {}) => ({
  id: 'kyc-1',
  userId: 'user-1',
  beneficiaryId: 'ben-1',
  status: KYCStatus.PENDING,
  documentUrl: 'https://docs.example.com/id.pdf',
  reviewNotes: null,
  reviewedBy: null,
  reviewedAt: null,
  fraudScore: 0,
  createdAt: new Date(),
  ...overrides,
});

describe('BeneficiaryService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (cb: any) =>
      typeof cb === 'function' ? cb(prismaMock) : Promise.all(cb)
    );
  });

  describe('createBeneficiary', () => {
    const input = {
      firstName: 'John',
      lastName: 'Doe',
      dateOfBirth: new Date('1990-01-01'),
      gender: 'male',
      nationality: 'US',
      idDocumentType: 'PASSPORT',
      idDocumentNumber: 'AB123456',
      phoneNumber: '+1234567890',
      country: 'US',
      city: 'New York',
      address: '123 Main St',
      needsDescription: 'Food assistance',
    };

    it('creates beneficiary successfully', async () => {
      prismaMock.beneficiary.findUnique.mockResolvedValue(null);
      prismaMock.beneficiary.create.mockResolvedValue(mockBeneficiary());

      const result = await BeneficiaryService.createBeneficiary(input, 'user-1');

      expect(result.status).toBe(BeneficiaryStatus.PENDING);
      expect(result.userId).toBe('user-1');
    });

    it('rejects duplicate beneficiary for user', async () => {
      prismaMock.beneficiary.findUnique.mockResolvedValue(mockBeneficiary());

      await expect(BeneficiaryService.createBeneficiary(input, 'user-1')).rejects.toThrow(
        'Beneficiary profile already exists for this user'
      );
    });

    it('handles database error during creation', async () => {
      prismaMock.beneficiary.findUnique.mockResolvedValue(null);
      prismaMock.beneficiary.create.mockRejectedValue(new Error('DB error'));

      await expect(BeneficiaryService.createBeneficiary(input, 'user-1')).rejects.toThrow('DB error');
    });
  });

  describe('getBeneficiaries', () => {
    it('returns paginated list of beneficiaries', async () => {
      const beneficiaries = [mockBeneficiary(), mockBeneficiary({ id: 'ben-2' })];
      prismaMock.beneficiary.findMany.mockResolvedValue(beneficiaries);
      prismaMock.beneficiary.count.mockResolvedValue(2);

      const result = await BeneficiaryService.getBeneficiaries({}, { page: 1, limit: 10 });

      expect(result.data).toHaveLength(2);
      expect(result.pagination.total).toBe(2);
      expect(result.pagination.totalPages).toBe(1);
    });

    it('filters by status', async () => {
      prismaMock.beneficiary.findMany.mockResolvedValue([]);
      prismaMock.beneficiary.count.mockResolvedValue(0);

      await BeneficiaryService.getBeneficiaries({ status: BeneficiaryStatus.VERIFIED }, { page: 1, limit: 10 });

      expect(prismaMock.beneficiary.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: BeneficiaryStatus.VERIFIED }),
        })
      );
    });

    it('searches by name', async () => {
      prismaMock.beneficiary.findMany.mockResolvedValue([]);
      prismaMock.beneficiary.count.mockResolvedValue(0);

      await BeneficiaryService.getBeneficiaries({ search: 'John' }, { page: 1, limit: 10 });

      const where = prismaMock.beneficiary.findMany.mock.calls[0][0].where;
      expect(where.OR).toBeDefined();
      expect(where.OR[0].firstName.contains).toBe('John');
    });

    it('handles empty results', async () => {
      prismaMock.beneficiary.findMany.mockResolvedValue([]);
      prismaMock.beneficiary.count.mockResolvedValue(0);

      const result = await BeneficiaryService.getBeneficiaries({}, { page: 1, limit: 10 });

      expect(result.data).toHaveLength(0);
      expect(result.pagination.total).toBe(0);
    });
  });

  describe('getBeneficiaryById', () => {
    it('returns beneficiary with relations', async () => {
      prismaMock.beneficiary.findUnique.mockResolvedValue(mockBeneficiary({
        user: { id: 'user-1', email: 'test@example.com' },
        assignments: [],
        distributions: [],
        kycSubmissions: [],
      }));

      const result = await BeneficiaryService.getBeneficiaryById('ben-1');

      expect(result.id).toBe('ben-1');
      expect(result.user).toBeDefined();
    });

    it('throws error for non-existent beneficiary', async () => {
      prismaMock.beneficiary.findUnique.mockResolvedValue(null);

      await expect(BeneficiaryService.getBeneficiaryById('nonexistent')).rejects.toThrow('Beneficiary not found');
    });
  });

  describe('updateBeneficiary', () => {
    const updateData = { firstName: 'Jane' };

    it('updates by owner', async () => {
      prismaMock.beneficiary.findUnique.mockResolvedValue(mockBeneficiary());
      prismaMock.beneficiary.update.mockResolvedValue(mockBeneficiary({ firstName: 'Jane' }));

      const result = await BeneficiaryService.updateBeneficiary('ben-1', updateData, 'user-1', Role.DONOR);

      expect(result.firstName).toBe('Jane');
    });

    it('updates by admin', async () => {
      prismaMock.beneficiary.findUnique.mockResolvedValue(mockBeneficiary());
      prismaMock.beneficiary.update.mockResolvedValue(mockBeneficiary({ firstName: 'Jane' }));

      const result = await BeneficiaryService.updateBeneficiary('ben-1', updateData, 'admin-1', Role.ADMIN);

      expect(result.firstName).toBe('Jane');
    });

    it('throws error for non-existent beneficiary', async () => {
      prismaMock.beneficiary.findUnique.mockResolvedValue(null);

      await expect(BeneficiaryService.updateBeneficiary('nonexistent', updateData, 'user-1', Role.DONOR)).rejects.toThrow(
        'Beneficiary not found'
      );
    });

    it('rejects unauthorized user', async () => {
      prismaMock.beneficiary.findUnique.mockResolvedValue(mockBeneficiary());

      await expect(BeneficiaryService.updateBeneficiary('ben-1', updateData, 'other-user', Role.DONOR)).rejects.toThrow(
        'You do not have permission to update this beneficiary'
      );
    });
  });

  describe('updateBeneficiaryStatus', () => {
    it('updates status to verified by admin', async () => {
      prismaMock.beneficiary.findUnique.mockResolvedValue(mockBeneficiary());
      prismaMock.beneficiary.update.mockResolvedValue(mockBeneficiary({ status: BeneficiaryStatus.VERIFIED, verifiedAt: new Date(), verifiedBy: 'admin-1' }));

      const result = await BeneficiaryService.updateBeneficiaryStatus('ben-1', BeneficiaryStatus.VERIFIED, 'admin-1', Role.ADMIN);

      expect(result.status).toBe(BeneficiaryStatus.VERIFIED);
    });

    it('updates status by verifier', async () => {
      prismaMock.beneficiary.findUnique.mockResolvedValue(mockBeneficiary());
      prismaMock.beneficiary.update.mockResolvedValue(mockBeneficiary({ status: BeneficiaryStatus.VERIFIED }));

      await expect(
        BeneficiaryService.updateBeneficiaryStatus('ben-1', BeneficiaryStatus.VERIFIED, 'verifier-1', Role.VERIFIER)
      ).resolves.toBeDefined();
    });

    it('rejects non-admin/verifier', async () => {
      prismaMock.beneficiary.findUnique.mockResolvedValue(mockBeneficiary());

      await expect(
        BeneficiaryService.updateBeneficiaryStatus('ben-1', BeneficiaryStatus.VERIFIED, 'user-1', Role.DONOR)
      ).rejects.toThrow('You do not have permission to update beneficiary status');
    });

    it('sets verifiedAt when status is VERIFIED', async () => {
      prismaMock.beneficiary.findUnique.mockResolvedValue(mockBeneficiary());
      prismaMock.beneficiary.update.mockResolvedValue(mockBeneficiary({ status: BeneficiaryStatus.VERIFIED }));

      await BeneficiaryService.updateBeneficiaryStatus('ben-1', BeneficiaryStatus.VERIFIED, 'admin-1', Role.ADMIN);

      expect(prismaMock.beneficiary.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: BeneficiaryStatus.VERIFIED,
            verifiedAt: expect.any(Date),
            verifiedBy: 'admin-1',
          }),
        })
      );
    });
  });

  describe('calculateRiskScore', () => {
    it('returns zero score with no risk factors', async () => {
      prismaMock.beneficiary.findUnique.mockResolvedValue(mockBeneficiary({ kycSubmissions: [], familySize: 3 }));
      prismaMock.beneficiary.update.mockResolvedValue(mockBeneficiary({ riskScore: 0 }));

      const score = await BeneficiaryService.calculateRiskScore('ben-1');

      expect(score).toBe(0);
    });

    it('increases score with multiple KYC rejections', async () => {
      prismaMock.beneficiary.findUnique.mockResolvedValue(
        mockBeneficiary({
          kycSubmissions: [{ status: KYCStatus.REJECTED }, { status: KYCStatus.REJECTED }, { status: KYCStatus.REJECTED }],
          familySize: 3,
        })
      );
      prismaMock.beneficiary.update.mockResolvedValue(mockBeneficiary({ riskScore: 20 }));

      const score = await BeneficiaryService.calculateRiskScore('ben-1');

      expect(score).toBe(20);
    });

    it('increases score with large family', async () => {
      prismaMock.beneficiary.findUnique.mockResolvedValue(
        mockBeneficiary({ kycSubmissions: [], familySize: 12 })
      );
      prismaMock.beneficiary.update.mockResolvedValue(mockBeneficiary({ riskScore: 10 }));

      const score = await BeneficiaryService.calculateRiskScore('ben-1');

      expect(score).toBe(10);
    });

    it('throws error for non-existent beneficiary', async () => {
      prismaMock.beneficiary.findUnique.mockResolvedValue(null);

      await expect(BeneficiaryService.calculateRiskScore('nonexistent')).rejects.toThrow('Beneficiary not found');
    });
  });

  describe('submitKYC', () => {
    const kycData = { documentUrl: 'https://docs.example.com/id.pdf', documentType: 'PASSPORT' };

    it('submits KYC successfully', async () => {
      prismaMock.beneficiary.findUnique.mockResolvedValue(mockBeneficiary());
      prismaMock.kYCSubmission.findFirst.mockResolvedValue(null);
      prismaMock.kYCSubmission.create.mockResolvedValue(mockKYCSubmission());

      const result = await BeneficiaryService.submitKYC('ben-1', kycData, 'user-1');

      expect(result.status).toBe(KYCStatus.PENDING);
      expect(prismaMock.kYCSubmission.create).toHaveBeenCalled();
    });

    it('rejects submission for non-existent beneficiary', async () => {
      prismaMock.beneficiary.findUnique.mockResolvedValue(null);

      await expect(BeneficiaryService.submitKYC('nonexistent', kycData, 'user-1')).rejects.toThrow('Beneficiary not found');
    });

    it('rejects submission from non-owner', async () => {
      prismaMock.beneficiary.findUnique.mockResolvedValue(mockBeneficiary());

      await expect(BeneficiaryService.submitKYC('ben-1', kycData, 'other-user')).rejects.toThrow(
        'You can only submit KYC for your own profile'
      );
    });

    it('rejects duplicate active submission', async () => {
      prismaMock.beneficiary.findUnique.mockResolvedValue(mockBeneficiary());
      prismaMock.kYCSubmission.findFirst.mockResolvedValue(mockKYCSubmission({ status: KYCStatus.PENDING }));

      await expect(BeneficiaryService.submitKYC('ben-1', kycData, 'user-1')).rejects.toThrow(
        'An active KYC submission already exists'
      );
    });
  });

  describe('reviewKYC', () => {
    const baseSubmission = () => ({
      ...mockKYCSubmission(),
      beneficiary: { id: 'ben-1', ...mockBeneficiary() },
    });

    it('approves KYC and updates beneficiary to verified', async () => {
      const submission = baseSubmission();
      prismaMock.kYCSubmission.findUnique.mockResolvedValue(submission);
      prismaMock.kYCSubmission.count
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(0);
      prismaMock.$transaction.mockImplementation(async (cb: any) => cb(prismaMock));
      prismaMock.kYCSubmission.update.mockResolvedValue(mockKYCSubmission({ status: KYCStatus.APPROVED }));
      prismaMock.beneficiary.update.mockResolvedValue(mockBeneficiary({ status: BeneficiaryStatus.VERIFIED }));

      const result = await BeneficiaryService.reviewKYC('kyc-1', KYCStatus.APPROVED, 'Looks good', 'admin-1', Role.ADMIN);

      expect(result.status).toBe(KYCStatus.APPROVED);
    });

    it('rejects KYC and updates beneficiary to rejected', async () => {
      const submission = baseSubmission();
      prismaMock.kYCSubmission.findUnique.mockResolvedValue(submission);
      prismaMock.kYCSubmission.count
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(0);
      prismaMock.$transaction.mockImplementation(async (cb: any) => cb(prismaMock));
      prismaMock.kYCSubmission.update.mockResolvedValue(mockKYCSubmission({ status: KYCStatus.REJECTED }));

      const result = await BeneficiaryService.reviewKYC('kyc-1', KYCStatus.REJECTED, 'Invalid docs', 'admin-1', Role.ADMIN);

      expect(result.status).toBe(KYCStatus.REJECTED);
      expect(prismaMock.beneficiary.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: BeneficiaryStatus.REJECTED }) })
      );
    });

    it('expires KYC and resets beneficiary to pending', async () => {
      const submission = baseSubmission();
      prismaMock.kYCSubmission.findUnique.mockResolvedValue(submission);
      prismaMock.kYCSubmission.count
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(0);
      prismaMock.$transaction.mockImplementation(async (cb: any) => cb(prismaMock));
      prismaMock.kYCSubmission.update.mockResolvedValue(mockKYCSubmission({ status: KYCStatus.EXPIRED }));

      const result = await BeneficiaryService.reviewKYC('kyc-1', KYCStatus.EXPIRED, 'Documents expired', 'admin-1', Role.ADMIN);

      expect(result.status).toBe(KYCStatus.EXPIRED);
      expect(prismaMock.beneficiary.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: BeneficiaryStatus.PENDING }) })
      );
    });

    it('rejects review from unauthorized user', async () => {
      prismaMock.kYCSubmission.findUnique.mockResolvedValue(baseSubmission());

      await expect(
        BeneficiaryService.reviewKYC('kyc-1', KYCStatus.APPROVED, 'Looks good', 'user-1', Role.DONOR)
      ).rejects.toThrow('You do not have permission to review KYC submissions');
    });

    it('throws error for non-existent submission', async () => {
      prismaMock.kYCSubmission.findUnique.mockResolvedValue(null);

      await expect(
        BeneficiaryService.reviewKYC('nonexistent', KYCStatus.APPROVED, 'Looks good', 'admin-1', Role.ADMIN)
      ).rejects.toThrow('KYC submission not found');
    });
  });

  describe('getBeneficiaryByUserId', () => {
    it('returns beneficiary for user', async () => {
      prismaMock.beneficiary.findUnique.mockResolvedValue(mockBeneficiary({
        user: { id: 'user-1', email: 'test@example.com' },
        assignments: [],
        distributions: [],
        kycSubmissions: [],
      }));

      const result = await BeneficiaryService.getBeneficiaryByUserId('user-1');

      expect(result.userId).toBe('user-1');
    });

    it('throws error for non-existent beneficiary', async () => {
      prismaMock.beneficiary.findUnique.mockResolvedValue(null);

      await expect(BeneficiaryService.getBeneficiaryByUserId('nonexistent')).rejects.toThrow(
        'Beneficiary profile not found'
      );
    });
  });
});

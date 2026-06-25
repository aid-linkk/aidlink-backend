import { PledgeService } from './pledge.service';
import { PledgeType, PledgeCadence, PledgeStatus, PledgeAttemptStatus } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';

const mockPrisma = {
  pledge: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    count: jest.fn(),
  },
  pledgeAttempt: {
    create: jest.fn(),
    findMany: jest.fn(),
  },
};

describe('PledgeService', () => {
  let service: PledgeService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new PledgeService(mockPrisma as any);
  });

  describe('createPledge', () => {
    it('creates a one-off pledge', async () => {
      const pledge = {
        id: 'pledge-1',
        type: PledgeType.ONE_OFF,
        status: PledgeStatus.ACTIVE,
        amount: new Decimal(100),
      };
      mockPrisma.pledge.create.mockResolvedValueOnce(pledge);

      const result = await service.createPledge({
        donorId: 'donor-1',
        amount: 100,
        type: PledgeType.ONE_OFF,
        startDate: new Date(Date.now() + 86400000),
      });

      expect(result).toEqual(pledge);
      expect(mockPrisma.pledge.create).toHaveBeenCalledTimes(1);
    });

    it('creates a recurring pledge with cadence', async () => {
      const pledge = {
        id: 'pledge-2',
        type: PledgeType.RECURRING,
        cadence: PledgeCadence.MONTHLY,
        status: PledgeStatus.ACTIVE,
      };
      mockPrisma.pledge.create.mockResolvedValueOnce(pledge);

      const result = await service.createPledge({
        donorId: 'donor-1',
        amount: 50,
        type: PledgeType.RECURRING,
        cadence: PledgeCadence.MONTHLY,
        startDate: new Date(),
      });

      expect(result.type).toBe(PledgeType.RECURRING);
    });

    it('throws when RECURRING pledge has no cadence', async () => {
      await expect(
        service.createPledge({
          donorId: 'donor-1',
          amount: 50,
          type: PledgeType.RECURRING,
          startDate: new Date(),
        }),
      ).rejects.toThrow('cadence is required');
    });

    it('returns existing pledge for duplicate idempotency key', async () => {
      const existing = { id: 'pledge-existing', idempotencyKey: 'key-123' };
      mockPrisma.pledge.findUnique.mockResolvedValueOnce(existing);

      const result = await service.createPledge({
        donorId: 'donor-1',
        amount: 100,
        type: PledgeType.ONE_OFF,
        startDate: new Date(),
        idempotencyKey: 'key-123',
      });

      expect(result).toEqual(existing);
      expect(mockPrisma.pledge.create).not.toHaveBeenCalled();
    });
  });

  describe('getPledgeById', () => {
    it('returns pledge with attempts', async () => {
      const pledge = { id: 'pledge-1', attempts: [] };
      mockPrisma.pledge.findUnique.mockResolvedValueOnce(pledge);

      const result = await service.getPledgeById('pledge-1');
      expect(result).toEqual(pledge);
    });

    it('returns null when pledge not found', async () => {
      mockPrisma.pledge.findUnique.mockResolvedValueOnce(null);
      const result = await service.getPledgeById('missing');
      expect(result).toBeNull();
    });
  });

  describe('cancelPledge', () => {
    it('cancels an active pledge', async () => {
      const pledge = { id: 'pledge-1', status: PledgeStatus.ACTIVE, metadata: {} };
      mockPrisma.pledge.findUnique.mockResolvedValueOnce(pledge);
      mockPrisma.pledge.update.mockResolvedValueOnce({
        ...pledge,
        status: PledgeStatus.CANCELLED,
      });

      const result = await service.cancelPledge('pledge-1', 'No longer needed');
      expect(result.status).toBe(PledgeStatus.CANCELLED);
    });

    it('throws when pledge not found', async () => {
      mockPrisma.pledge.findUnique.mockResolvedValueOnce(null);
      await expect(service.cancelPledge('missing')).rejects.toThrow('Pledge not found');
    });

    it('throws when pledge already cancelled', async () => {
      mockPrisma.pledge.findUnique.mockResolvedValueOnce({
        id: 'pledge-1',
        status: PledgeStatus.CANCELLED,
      });
      await expect(service.cancelPledge('pledge-1')).rejects.toThrow('already cancelled');
    });
  });

  describe('listPledges', () => {
    it('returns paginated pledges', async () => {
      mockPrisma.pledge.findMany.mockResolvedValueOnce([{ id: 'p1' }]);
      mockPrisma.pledge.count.mockResolvedValueOnce(1);

      const result = await service.listPledges({ donorId: 'donor-1' });
      expect(result.data).toHaveLength(1);
      expect(result.pagination.total).toBe(1);
    });
  });

  describe('markAttemptSuccess', () => {
    it('marks one-off pledge as COMPLETED', async () => {
      const pledge = {
        id: 'pledge-1',
        type: PledgeType.ONE_OFF,
        nextRunAt: new Date(),
        cadence: null,
        endDate: null,
      };
      mockPrisma.pledge.findUnique.mockResolvedValueOnce(pledge);
      mockPrisma.pledge.update.mockResolvedValueOnce({
        ...pledge,
        status: PledgeStatus.COMPLETED,
        nextRunAt: null,
      });

      await service.markAttemptSuccess('pledge-1');
      expect(mockPrisma.pledge.update).toHaveBeenCalledWith({
        where: { id: 'pledge-1' },
        data: { status: PledgeStatus.COMPLETED, nextRunAt: null },
      });
    });

    it('updates nextRunAt for recurring pledge', async () => {
      const pledge = {
        id: 'pledge-2',
        type: PledgeType.RECURRING,
        cadence: PledgeCadence.WEEKLY,
        nextRunAt: new Date(),
        endDate: null,
      };
      mockPrisma.pledge.findUnique.mockResolvedValueOnce(pledge);
      mockPrisma.pledge.update.mockResolvedValueOnce(pledge);

      await service.markAttemptSuccess('pledge-2');
      expect(mockPrisma.pledge.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'pledge-2' },
          data: expect.objectContaining({ nextRunAt: expect.any(Date) }),
        }),
      );
    });
  });

  describe('recordAttempt', () => {
    it('creates a pledge attempt', async () => {
      const attempt = { id: 'attempt-1', pledgeId: 'pledge-1' };
      mockPrisma.pledgeAttempt.create.mockResolvedValueOnce(attempt);

      const result = await service.recordAttempt(
        'pledge-1',
        PledgeAttemptStatus.SUCCESS,
        { providerReference: 'ref-123' },
      );

      expect(result).toEqual(attempt);
    });
  });
});
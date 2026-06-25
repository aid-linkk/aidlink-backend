import { BlockchainService } from './blockchain.service';
import prisma from '../config/database';

jest.mock('../config/database');

const mockTx = {
  id: 'tx1',
  txHash: '0xabc',
  type: 'DONATION',
  fromAddress: 'GABC',
  toAddress: 'GDEF',
  amount: '100',
  currency: 'XLM',
  contractAddress: 'GCONTRACT',
  functionName: null,
  parameters: null,
  status: 'CONFIRMED',
  blockNumber: BigInt(12345),
  timestamp: new Date(),
  indexed: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockEvent = {
  id: 'ev1',
  txHash: '0xabc',
  contractAddress: 'GCONTRACT',
  eventName: 'Transfer',
  parameters: { amount: '100' },
  blockNumber: BigInt(12345),
  timestamp: new Date(),
  processed: false,
  createdAt: new Date(),
};

describe('BlockchainService', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('getTransactions', () => {
    it('returns paginated transactions', async () => {
      (prisma.blockchainTransaction.findMany as jest.Mock).mockResolvedValue([mockTx]);
      (prisma.blockchainTransaction.count as jest.Mock).mockResolvedValue(1);

      const result = await BlockchainService.getTransactions({ page: 1, limit: 20 });

      expect(result.data).toHaveLength(1);
      expect(result.pagination).toEqual({ page: 1, limit: 20, total: 1, totalPages: 1 });
    });

    it('applies status filter', async () => {
      (prisma.blockchainTransaction.findMany as jest.Mock).mockResolvedValue([mockTx]);
      (prisma.blockchainTransaction.count as jest.Mock).mockResolvedValue(1);

      await BlockchainService.getTransactions({ status: 'CONFIRMED' });

      expect(prisma.blockchainTransaction.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ status: 'CONFIRMED' }) })
      );
    });

    it('applies contractAddress filter', async () => {
      (prisma.blockchainTransaction.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.blockchainTransaction.count as jest.Mock).mockResolvedValue(0);

      await BlockchainService.getTransactions({ contractAddress: 'GCONTRACT' });

      expect(prisma.blockchainTransaction.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ contractAddress: { contains: 'GCONTRACT', mode: 'insensitive' } }),
        })
      );
    });

    it('applies date range filter', async () => {
      (prisma.blockchainTransaction.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.blockchainTransaction.count as jest.Mock).mockResolvedValue(0);

      const from = new Date('2024-01-01');
      const to = new Date('2024-12-31');
      await BlockchainService.getTransactions({ createdAtFrom: from, createdAtTo: to });

      expect(prisma.blockchainTransaction.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ createdAt: { gte: from, lte: to } }),
        })
      );
    });
  });

  describe('getTransactionById', () => {
    it('returns the transaction when found', async () => {
      (prisma.blockchainTransaction.findUnique as jest.Mock).mockResolvedValue(mockTx);

      const result = await BlockchainService.getTransactionById('tx1');

      expect(result).toEqual(mockTx);
      expect(prisma.blockchainTransaction.findUnique).toHaveBeenCalledWith({ where: { id: 'tx1' } });
    });

    it('returns null when not found', async () => {
      (prisma.blockchainTransaction.findUnique as jest.Mock).mockResolvedValue(null);
      const result = await BlockchainService.getTransactionById('missing');
      expect(result).toBeNull();
    });
  });

  describe('getEvents', () => {
    it('returns paginated events', async () => {
      (prisma.contractEvent.findMany as jest.Mock).mockResolvedValue([mockEvent]);
      (prisma.contractEvent.count as jest.Mock).mockResolvedValue(1);

      const result = await BlockchainService.getEvents({ page: 1, limit: 20 });

      expect(result.data).toHaveLength(1);
      expect(result.pagination).toEqual({ page: 1, limit: 20, total: 1, totalPages: 1 });
    });

    it('applies processed=false filter', async () => {
      (prisma.contractEvent.findMany as jest.Mock).mockResolvedValue([mockEvent]);
      (prisma.contractEvent.count as jest.Mock).mockResolvedValue(1);

      await BlockchainService.getEvents({ processed: false });

      expect(prisma.contractEvent.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ processed: false }) })
      );
    });

    it('applies contractAddress and eventName filters', async () => {
      (prisma.contractEvent.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.contractEvent.count as jest.Mock).mockResolvedValue(0);

      await BlockchainService.getEvents({ contractAddress: 'GCONTRACT', eventName: 'Transfer' });

      expect(prisma.contractEvent.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            contractAddress: { contains: 'GCONTRACT', mode: 'insensitive' },
            eventName: { contains: 'Transfer', mode: 'insensitive' },
          }),
        })
      );
    });

    it('applies createdAt date range filter', async () => {
      (prisma.contractEvent.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.contractEvent.count as jest.Mock).mockResolvedValue(0);

      const from = new Date('2024-01-01');
      const to = new Date('2024-12-31');
      await BlockchainService.getEvents({ createdAtFrom: from, createdAtTo: to });

      expect(prisma.contractEvent.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ createdAt: { gte: from, lte: to } }),
        })
      );
    });
  });

  describe('getEventById', () => {
    it('returns the event when found', async () => {
      (prisma.contractEvent.findUnique as jest.Mock).mockResolvedValue(mockEvent);

      const result = await BlockchainService.getEventById('ev1');

      expect(result).toEqual(mockEvent);
      expect(prisma.contractEvent.findUnique).toHaveBeenCalledWith({ where: { id: 'ev1' } });
    });

    it('returns null when not found', async () => {
      (prisma.contractEvent.findUnique as jest.Mock).mockResolvedValue(null);
      const result = await BlockchainService.getEventById('missing');
      expect(result).toBeNull();
    });
  });
});

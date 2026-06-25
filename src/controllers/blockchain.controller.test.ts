import { Request, Response } from 'express';
import { BlockchainController } from './blockchain.controller';
import { BlockchainService } from '../services/blockchain.service';
import { AuthRequest } from '../types';

jest.mock('../services/blockchain.service');

const mockNext = jest.fn();

function makeRes(): Partial<Response> {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  };
}

function makeReq(role: string, query: Record<string, string> = {}, params: Record<string, string> = {}): Partial<AuthRequest> {
  return {
    user: { id: 'u1', email: 'a@b.com', role },
    query,
    params,
  };
}

const paginatedResult = { data: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 0 } };

beforeEach(() => jest.clearAllMocks());

describe('BlockchainController - access control', () => {
  const actions = [
    { name: 'getTransactions', setup: () => (BlockchainService.getTransactions as jest.Mock).mockResolvedValue(paginatedResult) },
    { name: 'getEvents', setup: () => (BlockchainService.getEvents as jest.Mock).mockResolvedValue(paginatedResult) },
  ] as const;

  for (const { name, setup } of actions) {
    describe(name, () => {
      it('allows ADMIN', async () => {
        setup();
        const req = makeReq('ADMIN');
        const res = makeRes();
        await BlockchainController[name](req as AuthRequest, res as Response, mockNext);
        expect((res.status as jest.Mock)).toHaveBeenCalledWith(200);
      });

      it('allows AUDITOR', async () => {
        setup();
        const req = makeReq('AUDITOR');
        const res = makeRes();
        await BlockchainController[name](req as AuthRequest, res as Response, mockNext);
        expect((res.status as jest.Mock)).toHaveBeenCalledWith(200);
      });

      it('rejects DONOR with 403', async () => {
        const req = makeReq('DONOR');
        const res = makeRes();
        await BlockchainController[name](req as AuthRequest, res as Response, mockNext);
        expect(mockNext).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
      });

      it('rejects unauthenticated with 403', async () => {
        const req = { user: undefined, query: {}, params: {} } as any;
        const res = makeRes();
        await BlockchainController[name](req as AuthRequest, res as Response, mockNext);
        expect(mockNext).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
      });
    });
  }
});

describe('BlockchainController.getTransactionById', () => {
  it('returns 200 with transaction for ADMIN', async () => {
    (BlockchainService.getTransactionById as jest.Mock).mockResolvedValue({ id: 'tx1' });
    const req = makeReq('ADMIN', {}, { id: 'tx1' });
    const res = makeRes();
    await BlockchainController.getTransactionById(req as AuthRequest, res as Response, mockNext);
    expect((res.status as jest.Mock)).toHaveBeenCalledWith(200);
    expect((res.json as jest.Mock)).toHaveBeenCalledWith({ success: true, data: { id: 'tx1' } });
  });

  it('calls next with 404 when not found', async () => {
    (BlockchainService.getTransactionById as jest.Mock).mockResolvedValue(null);
    const req = makeReq('ADMIN', {}, { id: 'missing' });
    const res = makeRes();
    await BlockchainController.getTransactionById(req as AuthRequest, res as Response, mockNext);
    expect(mockNext).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
  });

  it('rejects ORGANIZATION with 403', async () => {
    const req = makeReq('ORGANIZATION', {}, { id: 'tx1' });
    const res = makeRes();
    await BlockchainController.getTransactionById(req as AuthRequest, res as Response, mockNext);
    expect(mockNext).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
  });
});

describe('BlockchainController.getEventById', () => {
  it('returns 200 with event for AUDITOR', async () => {
    (BlockchainService.getEventById as jest.Mock).mockResolvedValue({ id: 'ev1' });
    const req = makeReq('AUDITOR', {}, { id: 'ev1' });
    const res = makeRes();
    await BlockchainController.getEventById(req as AuthRequest, res as Response, mockNext);
    expect((res.status as jest.Mock)).toHaveBeenCalledWith(200);
    expect((res.json as jest.Mock)).toHaveBeenCalledWith({ success: true, data: { id: 'ev1' } });
  });

  it('calls next with 404 when not found', async () => {
    (BlockchainService.getEventById as jest.Mock).mockResolvedValue(null);
    const req = makeReq('ADMIN', {}, { id: 'missing' });
    const res = makeRes();
    await BlockchainController.getEventById(req as AuthRequest, res as Response, mockNext);
    expect(mockNext).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
  });
});

describe('BlockchainController.getTransactions - filter passthrough', () => {
  it('passes query filters to service', async () => {
    (BlockchainService.getTransactions as jest.Mock).mockResolvedValue(paginatedResult);
    const req = makeReq('ADMIN', {
      status: 'CONFIRMED',
      contractAddress: 'GCONTRACT',
      page: '2',
      limit: '10',
    });
    const res = makeRes();
    await BlockchainController.getTransactions(req as AuthRequest, res as Response, mockNext);
    expect(BlockchainService.getTransactions).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'CONFIRMED',
        contractAddress: 'GCONTRACT',
        page: 2,
        limit: 10,
      })
    );
  });
});

describe('BlockchainController.getEvents - filter passthrough', () => {
  it('converts processed query param to boolean', async () => {
    (BlockchainService.getEvents as jest.Mock).mockResolvedValue(paginatedResult);
    const req = makeReq('ADMIN', { processed: 'false' });
    const res = makeRes();
    await BlockchainController.getEvents(req as AuthRequest, res as Response, mockNext);
    expect(BlockchainService.getEvents).toHaveBeenCalledWith(
      expect.objectContaining({ processed: false })
    );
  });

  it('converts processed=true correctly', async () => {
    (BlockchainService.getEvents as jest.Mock).mockResolvedValue(paginatedResult);
    const req = makeReq('AUDITOR', { processed: 'true' });
    const res = makeRes();
    await BlockchainController.getEvents(req as AuthRequest, res as Response, mockNext);
    expect(BlockchainService.getEvents).toHaveBeenCalledWith(
      expect.objectContaining({ processed: true })
    );
  });
});

import { Request, Response } from 'express';
import { DatabaseController } from '../../src/controllers/database.controller';
import {
  checkDatabaseHealth,
  databaseMetrics,
  getPoolStats,
} from '../../src/config/database';

jest.mock('../../src/config/database');

const mockedHealth = checkDatabaseHealth as jest.Mock;
const mockedPoolStats = getPoolStats as jest.Mock;
const mockedMetrics = databaseMetrics as unknown as {
  snapshot: jest.Mock;
  reset: jest.Mock;
};

const createResponse = (): Response => {
  const res = {} as Response;
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

const request = {} as Request;

describe('DatabaseController', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getHealth', () => {
    it('returns 200 when the database is healthy', async () => {
      mockedHealth.mockResolvedValue({ status: 'healthy', latencyMs: 2 });
      const res = createResponse();

      await DatabaseController.getHealth(request, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({ status: 'healthy', latencyMs: 2 }),
        })
      );
    });

    it('still returns 200 when degraded so the instance keeps serving', async () => {
      mockedHealth.mockResolvedValue({ status: 'degraded', latencyMs: 90 });
      const res = createResponse();

      await DatabaseController.getHealth(request, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    });

    it('returns 503 when the database is unreachable', async () => {
      mockedHealth.mockResolvedValue({ status: 'unhealthy', latencyMs: null, error: 'down' });
      const res = createResponse();

      await DatabaseController.getHealth(request, res);

      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
    });
  });

  describe('getMetrics', () => {
    it('combines pool gauges, pool settings and the metrics snapshot', async () => {
      mockedPoolStats.mockResolvedValue({ open: 3, busy: 1, limit: 10, available: true });
      mockedMetrics.snapshot.mockReturnValue({ queries: { total: 7 } });
      const res = createResponse();

      await DatabaseController.getMetrics(request, res);

      const payload = (res.json as jest.Mock).mock.calls[0][0];
      expect(payload.success).toBe(true);
      expect(payload.data.pool).toMatchObject({ open: 3, busy: 1, available: true });
      expect(payload.data.pool.settings).toBeDefined();
      expect(payload.data.queries).toEqual({ total: 7 });
    });
  });

  describe('resetMetrics', () => {
    it('clears the collector', async () => {
      const res = createResponse();

      await DatabaseController.resetMetrics(request, res);

      expect(mockedMetrics.reset).toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
    });
  });
});

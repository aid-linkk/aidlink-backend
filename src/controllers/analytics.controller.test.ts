import { Response, NextFunction } from 'express';
import { Role } from '@prisma/client';
import { AuthRequest } from '../types';

jest.mock('../services/analytics.service', () => ({
  AnalyticsService: {
    exportReport: jest.fn(),
  },
}));

import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from '../services/analytics.service';

function makeReq(overrides: Partial<AuthRequest> = {}): AuthRequest {
  return {
    user: { id: 'admin-1', email: 'admin@test.com', role: Role.ADMIN },
    params: { reportType: 'campaign' },
    query: {},
    body: {},
    ...overrides,
  } as unknown as AuthRequest;
}

function makeRes(): { status: jest.Mock; send: jest.Mock; setHeader: jest.Mock } & Response {
  const res = {
    status: jest.fn(),
    send: jest.fn(),
    setHeader: jest.fn(),
  } as unknown as { status: jest.Mock; send: jest.Mock; setHeader: jest.Mock } & Response;
  (res.status as jest.Mock).mockReturnValue(res);
  return res;
}

const next = jest.fn() as unknown as NextFunction;

describe('AnalyticsController.exportReport', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (AnalyticsService.exportReport as jest.Mock).mockResolvedValue({
      content: 'campaignId,title\n1,Test',
      filename: 'campaign-analytics-2026-01-01.csv',
      contentType: 'text/csv',
    });
  });

  it('returns 403 when the requester is not an admin', async () => {
    await AnalyticsController.exportReport(
      makeReq({ user: { id: 'user-1', email: 'donor@test.com', role: Role.DONOR } }),
      makeRes(),
      next
    );

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
    expect(AnalyticsService.exportReport).not.toHaveBeenCalled();
  });

  it('returns 403 when there is no authenticated user', async () => {
    await AnalyticsController.exportReport(makeReq({ user: undefined }), makeRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
    expect(AnalyticsService.exportReport).not.toHaveBeenCalled();
  });

  it('streams a CSV export back with attachment headers for an admin', async () => {
    const res = makeRes();

    await AnalyticsController.exportReport(
      makeReq({ query: { campaignId: 'c1' } }),
      res,
      next
    );

    expect(AnalyticsService.exportReport).toHaveBeenCalledWith(
      'campaign',
      expect.objectContaining({ campaignId: 'c1' }),
      'csv'
    );
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/csv');
    expect(res.setHeader).toHaveBeenCalledWith(
      'Content-Disposition',
      'attachment; filename="campaign-analytics-2026-01-01.csv"'
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send).toHaveBeenCalledWith('campaignId,title\n1,Test');
    expect(next).not.toHaveBeenCalled();
  });

  it('requests JSON format when format=json is passed', async () => {
    await AnalyticsController.exportReport(
      makeReq({ params: { reportType: 'platform' }, query: { format: 'json' } }),
      makeRes(),
      next
    );

    expect(AnalyticsService.exportReport).toHaveBeenCalledWith('platform', expect.any(Object), 'json');
  });

  it('forwards service errors to next()', async () => {
    (AnalyticsService.exportReport as jest.Mock).mockRejectedValue(
      Object.assign(new Error('Invalid report type'), { statusCode: 400 })
    );

    await AnalyticsController.exportReport(makeReq({ params: { reportType: 'bogus' } }), makeRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
  });
});

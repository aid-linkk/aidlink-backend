import { Response } from 'express';
import { AdminController } from './admin.controller';
import { AuthRequest } from '../types';
import { AuditAction } from '@prisma/client';

jest.mock('../config/database', () => ({
  __esModule: true,
  default: {
    user: {
      count: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    auditLog: {
      create: jest.fn(),
    },
  },
}));

jest.mock('../services/audit.service', () => ({
  writeAuditLog: jest.fn(),
}));

jest.mock('../utils/cache', () => ({
  getCacheMetrics: jest.fn().mockResolvedValue({}),
}));

const prismaMock = require('../config/database').default;
const { writeAuditLog } = require('../services/audit.service');

function makeRes(): Partial<Response> {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  };
}

function makeReq(
  role: string,
  params: Record<string, string> = {},
  body: Record<string, unknown> = {}
): Partial<AuthRequest> {
  return {
    user: { id: 'admin-1', email: 'admin@example.com', role },
    params,
    body,
  };
}

const mockNext = jest.fn();

beforeEach(() => jest.clearAllMocks());

describe('AdminController - updateUserStatus', () => {
  it('rejects non-admin requesters with 403', async () => {
    const req = makeReq('DONOR', { id: 'user-1' }, { status: 'SUSPENDED' });
    const res = makeRes();

    await AdminController.updateUserStatus(req as AuthRequest, res as Response, mockNext);

    expect(mockNext).toHaveBeenCalled();
    expect(prismaMock.user.update).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it('updates status and writes a USER_UPDATED audit entry with before/after values', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ status: 'ACTIVE' });
    prismaMock.user.update.mockResolvedValue({ id: 'user-1', status: 'SUSPENDED' });

    const req = makeReq('ADMIN', { id: 'user-1' }, { status: 'SUSPENDED' });
    const res = makeRes();

    await AdminController.updateUserStatus(req as AuthRequest, res as Response, mockNext);

    expect(prismaMock.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { status: 'SUSPENDED' },
    });

    expect(writeAuditLog).toHaveBeenCalledWith(
      AuditAction.USER_UPDATED,
      'User',
      'user-1',
      'admin-1',
      { field: 'status', from: 'ACTIVE', to: 'SUSPENDED' }
    );

    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('still returns success even if the previous-value lookup finds nothing', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);
    prismaMock.user.update.mockResolvedValue({ id: 'user-1', status: 'ACTIVE' });

    const req = makeReq('ADMIN', { id: 'user-1' }, { status: 'ACTIVE' });
    const res = makeRes();

    await AdminController.updateUserStatus(req as AuthRequest, res as Response, mockNext);

    expect(writeAuditLog).toHaveBeenCalledWith(
      AuditAction.USER_UPDATED,
      'User',
      'user-1',
      'admin-1',
      { field: 'status', from: undefined, to: 'ACTIVE' }
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });
});

describe('AdminController - updateUserRole', () => {
  it('rejects non-admin requesters with 403', async () => {
    const req = makeReq('DONOR', { id: 'user-1' }, { role: 'ADMIN' });
    const res = makeRes();

    await AdminController.updateUserRole(req as AuthRequest, res as Response, mockNext);

    expect(mockNext).toHaveBeenCalled();
    expect(prismaMock.user.update).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it('updates role and writes a ROLE_CHANGED audit entry with before/after values', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ role: 'DONOR' });
    prismaMock.user.update.mockResolvedValue({ id: 'user-1', role: 'ADMIN' });

    const req = makeReq('ADMIN', { id: 'user-1' }, { role: 'ADMIN' });
    const res = makeRes();

    await AdminController.updateUserRole(req as AuthRequest, res as Response, mockNext);

    expect(prismaMock.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { role: 'ADMIN' },
    });

    expect(writeAuditLog).toHaveBeenCalledWith(
      AuditAction.ROLE_CHANGED,
      'User',
      'user-1',
      'admin-1',
      { field: 'role', from: 'DONOR', to: 'ADMIN' }
    );

    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('records the acting admin as the audit actor, not the target user', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ role: 'DONOR' });
    prismaMock.user.update.mockResolvedValue({ id: 'user-2', role: 'ADMIN' });

    const req = makeReq('ADMIN', { id: 'user-2' }, { role: 'ADMIN' });
    (req as AuthRequest).user = { id: 'admin-99', email: 'a@b.com', role: 'ADMIN' } as any;
    const res = makeRes();

    await AdminController.updateUserRole(req as AuthRequest, res as Response, mockNext);

    expect(writeAuditLog).toHaveBeenCalledWith(
      AuditAction.ROLE_CHANGED,
      'User',
      'user-2',
      'admin-99',
      expect.any(Object)
    );
  });
});

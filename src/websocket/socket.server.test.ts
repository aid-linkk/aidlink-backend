import { Role } from '@prisma/client';
import { authenticateSocketToken } from './socket.server';

jest.mock('../config/database', () => ({
  __esModule: true,
  default: {
    user: { findUnique: jest.fn() },
  },
}));

jest.mock('../config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));

jest.mock('../config', () => ({
  config: {
    cors: { origin: '*' },
    jwt: { secret: 'test-secret' },
  },
}));

jest.mock('../utils/jwt', () => ({
  JWTUtils: {
    verifyToken: jest.fn(),
    getUserId: jest.fn(),
  },
}));

const prismaMock = require('../config/database').default;
const { JWTUtils } = require('../utils/jwt');

describe('authenticateSocketToken', () => {
  beforeEach(() => jest.clearAllMocks());

  it('extracts the authenticated user id from the canonical JWT payload', async () => {
    JWTUtils.verifyToken.mockReturnValue({
      id: 'user-1',
      email: 'test@example.com',
      role: Role.DONOR,
    });
    JWTUtils.getUserId.mockReturnValue('user-1');
    prismaMock.user.findUnique.mockResolvedValue({ id: 'user-1', role: Role.DONOR });

    const result = await authenticateSocketToken('valid-token');

    expect(result).toEqual({ userId: 'user-1', userRole: Role.DONOR });
    expect(prismaMock.user.findUnique).toHaveBeenCalledWith({ where: { id: 'user-1' } });
  });

  it('rejects malformed tokens when the user id is missing', async () => {
    JWTUtils.verifyToken.mockReturnValue({ email: 'test@example.com', role: Role.DONOR });
    JWTUtils.getUserId.mockReturnValue(undefined);

    await expect(authenticateSocketToken('invalid-token')).rejects.toThrow('Authentication failed');
  });
});

/* eslint-disable @typescript-eslint/no-explicit-any */

const prismaMock: any = {
  multiplier: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  matchedFund: {
    findMany: jest.fn(),
    create: jest.fn(),
    aggregate: jest.fn(),
  },
  campaign: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    count: jest.fn(),
  },
  donation: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    aggregate: jest.fn().mockResolvedValue({ _sum: { amount: 0 } }),
    count: jest.fn(),
    groupBy: jest.fn().mockResolvedValue([]),
  },
  distribution: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    aggregate: jest.fn().mockResolvedValue({ _sum: { amount: 0 } }),
    count: jest.fn(),
  },
  beneficiary: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    count: jest.fn(),
  },
  beneficiaryAssignment: {
    upsert: jest.fn(),
  },
  milestone: {
    create: jest.fn(),
    deleteMany: jest.fn(),
  },
  organization: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
  },
  user: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
  },
  $transaction: jest.fn().mockImplementation(async (cb) => {
    if (typeof cb === 'function') {
      return cb(prismaMock);
    }
    return Promise.all(cb);
  }),
  $queryRaw: jest.fn(),
};

export default prismaMock;

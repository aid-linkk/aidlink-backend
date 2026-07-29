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
    findUniqueOrThrow: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
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
    groupBy: jest.fn().mockResolvedValue([]),
  },
  taxReceipt: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    count: jest.fn(),
  },
  receiptBatchJob: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    count: jest.fn(),
  },
  beneficiaryAssignment: {
    upsert: jest.fn(),
     count: jest.fn().mockResolvedValue(0),
  },

  campaignHourlyStat: {
    findMany: jest.fn().mockResolvedValue([]),
    upsert: jest.fn(),
  },
  campaignMonthlyStat: {
    findMany: jest.fn().mockResolvedValue([]),
    upsert: jest.fn(),
  },
  campaignTrending: {
    findMany: jest.fn().mockResolvedValue([]),
    upsert: jest.fn(),
    deleteMany: jest.fn(),
  },
  rollupTracker: {
    findUnique: jest.fn(),
    upsert: jest.fn(),
  },
  
  milestone: {
    create: jest.fn(),
    update: jest.fn(),
    deleteMany: jest.fn(),
  },
  webhookSubscription: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    count: jest.fn(),
  },
  webhookEvent: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    count: jest.fn(),
  },
  webhookDeliveryAttempt: {
    create: jest.fn(),
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
    create: jest.fn(),
    update: jest.fn(),
  },
  verificationLog: {
    create: jest.fn(),
    findMany: jest.fn(),
  },
  session: {
    create: jest.fn(),
    findUnique: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    deleteMany: jest.fn(),
  },
  privacySettings: {
    findUnique: jest.fn(),
    upsert: jest.fn(),
  },
  auditLog: {
    create: jest.fn().mockResolvedValue({}),
    findMany: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(0),
  },
  notification: {
    create: jest.fn().mockResolvedValue({}),
    findMany: jest.fn().mockResolvedValue([]),
  },
  recoveryCase: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    count: jest.fn().mockResolvedValue(0),
    groupBy: jest.fn().mockResolvedValue([]),
  },
  donorCredit: {
    create: jest.fn(),
    findMany: jest.fn().mockResolvedValue([]),
    aggregate: jest.fn().mockResolvedValue({ _sum: { amount: 0 }, _count: { id: 0 } }),
  },
  blockchainTransaction: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
  },
  contractEvent: {
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

export const poolSettings = {
  connectionLimit: 10,
  poolTimeoutSeconds: 10,
  connectTimeoutSeconds: 10,
  socketTimeoutSeconds: 0,
};

export const databaseMetrics = {
  recordQuery: jest.fn(),
  recordConnectionEvent: jest.fn(),
  isSlow: jest.fn().mockReturnValue(false),
  getSlowQueryThresholdMs: jest.fn().mockReturnValue(500),
  snapshot: jest.fn().mockReturnValue({}),
  reset: jest.fn(),
};

export const connectDatabase = jest.fn().mockResolvedValue(undefined);
export const disconnectDatabase = jest.fn().mockResolvedValue(undefined);
export const startPoolMonitoring = jest.fn();
export const stopPoolMonitoring = jest.fn();
export const getPoolStats = jest.fn().mockResolvedValue({
  open: 0,
  busy: 0,
  idle: 0,
  waiting: 0,
  limit: 10,
  utilization: 0,
  available: false,
});
export const checkDatabaseHealth = jest.fn().mockResolvedValue({
  status: 'healthy',
  latencyMs: 1,
  pool: { open: 0, busy: 0, idle: 0, waiting: 0, limit: 10, utilization: 0, available: false },
  queries: { total: 0, errors: 0, slow: 0, errorRate: 0, p95LatencyMs: 0 },
});

export default prismaMock;

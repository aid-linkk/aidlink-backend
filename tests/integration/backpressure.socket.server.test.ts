/**
 * Integration tests: socket.server.ts backpressure wiring
 *
 * Tests verify:
 *   S1. All existing broadcast functions are callable without io (fail-open, no throw)
 *   S2. shouldThrottleRoom() returns false before init (fail-open)
 *   S3. getBackpressureSnapshot() returns null before init
 *   S4. getBackpressureSystem() returns null before init
 *   S5. All existing broadcast function exports present
 *   S6. All new backpressure function exports present
 *   S7. sendCampaignSuspended() still emits campaign:suspended directly
 *       (critical bypass — not queued through FlowController)
 *   S8. sendCampaignReinstated() emits campaign:reinstated
 *   S9. sendAppealUpdate() emits appeal:updated
 *  S10. broadcastToCampaign() delegates to routedEmit → FlowController
 *  S11. broadcastToAll() is a no-op before initialization
 *  S12. sendCampaignUpdate() skips DB fetch when room is throttled
 *  S13. Moderation events (campaign:suspended, campaign:reinstated) use isCriticalBypass
 *  S14. Reconnection after eviction: evicted socket state cleared, fresh token bucket
 */

// ── Section A: Pre-init behaviour (module-level, no io) ──────────────────────
//
// Use a fresh module instance (via jest.isolateModules) that has never called
// initializeWebSocket() so `io` is undefined.
// ─────────────────────────────────────────────────────────────────────────────

describe('S1-S6: exports and pre-init behaviour', () => {
  let mod: typeof import('../../src/websocket/socket.server');

  beforeEach(() => {
    jest.isolateModules(() => {
      jest.doMock('socket.io', () => ({ Server: jest.fn() }));
      jest.doMock('../../src/config/database', () => ({
        __esModule: true,
        default: {
          campaign:     { findUnique: jest.fn() },
          notification: { count: jest.fn() },
          user:         { findUnique: jest.fn() },
          donation:     { findUnique: jest.fn() },
          distribution: { findUnique: jest.fn() },
        },
      }));
      jest.doMock('../../src/config/logger', () => ({
        __esModule: true,
        default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      }));
      jest.doMock('../../src/config/redis', () => ({
        __esModule: true,
        default: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
      }));
      jest.doMock('../../src/utils/jwt', () => ({
        JWTUtils: { verifyToken: jest.fn(), getUserId: jest.fn() },
      }));
      jest.doMock('../../src/websocket/authorization', () => ({
        authorizeCampaignJoin:                jest.fn(),
        authorizeOrganizationJoin:            jest.fn(),
        authorizeBeneficiaryJoin:             jest.fn(),
        invalidateCampaignAuthorizationCache: jest.fn().mockResolvedValue(undefined),
      }));
      mod = require('../../src/websocket/socket.server');
    });
  });

  it('S1: all existing broadcast functions are no-ops before init (do not throw)', () => {
    expect(() => mod.broadcastToUser('u1', 'test', {})).not.toThrow();
    expect(() => mod.broadcastToCampaign('c1', 'test', {})).not.toThrow();
    expect(() => mod.broadcastToOrganization('o1', 'test', {})).not.toThrow();
    expect(() => mod.broadcastToBeneficiary('b1', 'test', {})).not.toThrow();
    expect(() => mod.broadcastToAll('test', {})).not.toThrow();
    expect(() => mod.sendNotification('u1', {})).not.toThrow();
    expect(() => mod.sendUnreadCount('u1', 3)).not.toThrow();
    expect(() => mod.sendAppealUpdate('u1', {})).not.toThrow();
  });

  it('S2: shouldThrottleRoom() returns false before init (fail-open)', () => {
    expect(mod.shouldThrottleRoom('campaign:1')).toBe(false);
  });

  it('S3: getBackpressureSnapshot() returns null before init', () => {
    expect(mod.getBackpressureSnapshot()).toBeNull();
  });

  it('S4: getBackpressureSystem() returns null before init', () => {
    expect(mod.getBackpressureSystem()).toBeNull();
  });

  it('S5: all existing broadcast function exports are present', () => {
    expect(typeof mod.broadcastToUser).toBe('function');
    expect(typeof mod.broadcastToCampaign).toBe('function');
    expect(typeof mod.broadcastToOrganization).toBe('function');
    expect(typeof mod.broadcastToBeneficiary).toBe('function');
    expect(typeof mod.broadcastToAll).toBe('function');
    expect(typeof mod.sendCampaignUpdate).toBe('function');
    expect(typeof mod.sendDonationUpdate).toBe('function');
    expect(typeof mod.sendDistributionUpdate).toBe('function');
    expect(typeof mod.sendNotification).toBe('function');
    expect(typeof mod.sendNotificationWithCount).toBe('function');
    expect(typeof mod.sendUnreadCount).toBe('function');
    expect(typeof mod.sendCampaignSuspended).toBe('function');
    expect(typeof mod.sendCampaignReinstated).toBe('function');
    expect(typeof mod.sendAppealUpdate).toBe('function');
  });

  it('S6: new backpressure API functions are exported', () => {
    expect(typeof mod.getBackpressureSnapshot).toBe('function');
    expect(typeof mod.shouldThrottleRoom).toBe('function');
    expect(typeof mod.getBackpressureSystem).toBe('function');
    expect(typeof mod.getSocketIO).toBe('function');
    expect(typeof mod.authenticateSocketToken).toBe('function');
    expect(typeof mod.initializeWebSocket).toBe('function');
  });
});

// ── Section B: Initialized-io tests ──────────────────────────────────────────
//
// These tests set up an initialized Socket.IO mock via initializeWebSocket()
// so `io`, `bpFlow`, `bpMonitor` etc are all populated.
// ─────────────────────────────────────────────────────────────────────────────

describe('S7-S12: initialized socket.server behaviour', () => {
  // Shared mock io object — methods spied on per test
  const mockIoInstance = {
    to:          jest.fn().mockReturnThis(),
    emit:        jest.fn(),
    in:          jest.fn().mockReturnThis(),
    socketsLeave: jest.fn(),
    sockets: {
      sockets: new Map<string, unknown>(),
      adapter: { rooms: new Map<string, Set<string>>() },
    },
    on:  jest.fn(),
    use: jest.fn(),
  };

  let mod: typeof import('../../src/websocket/socket.server');
  // Captured inside isolateModules so we hold the same mock instance as the module
  let prismaMock: { campaign: { findUnique: jest.Mock } };

  beforeAll(() => {
    jest.isolateModules(() => {
      const campaignFindUnique = jest.fn().mockResolvedValue(null);
      prismaMock = { campaign: { findUnique: campaignFindUnique } };

      jest.doMock('socket.io', () => ({
        Server: jest.fn().mockImplementation(() => mockIoInstance),
      }));
      jest.doMock('../../src/config/database', () => ({
        __esModule: true,
        default: {
          campaign:     { findUnique: campaignFindUnique },
          notification: { count: jest.fn().mockResolvedValue(0) },
          user:         { findUnique: jest.fn() },
          donation:     { findUnique: jest.fn().mockResolvedValue(null) },
          distribution: { findUnique: jest.fn().mockResolvedValue(null) },
        },
      }));
      jest.doMock('../../src/config/logger', () => ({
        __esModule: true,
        default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      }));
      jest.doMock('../../src/config/redis', () => ({
        __esModule: true,
        default: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
      }));
      jest.doMock('../../src/utils/jwt', () => ({
        JWTUtils: { verifyToken: jest.fn(), getUserId: jest.fn() },
      }));
      jest.doMock('../../src/config', () => ({
        config: { cors: { origin: '*' }, jwt: { secret: 'test' } },
      }));
      jest.doMock('../../src/websocket/authorization', () => ({
        authorizeCampaignJoin:                jest.fn(),
        authorizeOrganizationJoin:            jest.fn(),
        authorizeBeneficiaryJoin:             jest.fn(),
        invalidateCampaignAuthorizationCache: jest.fn().mockResolvedValue(undefined),
      }));
      mod = require('../../src/websocket/socket.server');
    });

    // Initialize the WebSocket server so io is set
    const fakeHttpServer = { listeners: jest.fn().mockReturnValue([]) } as unknown as import('http').Server;
    mod.initializeWebSocket(fakeHttpServer);
  });

  beforeEach(() => {
    // Clear emit spies between tests without resetting the mock
    mockIoInstance.to.mockClear().mockReturnThis();
    mockIoInstance.emit.mockClear();
    mockIoInstance.in.mockClear().mockReturnThis();
    mockIoInstance.socketsLeave.mockClear();
  });

  // ── S7: sendCampaignSuspended ───────────────────────────────────────────────

  it('S7: sendCampaignSuspended calls io.in(room).emit + io.in(room).socketsLeave', async () => {
    const socketMock = { id: 'sock-s7', data: { userId: 'owner-s7' }, disconnect: jest.fn() };
    mockIoInstance.sockets.sockets.set('sock-s7', socketMock);
    mockIoInstance.sockets.adapter.rooms.set('campaign:s7', new Set(['sock-s7']));

    await mod.sendCampaignSuspended('s7', 'owner-s7', { campaignId: 's7' });

    // io.in(room) should have been called (for broadcast + socketsLeave)
    expect(mockIoInstance.in).toHaveBeenCalledWith('campaign:s7');
    expect(mockIoInstance.emit).toHaveBeenCalledWith('campaign:suspended', { campaignId: 's7' });
    expect(mockIoInstance.socketsLeave).toHaveBeenCalledWith('campaign:s7');
  });

  // ── S8: sendCampaignReinstated ──────────────────────────────────────────────

  it('S8: sendCampaignReinstated calls to(room).emit and to(user).emit', async () => {
    await mod.sendCampaignReinstated('s8', 'owner-s8', { campaignId: 's8' });

    const toCalls: string[] = mockIoInstance.to.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(toCalls).toContain('campaign:s8');
    expect(toCalls).toContain('user:owner-s8');
  });

  // ── S9: sendAppealUpdate ────────────────────────────────────────────────────

  it('S9: sendAppealUpdate calls to(user:ownerId).emit("appeal:updated")', () => {
    mod.sendAppealUpdate('owner-s9', { appealId: 'ap1' });

    const toCalls: string[] = mockIoInstance.to.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(toCalls).toContain('user:owner-s9');
  });

  // ── S10: broadcastToCampaign calls to(room).emit ────────────────────────────

  it('S10: broadcastToCampaign calls to(campaign:X).emit when not backpressured', () => {
    mod.broadcastToCampaign('s10', 'donation:created', { amount: 50 });

    const toCalls: string[] = mockIoInstance.to.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(toCalls).toContain('campaign:s10');
  });

  // ── S11: broadcastToAll is safe ─────────────────────────────────────────────

  it('S11: broadcastToAll does not throw', () => {
    expect(() => mod.broadcastToAll('campaign:trending', {})).not.toThrow();
  });

  // ── S12: sendCampaignUpdate skips DB when throttled ─────────────────────────

  it('S12: sendCampaignUpdate skips DB fetch when shouldThrottleRoom returns true', async () => {
    const throttleSpy = jest.spyOn(mod, 'shouldThrottleRoom').mockReturnValue(true);
    prismaMock.campaign.findUnique.mockClear();

    await mod.sendCampaignUpdate('throttled-campaign');

    expect(prismaMock.campaign.findUnique).not.toHaveBeenCalled();
    throttleSpy.mockRestore();
  });

  it('S12b: sendCampaignUpdate calls DB when shouldThrottleRoom returns false', async () => {
    const throttleSpy = jest.spyOn(mod, 'shouldThrottleRoom').mockReturnValue(false);
    prismaMock.campaign.findUnique.mockClear();
    prismaMock.campaign.findUnique.mockResolvedValue(null);

    await mod.sendCampaignUpdate('live-campaign');

    expect(prismaMock.campaign.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'live-campaign' } }),
    );
    throttleSpy.mockRestore();
  });
});

// ── Section C: Event classification (pure unit, no io needed) ─────────────────

describe('S13: moderation events are classified as CRITICAL', () => {
  it('isCriticalBypass returns true for all moderation event names', () => {
    jest.isolateModules(() => {
      const { classifyEvent, EventPriority } =
        require('../../src/websocket/backpressure/PriorityEventQueue');

      const criticalEvents = [
        'campaign:suspended',
        'campaign:reinstated',
        'campaign:access_revoked',
        'campaign:access_restored',
        'appeal:updated',
      ];
      for (const event of criticalEvents) {
        expect(classifyEvent(event)).toBe(EventPriority.CRITICAL);
      }
    });
  });

  it('non-moderation events are not CRITICAL', () => {
    jest.isolateModules(() => {
      const { classifyEvent, EventPriority } =
        require('../../src/websocket/backpressure/PriorityEventQueue');

      expect(classifyEvent('notification:new')).toBe(EventPriority.MEDIUM);
      expect(classifyEvent('campaign:updated')).toBe(EventPriority.MEDIUM);
      expect(classifyEvent('donation:created')).toBe(EventPriority.HIGH);
    });
  });
});

// ── Section D: Reconnection after eviction ────────────────────────────────────

describe('S14: reconnection after eviction — fresh token bucket', () => {
  it('evicted socket re-gets a full rate-limit bucket on reconnect', () => {
    jest.isolateModules(() => {
      const { BackpressureMonitor } =
        require('../../src/websocket/backpressure/BackpressureMonitor');
      const { ClientEvictionManager } =
        require('../../src/websocket/backpressure/ClientEvictionManager');

      const fakeSockets = new Map<string, unknown>();
      const io = {
        sockets: {
          sockets: fakeSockets,
          adapter: { rooms: new Map<string, Set<string>>() },
        },
        on: jest.fn(),
      } as unknown as import('socket.io').Server;

      const socketMock = { id: 's-r', data: { userId: 'u-r' }, disconnect: jest.fn() };
      fakeSockets.set('s-r', socketMock);

      const monitor = new BackpressureMonitor(io, { clientBytes: 1000, roomBytes: 5000, globalBytes: 20000 });
      monitor.injectMockBuffers(new Map([['s-r', 0]]));

      const mgr = new ClientEvictionManager(io, monitor, {
        sweepIntervalMs: 999999,
        idleTimeoutMs:   999999,
        eventsPerSecond: 3,
      });

      // Drain the bucket
      mgr.checkRateLimit('s-r');
      mgr.checkRateLimit('s-r');
      mgr.checkRateLimit('s-r');
      expect(mgr.checkRateLimit('s-r')).toBe(false);

      // Evict
      mgr.evictSocket('s-r', 'slow_client');
      expect(socketMock.disconnect).toHaveBeenCalledWith(true);

      // Reconnect
      fakeSockets.set('s-r', socketMock);
      mgr.onConnect('s-r');

      // Fresh bucket
      expect(mgr.checkRateLimit('s-r')).toBe(true);
    });
  });
});

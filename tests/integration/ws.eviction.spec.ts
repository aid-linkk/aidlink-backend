/**
 * Integration tests for WebSocket campaign room eviction and authorization.
 *
 * Covers acceptance criteria:
 *  AC1 — sendCampaignSuspended() broadcasts campaign:suspended BEFORE socketsLeave.
 *  AC2 — Client joins campaign:X, admin suspends X, client receives campaign:suspended,
 *         client is no longer in the room (verified by a subsequent broadcast not reaching them).
 *  AC3 — Client that was in campaign X before suspension attempts to re-join after
 *         reconnect, receives room:join_error (campaign is SUSPENDED → forbidden).
 *  AC4 — 50 concurrent sockets call join_campaign for the same campaign within 100ms
 *         — exactly 1 database query is issued for authorization.
 *  AC5 — sendCampaignSuspended() emits campaign:access_revoked to each evicted socket's
 *         personal user:{userId} room with { campaignId, reason: 'suspended' }.
 *  AC6 — After sendCampaignReinstated(), a client receives campaign:access_restored and
 *         can successfully re-join the room via join_campaign.
 *  AC7 — campaignRowInFlight Map is cleared after each resolution (no memory leak).
 *
 * Test strategy:
 *  - Real in-process Socket.IO server + socket.io-client (no external process).
 *  - Prisma and Redis are mocked via jest.mock; no real DB/Redis required.
 *  - JWTUtils is mocked to return the token string as the userId.
 */

import { createServer, Server as HTTPServer } from 'http';
import { AddressInfo } from 'net';
import { Server as IOServer } from 'socket.io';
import Client, { Socket as WSClient } from 'socket.io-client';
import { Role, CampaignStatus } from '@prisma/client';

// ── Mock infrastructure (must come before importing source modules) ─────────

jest.mock('../../src/config/database', () => ({
  __esModule: true,
  default: {
    user: { findUnique: jest.fn() },
    campaign: { findUnique: jest.fn() },
    organization: { findUnique: jest.fn() },
    beneficiary: { findUnique: jest.fn() },
    beneficiaryAssignment: { findFirst: jest.fn() },
    notification: { count: jest.fn() },
  },
}));

jest.mock('../../src/config/redis', () => ({
  __esModule: true,
  default: {
    get: jest.fn(),
    setex: jest.fn(),
    del: jest.fn(),
    scanStream: jest.fn(),
  },
}));

jest.mock('../../src/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));

jest.mock('../../src/config', () => ({
  config: { cors: { origin: '*' }, jwt: { secret: 'test-secret' } },
}));

// JWTUtils: treat the raw token string as the userId
jest.mock('../../src/utils/jwt', () => ({
  JWTUtils: {
    verifyToken: jest.fn(),
    getUserId: jest.fn(),
  },
}));

// ── Source imports (after mocks) ───────────────────────────────────────────

import {
  initializeWebSocket,
  sendCampaignSuspended,
  sendCampaignReinstated,
} from '../../src/websocket/socket.server';
import {
  authorizeCampaignJoin,
  AuthorizationContext,
} from '../../src/websocket/authorization';

const prismaMock = require('../../src/config/database').default;
const redisMock = require('../../src/config/redis').default;
const { JWTUtils } = require('../../src/utils/jwt');

// ── Helpers ────────────────────────────────────────────────────────────────

function waitForEvent<T = any>(socket: WSClient, event: string, timeoutMs = 4000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out waiting for "${event}"`)),
      timeoutMs
    );
    socket.once(event, (data: T) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

function waitForConnect(socket: WSClient, timeoutMs = 4000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (socket.connected) return resolve();
    const timer = setTimeout(
      () => reject(new Error('Timed out waiting for socket connect')),
      timeoutMs
    );
    socket.once('connect', () => { clearTimeout(timer); resolve(); });
    socket.once('connect_error', (err: Error) => { clearTimeout(timer); reject(err); });
  });
}

/** Create a disconnected client; call .connect() to connect */
function makeClient(port: number, userId: string): WSClient {
  return Client(`http://localhost:${port}`, {
    auth: { token: userId },
    forceNew: true,
    autoConnect: false,
  });
}

// ── Test suite ─────────────────────────────────────────────────────────────

describe('WebSocket campaign room eviction', () => {
  let httpServer: HTTPServer;
  let io: IOServer;
  let port: number;

  beforeAll((done) => {
    httpServer = createServer();
    io = initializeWebSocket(httpServer);
    httpServer.listen(0, () => {
      port = (httpServer.address() as AddressInfo).port;
      done();
    });
  });

  afterAll(async () => {
    await io.close();
    await new Promise<void>((r) => httpServer.close(() => r()));
  });

  beforeEach(() => {
    // With resetMocks:true in jest.config.js, all mock implementations are
    // cleared between tests. Re-establish defaults here.

    // JWTUtils: token string IS the userId
    JWTUtils.verifyToken.mockImplementation((token: string) => ({
      id: token,
      role: Role.DONOR,
    }));
    JWTUtils.getUserId.mockImplementation((payload: any) => payload.id);

    // User lookup: return a user whose id matches the token
    prismaMock.user.findUnique.mockImplementation((args: any) =>
      Promise.resolve({ id: args.where.id, role: Role.DONOR })
    );

    // Campaign: ACTIVE by default
    prismaMock.campaign.findUnique.mockResolvedValue({
      userId: 'owner-default',
      status: CampaignStatus.ACTIVE,
    });

    // Notification count
    prismaMock.notification.count.mockResolvedValue(0);

    // Redis: cache always cold (miss) by default
    redisMock.get.mockResolvedValue(null);
    redisMock.setex.mockResolvedValue('OK');
    redisMock.del.mockResolvedValue(1);
    redisMock.scanStream.mockReturnValue(
      (async function* () { yield [] as string[]; })()
    );
  });

  // ── AC2 ─────────────────────────────────────────────────────────────────
  it('AC2: client receives campaign:suspended then is evicted from the room', async () => {
    const userId = 'user-ac2';
    const campaignId = 'campaign-ac2';

    const client = makeClient(port, userId);
    client.connect();
    await waitForConnect(client);

    client.emit('join_campaign', campaignId);
    await new Promise((r) => setTimeout(r, 100));

    // Verify socket is in the room
    const roomBefore = io.sockets.adapter.rooms.get(`campaign:${campaignId}`);
    expect(roomBefore?.size).toBeGreaterThan(0);

    // Listen for the suspension event
    const suspendedPromise = waitForEvent(client, 'campaign:suspended');

    await sendCampaignSuspended(campaignId, 'owner-1', { campaignId });

    // Must receive the event
    const received = await suspendedPromise;
    expect(received).toMatchObject({ campaignId });

    // Give socketsLeave a tick to complete
    await new Promise((r) => setTimeout(r, 50));

    // Room must now be empty
    const roomAfter = io.sockets.adapter.rooms.get(`campaign:${campaignId}`);
    expect(roomAfter?.size ?? 0).toBe(0);

    // Subsequent broadcast must NOT reach the evicted client
    let gotStaleEvent = false;
    client.once('test:post_suspend', () => { gotStaleEvent = true; });
    io.to(`campaign:${campaignId}`).emit('test:post_suspend', {});
    await new Promise((r) => setTimeout(r, 100));
    expect(gotStaleEvent).toBe(false);

    client.disconnect();
  }, 8000);

  // ── AC1 — ordering: suspended emitted before socketsLeave ─────────────────
  it('AC1: campaign:suspended is delivered to client before socket is removed from room', async () => {
    const userId = 'user-ac1';
    const campaignId = 'campaign-ac1';

    const client = makeClient(port, userId);
    client.connect();
    await waitForConnect(client);
    client.emit('join_campaign', campaignId);
    await new Promise((r) => setTimeout(r, 100));

    const suspendedPromise = waitForEvent(client, 'campaign:suspended');

    await sendCampaignSuspended(campaignId, 'owner-1', { campaignId });

    // If the event arrives, it was emitted before eviction (ordering guarantee)
    const payload = await suspendedPromise;
    expect(payload).toMatchObject({ campaignId });

    client.disconnect();
  }, 8000);

  // ── AC5 — campaign:access_revoked sent to user room ─────────────────────
  it('AC5: campaign:access_revoked is emitted to each evicted socket user room', async () => {
    const userId = 'user-ac5';
    const campaignId = 'campaign-ac5';

    const client = makeClient(port, userId);
    client.connect();
    await waitForConnect(client);
    client.emit('join_campaign', campaignId);
    await new Promise((r) => setTimeout(r, 100));

    const revokedPromise = waitForEvent(client, 'campaign:access_revoked');

    await sendCampaignSuspended(campaignId, 'owner-1', { campaignId });

    const payload = await revokedPromise;
    expect(payload).toEqual({ campaignId, reason: 'suspended' });

    client.disconnect();
  }, 8000);

  // ── AC3 — re-join after suspension is denied ─────────────────────────────
  it('AC3: client that reconnects after suspension is denied re-entry', async () => {
    const userId = 'user-ac3';
    const campaignId = 'campaign-ac3';

    const client = makeClient(port, userId);
    client.connect();
    await waitForConnect(client);
    client.emit('join_campaign', campaignId);
    await new Promise((r) => setTimeout(r, 100));

    // Suspend campaign
    await sendCampaignSuspended(campaignId, 'owner-1', { campaignId });
    await new Promise((r) => setTimeout(r, 50));

    // Now campaign is SUSPENDED
    prismaMock.campaign.findUnique.mockResolvedValue({
      userId: 'owner-1',
      status: CampaignStatus.SUSPENDED,
    });
    redisMock.get.mockResolvedValue(null); // cache cold after invalidation

    const joinErrorPromise = waitForEvent<{ room: string; reason: string }>(
      client,
      'room:join_error'
    );

    client.emit('join_campaign', campaignId);

    const joinError = await joinErrorPromise;
    expect(joinError.room).toBe(`campaign:${campaignId}`);
    // SUSPENDED status is neither ACTIVE nor COMPLETED → forbidden
    expect(joinError.reason).toBe('forbidden');

    client.disconnect();
  }, 8000);

  // ── AC6 — re-join succeeds after reinstatement ───────────────────────────
  it('AC6: client receives campaign:access_restored after reinstatement and can re-join', async () => {
    const ownerId = 'owner-ac6';
    const campaignId = 'campaign-ac6';

    prismaMock.user.findUnique.mockImplementation((args: any) =>
      Promise.resolve({ id: args.where.id, role: Role.ORGANIZATION })
    );
    prismaMock.campaign.findUnique.mockResolvedValue({
      userId: ownerId,
      status: CampaignStatus.ACTIVE,
    });

    const ownerClient = makeClient(port, ownerId);
    ownerClient.connect();
    await waitForConnect(ownerClient);
    ownerClient.emit('join_campaign', campaignId);
    await new Promise((r) => setTimeout(r, 100));

    // Suspend
    await sendCampaignSuspended(campaignId, ownerId, { campaignId });
    await new Promise((r) => setTimeout(r, 50));

    // Reinstate — campaign back to ACTIVE
    prismaMock.campaign.findUnique.mockResolvedValue({
      userId: ownerId,
      status: CampaignStatus.ACTIVE,
    });
    redisMock.get.mockResolvedValue(null);

    const accessRestoredPromise = waitForEvent(ownerClient, 'campaign:access_restored');

    await sendCampaignReinstated(campaignId, ownerId, { campaignId });

    const restored = await accessRestoredPromise;
    expect(restored).toMatchObject({ campaignId, reason: 'reinstated' });

    // Re-join should succeed (no join error within 500ms)
    const rejoinResult = await new Promise<'ok' | 'error'>((resolve) => {
      const timer = setTimeout(() => resolve('ok'), 500);
      ownerClient.once('room:join_error', () => {
        clearTimeout(timer);
        resolve('error');
      });
      ownerClient.emit('join_campaign', campaignId);
    });
    expect(rejoinResult).toBe('ok');

    // Room should now contain the owner's socket
    await new Promise((r) => setTimeout(r, 50));
    const room = io.sockets.adapter.rooms.get(`campaign:${campaignId}`);
    expect(room?.size).toBeGreaterThan(0);

    ownerClient.disconnect();
  }, 10000);

  // ── AC4 — singleflight: 50 concurrent calls → 1 DB query ─────────────────
  it('AC4: 50 concurrent authorizeCampaignJoin calls for same campaign issue exactly 1 DB query', async () => {
    const campaignId = 'campaign-coalesce';
    let dbCallCount = 0;

    // Add a delay so all 50 concurrent calls are in-flight simultaneously
    prismaMock.campaign.findUnique.mockImplementation(() => {
      dbCallCount++;
      return new Promise((resolve) =>
        setTimeout(
          () => resolve({ userId: 'owner-1', status: CampaignStatus.ACTIVE }),
          50
        )
      );
    });

    redisMock.get.mockResolvedValue(null);  // cache cold
    redisMock.setex.mockResolvedValue('OK');

    const context: AuthorizationContext = {
      userId: 'user-coalesce',
      userRole: Role.DONOR,
    };

    const results = await Promise.all(
      Array.from({ length: 50 }, () => authorizeCampaignJoin(context, campaignId))
    );

    expect(results.every((r) => r.authorized)).toBe(true);
    expect(dbCallCount).toBe(1);
  }, 10000);

  // ── AC7 — campaignRowInFlight cleared after resolution ───────────────────
  it('AC7: campaignRowInFlight Map is empty after query resolves (no memory leak)', async () => {
    const campaignId = 'campaign-cleanup';

    // Track how many times prisma is called
    let callCount = 0;
    prismaMock.campaign.findUnique.mockImplementation(() => {
      callCount++;
      return Promise.resolve({ userId: 'owner-1', status: CampaignStatus.ACTIVE });
    });
    redisMock.get.mockResolvedValue(null);
    redisMock.setex.mockResolvedValue('OK');

    const context: AuthorizationContext = { userId: 'user-cleanup', userRole: Role.DONOR };

    // Two concurrent calls — should coalesce to 1 DB call
    const [r1, r2] = await Promise.all([
      authorizeCampaignJoin(context, campaignId),
      authorizeCampaignJoin(context, campaignId),
    ]);
    expect(r1.authorized).toBe(true);
    expect(r2.authorized).toBe(true);
    expect(callCount).toBe(1);

    // After resolution the in-flight Map is cleared.
    // Verify by making a new independent call — it should hit the DB again
    // (because the singleflight entry was removed by .finally()).
    // Reset Redis cache so it doesn't short-circuit via the cache hit.
    redisMock.get.mockResolvedValue(null);

    const callsBefore = callCount;
    await authorizeCampaignJoin(context, campaignId);
    // A fresh call after the Map entry is gone must issue a new DB query.
    // (If the Map entry were NOT cleared, this call would return the
    // already-resolved Promise — which is impossible since it's already
    // settled, so a new Promise would need to be created regardless.
    // The important invariant is: callCount increments, not stays at 1.)
    expect(callCount).toBeGreaterThan(callsBefore);
  }, 8000);

  // ── Ordering guarantee (explicit) ────────────────────────────────────────
  it('campaign:suspended broadcast reaches the client before the socket leaves the room', async () => {
    const userId = 'user-order';
    const campaignId = 'campaign-order';

    const client = makeClient(port, userId);
    client.connect();
    await waitForConnect(client);
    client.emit('join_campaign', campaignId);
    await new Promise((r) => setTimeout(r, 100));

    let received = false;
    client.once('campaign:suspended', () => { received = true; });

    await sendCampaignSuspended(campaignId, 'owner-1', { campaignId });
    await new Promise((r) => setTimeout(r, 150));

    expect(received).toBe(true);

    client.disconnect();
  }, 8000);
});

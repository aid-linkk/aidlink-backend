import { createServer } from 'http';
import { AddressInfo } from 'net';
import express from 'express';
import { Server as IOServer } from 'socket.io';
import Client, { Socket as WSClient } from 'socket.io-client';
import jwt from 'jsonwebtoken';
import { attachSocketAuth } from '../../src/websocket/ws-auth';

const JWT_SECRET = 'test_jwt_secret';

describe('WebSocket auth', () => {
  let io: IOServer;
  let server: any;
  let port: number;

  beforeAll((done) => {
    process.env.JWT_SECRET = JWT_SECRET;
    const app = express();
    server = createServer(app);
    io = new IOServer(server, { path: '/socket.io' });
    attachSocketAuth(io);

    io.on('connection', (socket) => {
      socket.on('echo', (msg) => socket.emit('echo', { received: msg, id: (socket as any).auth.id }));
    });

    server.listen(0, () => {
      port = (server.address() as AddressInfo).port;
      done();
    });
  });

  afterAll(async () => {
    if (io) await io.close();
    if (server) server.close();
  });

  it('accepts valid JWT and echoes with id', (done) => {
    const token = jwt.sign({ id: 'user-123', name: 'tester' }, JWT_SECRET);
    const client: WSClient = Client(`http://localhost:${port}`, { auth: { token } });

    client.on('connect', () => {
      client.emit('echo', 'hello');
    });

    client.on('echo', (payload) => {
      try {
        expect(payload.received).toBe('hello');
        expect(payload.id).toBe('user-123');
        client.close();
        done();
      } catch (err) {
        done(err);
      }
    });

    client.on('connect_error', (err) => done(err));
  }, 10000);

  it('rejects missing or invalid token', (done) => {
    const client: WSClient = Client(`http://localhost:${port}`);
    client.on('connect_error', (err) => {
      expect(err).toBeDefined();
      client.close();
      done();
    });
  });
});

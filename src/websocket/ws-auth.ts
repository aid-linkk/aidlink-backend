import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';

export function attachSocketAuth(io: Server) {
  io.use((socket: Socket, next) => {
    // Read JWT_SECRET at request time so that test suites can override
    // process.env.JWT_SECRET in beforeAll() after module load.
    const JWT_SECRET = process.env.JWT_SECRET || 'your_super_secret_jwt_key_change_in_production';
    const token = socket.handshake.auth?.token || socket.handshake.headers['authorization'] as string | undefined;
    const bearer = typeof token === 'string' && token.startsWith('Bearer ') ? token.slice('Bearer '.length) : token;
    if (!bearer) return next(new Error('Missing token'));

    try {
      const payload = jwt.verify(bearer, JWT_SECRET) as any;
      if (!payload || !payload.id) return next(new Error('Invalid token payload'));
      // attach canonical id to socket
      (socket as any).auth = { id: payload.id, ...(payload as object) };
      return next();
    } catch (err) {
      return next(new Error('Invalid token'));
    }
  });
}

import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import { jwtAuth } from '../../src/middleware/auth.middleware';

const JWT_SECRET = 'test_jwt_secret';

describe('HTTP JWT auth middleware', () => {
  let app: express.Express;

  beforeAll(() => {
    process.env.JWT_SECRET = JWT_SECRET;
    app = express();
    app.get('/protected', jwtAuth, (req, res) => {
      res.json({ id: (req as any).auth.id });
    });
  });

  it('allows valid token', async () => {
    const token = jwt.sign({ id: 'u1' }, JWT_SECRET);
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('u1');
  });

  it('rejects missing token', async () => {
    const res = await request(app).get('/protected');
    expect(res.status).toBe(401);
  });
});

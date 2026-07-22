import Redis from 'ioredis';

const redis = new Redis({
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  password: process.env.REDIS_PASSWORD || undefined,
  db: parseInt(process.env.REDIS_DB || '0', 10),
});

export default redis;

export async function setSession(sessionId: string, data: object, ttlSeconds = 3600) {
  await redis.set(`session:${sessionId}`, JSON.stringify(data), 'EX', ttlSeconds);
}

export async function getSession(sessionId: string) {
  const raw = await redis.get(`session:${sessionId}`);
  return raw ? JSON.parse(raw) : null;
}

export async function clearSession(sessionId: string) {
  await redis.del(`session:${sessionId}`);
}

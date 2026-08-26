import Redis from 'ioredis';
import { config } from './index';

const redis = new Redis({
  host: config.redis?.host ?? 'localhost',
  port: config.redis?.port ?? 6379,
  password: config.redis?.password,
  db: config.redis?.db ?? 0,
  retryStrategy: (times) => {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
});

redis.on('connect', () => {
  console.log('Redis connected successfully');
});

redis.on('error', (error) => {
  console.error('Redis connection error:', error);
});

export default redis;

export async function connectRedis() {
  try {
    await redis.connect();
    console.log('Redis connected successfully');
  } catch (error) {
    console.error('Redis connection failed:', error);
    process.exit(1);
  }
}

export async function disconnectRedis() {
  await redis.quit();
  console.log('Redis disconnected');
}

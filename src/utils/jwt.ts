import jwt from 'jsonwebtoken';
import type { StringValue } from 'ms';
import { config } from '../config';
import { JWTPayload } from '../types';

export class JWTUtils {
  static generateAccessToken(payload: JWTPayload): string {
    return jwt.sign(payload, config.jwt.secret, {
      // config values ("15m", "7d") are valid ms strings; cast required because
      // @types/jsonwebtoken uses the branded ms.StringValue type for expiresIn.
      expiresIn: config.jwt.accessExpiry as StringValue,
    });
  }

  static generateRefreshToken(payload: JWTPayload): string {
    return jwt.sign(payload, config.jwt.secret, {
      expiresIn: config.jwt.refreshExpiry as StringValue,
    });
  }

  static verifyToken(token: string): JWTPayload {
    try {
      return jwt.verify(token, config.jwt.secret) as JWTPayload;
    } catch (error) {
      throw new Error('Invalid or expired token');
    }
  }

  static decodeToken(token: string): JWTPayload | null {
    try {
      return jwt.decode(token) as JWTPayload;
    } catch (error) {
      return null;
    }
  }
}

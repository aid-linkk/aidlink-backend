import bcrypt from 'bcryptjs';
import crypto from 'crypto';

export class CryptoUtils {
  static async hashPassword(password: string): Promise<string> {
    const salt = await bcrypt.genSalt(10);
    return bcrypt.hash(password, salt);
  }

  static async comparePassword(password: string, hash: string): Promise<boolean> {
    return bcrypt.compare(password, hash);
  }

  static generateRandomToken(length: number = 32): string {
    return crypto.randomBytes(length).toString('hex');
  }

  /** Generate a URL-safe verification token (32 bytes = 43 base64url chars) */
  static generateVerificationToken(): string {
    return crypto.randomBytes(32).toString('base64url');
  }

  static generateUUID(): string {
    return crypto.randomUUID();
  }

  static sha256(data: string): string {
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  static hmacSha256(data: string, secret: string): string {
    return crypto.createHmac('sha256', secret).update(data).digest('hex');
  }
}

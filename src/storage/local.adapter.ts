import fs from 'fs/promises';
import path from 'path';
import { IStorageAdapter, UploadOptions, UploadResult, PresignedUrlOptions } from './storage.interface';

export class LocalAdapter implements IStorageAdapter {
  private uploadDir: string;
  private baseUrl: string;

  constructor() {
    this.uploadDir = process.env.LOCAL_UPLOAD_DIR || path.join(process.cwd(), 'uploads');
    this.baseUrl =
      process.env.LOCAL_UPLOAD_BASE_URL ||
      `http://localhost:${process.env.PORT || 3000}/uploads`;
  }

  async upload(key: string, buffer: Buffer, _options: UploadOptions): Promise<UploadResult> {
    const filePath = path.join(this.uploadDir, key);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, buffer);
    return { key, url: `${this.baseUrl}/${key}` };
  }

  async delete(key: string): Promise<void> {
    const filePath = path.join(this.uploadDir, key);
    await fs.unlink(filePath).catch(() => {});
  }

  async download(key: string): Promise<Buffer> {
    const filePath = path.join(this.uploadDir, key);
    return fs.readFile(filePath);
  }

  async getSignedUrl(key: string, _expiresIn?: number): Promise<string> {
    return `${this.baseUrl}/${key}`;
  }

  async getPresignedUploadUrl(key: string, _options: PresignedUrlOptions): Promise<string> {
    return `${this.baseUrl}/upload/${key}`;
  }
}

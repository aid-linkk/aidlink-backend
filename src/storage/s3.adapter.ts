import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl as s3GetSignedUrl } from '@aws-sdk/s3-request-presigner';
import { IStorageAdapter, UploadOptions, UploadResult, PresignedUrlOptions } from './storage.interface';

export class S3Adapter implements IStorageAdapter {
  private client: S3Client;
  private bucket: string;
  private baseUrl: string;

  constructor() {
    this.client = new S3Client({
      region: process.env.AWS_REGION || 'us-east-1',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
      },
    });
    this.bucket = process.env.AWS_S3_BUCKET!;
    this.baseUrl =
      process.env.AWS_S3_BASE_URL ||
      `https://${this.bucket}.s3.${process.env.AWS_REGION || 'us-east-1'}.amazonaws.com`;
  }

  async upload(key: string, buffer: Buffer, options: UploadOptions): Promise<UploadResult> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: buffer,
        ContentType: options.contentType,
        Metadata: options.metadata,
      }),
    );
    return { key, url: `${this.baseUrl}/${key}` };
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async download(key: string): Promise<Buffer> {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    const bytes = await response.Body!.transformToByteArray();
    return Buffer.from(bytes);
  }

  async getSignedUrl(key: string, expiresIn = 3600): Promise<string> {
    const command = new GetObjectCommand({ Bucket: this.bucket, Key: key });
    return s3GetSignedUrl(this.client, command, { expiresIn });
  }

  async getPresignedUploadUrl(key: string, options: PresignedUrlOptions): Promise<string> {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: options.contentType,
    });
    return s3GetSignedUrl(this.client, command, { expiresIn: options.expiresIn ?? 3600 });
  }
}

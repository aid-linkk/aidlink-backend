export interface UploadOptions {
  contentType: string;
  metadata?: Record<string, string>;
}

export interface UploadResult {
  key: string;
  url: string;
}

export interface PresignedUrlOptions {
  contentType: string;
  expiresIn?: number;
}

export interface IStorageAdapter {
  upload(key: string, buffer: Buffer, options: UploadOptions): Promise<UploadResult>;
  delete(key: string): Promise<void>;
  download(key: string): Promise<Buffer>;
  getSignedUrl(key: string, expiresIn?: number): Promise<string>;
  getPresignedUploadUrl(key: string, options: PresignedUrlOptions): Promise<string>;
}

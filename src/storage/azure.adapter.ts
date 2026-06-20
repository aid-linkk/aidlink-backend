import {
  BlobServiceClient,
  StorageSharedKeyCredential,
  generateBlobSASQueryParameters,
  BlobSASPermissions,
} from '@azure/storage-blob';
import { IStorageAdapter, UploadOptions, UploadResult, PresignedUrlOptions } from './storage.interface';

export class AzureAdapter implements IStorageAdapter {
  private client: BlobServiceClient;
  private containerName: string;
  private accountName: string;
  private accountKey: string;

  constructor() {
    this.accountName = process.env.AZURE_STORAGE_ACCOUNT_NAME!;
    this.accountKey = process.env.AZURE_STORAGE_ACCOUNT_KEY!;
    this.containerName = process.env.AZURE_STORAGE_CONTAINER!;

    const credential = new StorageSharedKeyCredential(this.accountName, this.accountKey);
    this.client = new BlobServiceClient(
      `https://${this.accountName}.blob.core.windows.net`,
      credential,
    );
  }

  async upload(key: string, buffer: Buffer, options: UploadOptions): Promise<UploadResult> {
    const container = this.client.getContainerClient(this.containerName);
    const blob = container.getBlockBlobClient(key);
    await blob.uploadData(buffer, {
      blobHTTPHeaders: { blobContentType: options.contentType },
      metadata: options.metadata,
    });
    return { key, url: blob.url };
  }

  async delete(key: string): Promise<void> {
    const container = this.client.getContainerClient(this.containerName);
    await container.getBlockBlobClient(key).deleteIfExists();
  }

  async getSignedUrl(key: string, expiresIn = 3600): Promise<string> {
    const credential = new StorageSharedKeyCredential(this.accountName, this.accountKey);
    const expiresOn = new Date(Date.now() + expiresIn * 1000);
    const sas = generateBlobSASQueryParameters(
      {
        containerName: this.containerName,
        blobName: key,
        permissions: BlobSASPermissions.parse('r'),
        expiresOn,
      },
      credential,
    );
    const container = this.client.getContainerClient(this.containerName);
    return `${container.getBlockBlobClient(key).url}?${sas.toString()}`;
  }

  async getPresignedUploadUrl(key: string, options: PresignedUrlOptions): Promise<string> {
    const credential = new StorageSharedKeyCredential(this.accountName, this.accountKey);
    const expiresOn = new Date(Date.now() + (options.expiresIn ?? 3600) * 1000);
    const sas = generateBlobSASQueryParameters(
      {
        containerName: this.containerName,
        blobName: key,
        permissions: BlobSASPermissions.parse('cw'),
        expiresOn,
        contentType: options.contentType,
      },
      credential,
    );
    const container = this.client.getContainerClient(this.containerName);
    return `${container.getBlockBlobClient(key).url}?${sas.toString()}`;
  }
}

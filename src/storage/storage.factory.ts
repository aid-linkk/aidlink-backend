import { IStorageAdapter } from './storage.interface';

export function createStorageAdapter(): IStorageAdapter {
  const provider = process.env.STORAGE_PROVIDER || 'local';

  if (provider === 's3') {
    const { S3Adapter } = require('./s3.adapter');
    return new S3Adapter();
  }

  if (provider === 'azure') {
    const { AzureAdapter } = require('./azure.adapter');
    return new AzureAdapter();
  }

  const { LocalAdapter } = require('./local.adapter');
  return new LocalAdapter();
}

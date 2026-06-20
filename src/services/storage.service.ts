import crypto from 'crypto';
import sharp from 'sharp';
import { IStorageAdapter } from '../storage/storage.interface';
import { createStorageAdapter } from '../storage/storage.factory';
import { AppError } from '../middleware/error';

export type UploadType =
  | 'profile-picture'
  | 'kyc-document'
  | 'campaign-image'
  | 'distribution-proof';

interface ImageOptimization {
  maxWidth: number;
  maxHeight: number;
  generateThumbnail: boolean;
}

interface UploadConfig {
  prefix: string;
  maxSizeBytes: number;
  allowedMimes: Set<string>;
  imageOptimization?: ImageOptimization;
}

const UPLOAD_CONFIGS: Record<UploadType, UploadConfig> = {
  'profile-picture': {
    prefix: 'profile-pictures',
    maxSizeBytes: 5 * 1024 * 1024,
    allowedMimes: new Set(['image/jpeg', 'image/png', 'image/webp']),
    imageOptimization: { maxWidth: 500, maxHeight: 500, generateThumbnail: true },
  },
  'kyc-document': {
    prefix: 'kyc-documents',
    maxSizeBytes: 10 * 1024 * 1024,
    allowedMimes: new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']),
    imageOptimization: { maxWidth: 2000, maxHeight: 2000, generateThumbnail: false },
  },
  'campaign-image': {
    prefix: 'campaign-images',
    maxSizeBytes: 10 * 1024 * 1024,
    allowedMimes: new Set(['image/jpeg', 'image/png', 'image/webp']),
    imageOptimization: { maxWidth: 1200, maxHeight: 800, generateThumbnail: false },
  },
  'distribution-proof': {
    prefix: 'distribution-proofs',
    maxSizeBytes: 20 * 1024 * 1024,
    allowedMimes: new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']),
    imageOptimization: { maxWidth: 2000, maxHeight: 2000, generateThumbnail: false },
  },
};

const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'application/pdf': '.pdf',
};

export interface UploadOutput {
  url: string;
  key: string;
  thumbnailUrl?: string;
  thumbnailKey?: string;
}

export class StorageService {
  private static adapter: IStorageAdapter = createStorageAdapter();

  static setAdapter(adapter: IStorageAdapter): void {
    StorageService.adapter = adapter;
  }

  static detectMimeType(buffer: Buffer): string | null {
    if (buffer.length < 12) return null;

    // JPEG: FF D8 FF
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';

    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47
    )
      return 'image/png';

    // WebP: RIFF????WEBP
    if (
      buffer[0] === 0x52 &&
      buffer[1] === 0x49 &&
      buffer[2] === 0x46 &&
      buffer[3] === 0x46 &&
      buffer[8] === 0x57 &&
      buffer[9] === 0x45 &&
      buffer[10] === 0x42 &&
      buffer[11] === 0x50
    )
      return 'image/webp';

    // PDF: %PDF
    if (
      buffer[0] === 0x25 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x44 &&
      buffer[3] === 0x46
    )
      return 'application/pdf';

    return null;
  }

  static generateKey(prefix: string, mimeType: string): string {
    const ext = MIME_TO_EXT[mimeType] || '.bin';
    const id = crypto.randomUUID();
    return `${prefix}/${id}${ext}`;
  }

  static async upload(
    uploadType: UploadType,
    entityId: string,
    buffer: Buffer,
  ): Promise<UploadOutput> {
    const config = UPLOAD_CONFIGS[uploadType];

    if (buffer.length > config.maxSizeBytes) {
      throw new AppError(
        `File size exceeds the ${Math.round(config.maxSizeBytes / 1024 / 1024)}MB limit`,
        413,
      );
    }

    const detectedMime = StorageService.detectMimeType(buffer);
    if (!detectedMime) {
      throw new AppError('Unsupported or malformed file type', 415);
    }
    if (!config.allowedMimes.has(detectedMime)) {
      throw new AppError(
        `File type ${detectedMime} is not allowed for ${uploadType}`,
        415,
      );
    }

    let uploadBuffer = buffer;
    let outputMime = detectedMime;
    let thumbnailUrl: string | undefined;
    let thumbnailKey: string | undefined;

    if (detectedMime.startsWith('image/') && config.imageOptimization) {
      const { maxWidth, maxHeight, generateThumbnail } = config.imageOptimization;

      uploadBuffer = await sharp(buffer)
        .resize(maxWidth, maxHeight, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 85 })
        .toBuffer();
      outputMime = 'image/webp';

      if (generateThumbnail) {
        const thumbBuffer = await sharp(buffer)
          .resize(150, 150, { fit: 'cover' })
          .webp({ quality: 70 })
          .toBuffer();
        thumbnailKey = StorageService.generateKey(
          `${config.prefix}/${entityId}/thumbnails`,
          'image/webp',
        );
        const thumbResult = await StorageService.adapter.upload(
          thumbnailKey,
          thumbBuffer,
          { contentType: 'image/webp', metadata: { entityId, uploadType } },
        );
        thumbnailUrl = thumbResult.url;
      }
    }

    const key = StorageService.generateKey(`${config.prefix}/${entityId}`, outputMime);
    const result = await StorageService.adapter.upload(key, uploadBuffer, {
      contentType: outputMime,
      metadata: { entityId, uploadType },
    });

    return { url: result.url, key: result.key, thumbnailUrl, thumbnailKey };
  }

  static async getSignedUrl(key: string, expiresIn = 3600): Promise<string> {
    return StorageService.adapter.getSignedUrl(key, expiresIn);
  }

  static async delete(key: string): Promise<void> {
    return StorageService.adapter.delete(key);
  }

  static async getPresignedUploadUrl(
    uploadType: UploadType,
    entityId: string,
    mimeType: string,
  ): Promise<{ uploadUrl: string; key: string; resultUrl?: string }> {
    const config = UPLOAD_CONFIGS[uploadType];

    if (!config.allowedMimes.has(mimeType)) {
      throw new AppError(
        `File type ${mimeType} is not allowed for ${uploadType}`,
        415,
      );
    }

    const key = StorageService.generateKey(`${config.prefix}/${entityId}`, mimeType);
    const uploadUrl = await StorageService.adapter.getPresignedUploadUrl(key, {
      contentType: mimeType,
      expiresIn: 3600,
    });

    return { uploadUrl, key };
  }

  static getConfig(uploadType: UploadType): {
    maxSizeBytes: number;
    allowedMimes: string[];
  } {
    const config = UPLOAD_CONFIGS[uploadType];
    return {
      maxSizeBytes: config.maxSizeBytes,
      allowedMimes: Array.from(config.allowedMimes),
    };
  }
}

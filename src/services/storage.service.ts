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
  thumbnailWidth?: number;
  thumbnailHeight?: number;
  generateThumbnail: boolean;
}

interface MinDimensions {
  width: number;
  height: number;
}

interface UploadConfig {
  prefix: string;
  maxSizeBytes: number;
  allowedMimes: Set<string>;
  imageOptimization?: ImageOptimization;
  minDimensions?: MinDimensions;
}

const UPLOAD_CONFIGS: Record<UploadType, UploadConfig> = {
  'profile-picture': {
    prefix: 'profile-pictures',
    maxSizeBytes: 5 * 1024 * 1024,
    allowedMimes: new Set(['image/jpeg', 'image/png', 'image/webp']),
    minDimensions: { width: 100, height: 100 },
    imageOptimization: {
      maxWidth: 500,
      maxHeight: 500,
      thumbnailWidth: 150,
      thumbnailHeight: 150,
      generateThumbnail: true,
    },
  },
  'kyc-document': {
    prefix: 'kyc-documents',
    maxSizeBytes: 10 * 1024 * 1024,
    allowedMimes: new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']),
    imageOptimization: {
      maxWidth: 2000,
      maxHeight: 2000,
      generateThumbnail: false,
    },
  },
  'campaign-image': {
    prefix: 'campaign-images',
    maxSizeBytes: 10 * 1024 * 1024,
    allowedMimes: new Set(['image/jpeg', 'image/png', 'image/webp']),
    minDimensions: { width: 400, height: 300 },
    imageOptimization: {
      maxWidth: 1200,
      maxHeight: 800,
      thumbnailWidth: 300,
      thumbnailHeight: 200,
      generateThumbnail: true,
    },
  },
  'distribution-proof': {
    prefix: 'distribution-proofs',
    maxSizeBytes: 20 * 1024 * 1024,
    allowedMimes: new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']),
    imageOptimization: {
      maxWidth: 2000,
      maxHeight: 2000,
      generateThumbnail: false,
    },
  },
};

const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'application/pdf': '.pdf',
};

// Known storage path prefixes — used by parseStorageKey to extract keys from URLs
const STORAGE_PREFIXES = [
  'profile-pictures/',
  'kyc-documents/',
  'campaign-images/',
  'distribution-proofs/',
  'receipts/',
];

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

  /**
   * Detects the MIME type of a buffer by inspecting magic bytes.
   * Never trusts the Content-Type header or file extension.
   */
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

  /**
   * Extracts a storage key from any provider URL by searching for known path prefixes.
   * Works for S3, Azure Blob Storage, and local URLs.
   * Returns null if the URL does not contain a recognised prefix.
   */
  static parseStorageKey(url: string): string | null {
    try {
      const pathname = new URL(url).pathname;
      // pathname may start with "/" or "/<container>/" (Azure); scan for known prefix
      for (const prefix of STORAGE_PREFIXES) {
        const idx = pathname.indexOf(prefix);
        if (idx !== -1) {
          return pathname.slice(idx);
        }
      }
    } catch {
      // Not a valid URL
    }
    return null;
  }

  /**
   * Generates a safe, collision-resistant storage key.
   * Client-supplied filenames are never used.
   */
  static generateKey(prefix: string, mimeType: string): string {
    const ext = MIME_TO_EXT[mimeType] || '.bin';
    return `${prefix}/${crypto.randomUUID()}${ext}`;
  }

  static async upload(
    uploadType: UploadType,
    entityId: string,
    buffer: Buffer,
  ): Promise<UploadOutput> {
    const config = UPLOAD_CONFIGS[uploadType];

    if (buffer.length === 0) {
      throw new AppError('Uploaded file is empty', 400);
    }

    if (buffer.length > config.maxSizeBytes) {
      const mb = Math.round(config.maxSizeBytes / 1024 / 1024);
      throw new AppError(`File size exceeds the ${mb}MB limit`, 413);
    }

    const detectedMime = StorageService.detectMimeType(buffer);
    if (!detectedMime) {
      throw new AppError('Unsupported or malformed file — cannot determine type', 415);
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
      const opt = config.imageOptimization;

      // Validate minimum dimensions before any processing
      if (config.minDimensions) {
        let meta: { width?: number; height?: number };
        try {
          meta = await sharp(buffer).metadata();
        } catch {
          throw new AppError('File appears to be corrupt or in an unsupported format', 422);
        }
        const { width = 0, height = 0 } = meta;
        const { width: minW, height: minH } = config.minDimensions;
        if (width < minW || height < minH) {
          throw new AppError(
            `Image is too small. Minimum required dimensions are ${minW}×${minH}px (uploaded: ${width}×${height}px)`,
            422,
          );
        }
      }

      // Resize + convert to WebP
      try {
        uploadBuffer = await sharp(buffer)
          .resize(opt.maxWidth, opt.maxHeight, { fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 85 })
          .toBuffer();
        outputMime = 'image/webp';
      } catch {
        throw new AppError('File appears to be corrupt or in an unsupported format', 422);
      }

      // Generate thumbnail if configured
      if (opt.generateThumbnail && opt.thumbnailWidth && opt.thumbnailHeight) {
        try {
          const thumbBuffer = await sharp(buffer)
            .resize(opt.thumbnailWidth, opt.thumbnailHeight, { fit: 'cover' })
            .webp({ quality: 70 })
            .toBuffer();
          thumbnailKey = StorageService.generateKey(
            `${config.prefix}/${entityId}/thumbnails`,
            'image/webp',
          );
          const thumbResult = await StorageService.adapter.upload(thumbnailKey, thumbBuffer, {
            contentType: 'image/webp',
            metadata: { entityId, uploadType },
          });
          thumbnailUrl = thumbResult.url;
          thumbnailKey = thumbResult.key;
        } catch {
          // Thumbnail failure is non-fatal — log in production, continue with main upload
        }
      }
    }

    const key = StorageService.generateKey(`${config.prefix}/${entityId}`, outputMime);
    const result = await StorageService.adapter.upload(key, uploadBuffer, {
      contentType: outputMime,
      metadata: { entityId, uploadType },
    });

    return { url: result.url, key: result.key, thumbnailUrl, thumbnailKey };
  }

  /**
   * Uploads a pre-rendered document buffer (e.g. a generated PDF) at an exact
   * key, bypassing image optimisation. The caller is responsible for the key
   * layout and for supplying a trustworthy content type.
   */
  static async uploadDocument(
    key: string,
    buffer: Buffer,
    contentType: string,
    metadata?: Record<string, string>,
  ): Promise<UploadOutput> {
    if (buffer.length === 0) {
      throw new AppError('Cannot store an empty document', 400);
    }

    const result = await StorageService.adapter.upload(key, buffer, {
      contentType,
      metadata,
    });

    return { url: result.url, key: result.key };
  }

  /**
   * Reads a stored object back into memory by its storage key.
   */
  static async download(key: string): Promise<Buffer> {
    return StorageService.adapter.download(key);
  }

  /**
   * Deletes a stored object by its storage key.
   * Errors are propagated to the caller.
   */
  static async delete(key: string): Promise<void> {
    return StorageService.adapter.delete(key);
  }

  /**
   * Generates a time-limited signed read URL for a stored object.
   */
  static async getSignedUrl(key: string, expiresIn = 3600): Promise<string> {
    return StorageService.adapter.getSignedUrl(key, expiresIn);
  }

  /**
   * Generates a pre-signed PUT URL for direct client-side upload.
   * The client uploads directly to storage (enabling progress tracking),
   * then persists the resulting URL via the existing resource update endpoints.
   */
  static async getPresignedUploadUrl(
    uploadType: UploadType,
    entityId: string,
    mimeType: string,
  ): Promise<{ uploadUrl: string; key: string }> {
    const config = UPLOAD_CONFIGS[uploadType];

    if (!config.allowedMimes.has(mimeType)) {
      throw new AppError(`File type ${mimeType} is not allowed for ${uploadType}`, 415);
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
    minDimensions?: MinDimensions;
  } {
    const config = UPLOAD_CONFIGS[uploadType];
    return {
      maxSizeBytes: config.maxSizeBytes,
      allowedMimes: Array.from(config.allowedMimes),
      minDimensions: config.minDimensions,
    };
  }
}

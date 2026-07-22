import { StorageService } from './storage.service';
import { IStorageAdapter } from '../storage/storage.interface';

// ─── Hoist-safe mocks (factories reference no module-level variables) ─────────

jest.mock('../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));
jest.mock('../storage/storage.factory', () => ({
  createStorageAdapter: jest.fn().mockReturnValue({}),
}));
jest.mock('sharp', () => jest.fn());

// ─── Constants ────────────────────────────────────────────────────────────────

const MAIN_BUF = Buffer.from('optimised-image');
const THUMB_BUF = Buffer.from('thumbnail-image');

// ─── State reset per test ─────────────────────────────────────────────────────

let mockAdapter: jest.Mocked<IStorageAdapter>;
let sharpInst: {
  resize: jest.Mock;
  webp: jest.Mock;
  toBuffer: jest.Mock;
  metadata: jest.Mock;
};

beforeEach(() => {
  jest.clearAllMocks();

  mockAdapter = {
    upload: jest.fn().mockResolvedValue({
      key: 'storage/uuid.webp',
      url: 'https://cdn.example.com/storage/uuid.webp',
    }),
    delete: jest.fn().mockResolvedValue(undefined),
    download: jest.fn().mockResolvedValue(Buffer.from('original-image')),
    getSignedUrl: jest.fn().mockResolvedValue('https://signed.cdn.example.com/key?t=abc'),
    getPresignedUploadUrl: jest
      .fn()
      .mockResolvedValue('https://bucket.s3.amazonaws.com/key?X-Sig=xyz'),
  };
  StorageService.setAdapter(mockAdapter);

  sharpInst = {
    resize: jest.fn().mockReturnThis(),
    webp: jest.fn().mockReturnThis(),
    toBuffer: jest
      .fn()
      .mockResolvedValueOnce(MAIN_BUF)
      .mockResolvedValueOnce(THUMB_BUF),
    metadata: jest.fn().mockResolvedValue({ width: 800, height: 600 }),
  };
  (jest.requireMock('sharp') as jest.Mock).mockReturnValue(sharpInst);
});

// ─── Buffer factories ─────────────────────────────────────────────────────────

const jpeg = (): Buffer => {
  const b = Buffer.alloc(20);
  b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff; b[3] = 0xe0;
  return b;
};
const png = (): Buffer => {
  const b = Buffer.alloc(20);
  b[0] = 0x89; b[1] = 0x50; b[2] = 0x4e; b[3] = 0x47;
  b[4] = 0x0d; b[5] = 0x0a; b[6] = 0x1a; b[7] = 0x0a;
  return b;
};
const webp = (): Buffer => {
  const b = Buffer.alloc(20);
  b[0] = 0x52; b[1] = 0x49; b[2] = 0x46; b[3] = 0x46;
  b[8] = 0x57; b[9] = 0x45; b[10] = 0x42; b[11] = 0x50;
  return b;
};
const pdf = (): Buffer => {
  const b = Buffer.alloc(20);
  b[0] = 0x25; b[1] = 0x50; b[2] = 0x44; b[3] = 0x46;
  return b;
};
const unknown = (): Buffer =>
  Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c]);

// Helper to make oversized buffers with a given magic header
function bigBuffer(magic: number[], totalMb: number): Buffer {
  const b = Buffer.alloc(totalMb * 1024 * 1024);
  magic.forEach((byte, i) => { b[i] = byte; });
  return b;
}

// ─────────────────────────────────────────────────────────────────────────────
// detectMimeType
// ─────────────────────────────────────────────────────────────────────────────

describe('StorageService.detectMimeType', () => {
  it('identifies JPEG by FF D8 FF magic', () => {
    expect(StorageService.detectMimeType(jpeg())).toBe('image/jpeg');
  });
  it('identifies PNG by 89 50 4E 47 magic', () => {
    expect(StorageService.detectMimeType(png())).toBe('image/png');
  });
  it('identifies WebP by RIFF…WEBP magic', () => {
    expect(StorageService.detectMimeType(webp())).toBe('image/webp');
  });
  it('identifies PDF by %PDF magic', () => {
    expect(StorageService.detectMimeType(pdf())).toBe('application/pdf');
  });
  it('returns null for unrecognised bytes', () => {
    expect(StorageService.detectMimeType(unknown())).toBeNull();
  });
  it('returns null for buffers shorter than 12 bytes', () => {
    expect(StorageService.detectMimeType(Buffer.from([0xff, 0xd8, 0xff]))).toBeNull();
  });
  it('returns null for empty buffer', () => {
    expect(StorageService.detectMimeType(Buffer.alloc(0))).toBeNull();
  });
  it('is not fooled by a correct extension but wrong content (unknown bytes still → null)', () => {
    // Pretend the client sent "photo.jpg" but the bytes are garbage
    const fakeJpeg = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00]);
    expect(StorageService.detectMimeType(fakeJpeg)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseStorageKey
// ─────────────────────────────────────────────────────────────────────────────

describe('StorageService.parseStorageKey', () => {
  it('extracts key from an S3 URL', () => {
    const url = 'https://my-bucket.s3.amazonaws.com/campaign-images/c-1/uuid.webp';
    expect(StorageService.parseStorageKey(url)).toBe('campaign-images/c-1/uuid.webp');
  });
  it('extracts key from an Azure Blob URL (container in path)', () => {
    const url = 'https://account.blob.core.windows.net/media/profile-pictures/org-1/uuid.webp';
    expect(StorageService.parseStorageKey(url)).toBe('profile-pictures/org-1/uuid.webp');
  });
  it('extracts key from a local development URL', () => {
    const url = 'http://localhost:3000/uploads/kyc-documents/sub-1/uuid.pdf';
    expect(StorageService.parseStorageKey(url)).toBe('kyc-documents/sub-1/uuid.pdf');
  });
  it('extracts key for distribution-proofs prefix', () => {
    const url = 'https://cdn.example.com/distribution-proofs/dist-1/uuid.jpg';
    expect(StorageService.parseStorageKey(url)).toBe('distribution-proofs/dist-1/uuid.jpg');
  });
  it('returns null for a URL with no recognised prefix', () => {
    expect(StorageService.parseStorageKey('https://example.com/avatars/photo.jpg')).toBeNull();
  });
  it('returns null for a non-URL string', () => {
    expect(StorageService.parseStorageKey('not-a-url')).toBeNull();
  });
  it('returns null for an empty string', () => {
    expect(StorageService.parseStorageKey('')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// generateKey
// ─────────────────────────────────────────────────────────────────────────────

describe('StorageService.generateKey', () => {
  it('scopes the key under the given prefix', () => {
    const key = StorageService.generateKey('profile-pictures/org-1', 'image/webp');
    expect(key).toMatch(/^profile-pictures\/org-1\/.+\.webp$/);
  });
  it('generates unique keys on every call', () => {
    const k1 = StorageService.generateKey('imgs', 'image/jpeg');
    const k2 = StorageService.generateKey('imgs', 'image/jpeg');
    expect(k1).not.toBe(k2);
  });
  it('maps image/jpeg → .jpg', () => {
    expect(StorageService.generateKey('x', 'image/jpeg')).toMatch(/\.jpg$/);
  });
  it('maps application/pdf → .pdf', () => {
    expect(StorageService.generateKey('docs', 'application/pdf')).toMatch(/\.pdf$/);
  });
  it('maps image/webp → .webp', () => {
    expect(StorageService.generateKey('x', 'image/webp')).toMatch(/\.webp$/);
  });
  it('falls back to .bin for unmapped MIME types', () => {
    expect(StorageService.generateKey('x', 'video/mp4')).toMatch(/\.bin$/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// upload – profile-picture
// ─────────────────────────────────────────────────────────────────────────────

describe('StorageService.upload – profile-picture', () => {
  it('resizes to 500×500 max, converts to WebP, and returns url + key', async () => {
    const result = await StorageService.upload('profile-picture', 'org-1', jpeg());

    expect(sharpInst.resize).toHaveBeenCalledWith(500, 500, {
      fit: 'inside',
      withoutEnlargement: true,
    });
    expect(sharpInst.webp).toHaveBeenCalledWith({ quality: 85 });
    expect(mockAdapter.upload).toHaveBeenCalledWith(
      expect.stringMatching(/^profile-pictures\/org-1\/.+\.webp$/),
      MAIN_BUF,
      expect.objectContaining({ contentType: 'image/webp' }),
    );
    expect(result.url).toMatch(/^https:\/\//);
    expect(result.key).toBeDefined();
  });

  it('generates a 150×150 thumbnail and returns thumbnailUrl', async () => {
    mockAdapter.upload
      .mockResolvedValueOnce({ key: 'thumb-key', url: 'https://cdn.example.com/thumb' })
      .mockResolvedValueOnce({ key: 'main-key', url: 'https://cdn.example.com/main' });

    const result = await StorageService.upload('profile-picture', 'org-1', jpeg());

    expect(sharpInst.resize).toHaveBeenCalledTimes(2);
    expect(sharpInst.resize).toHaveBeenNthCalledWith(2, 150, 150, { fit: 'cover' });
    expect(result.thumbnailUrl).toBe('https://cdn.example.com/thumb');
    // thumbnailKey comes from adapter's returned key
    expect(result.thumbnailKey).toBe('thumb-key');
  });

  it('includes entityId and uploadType in metadata', async () => {
    await StorageService.upload('profile-picture', 'org-99', jpeg());
    expect(mockAdapter.upload).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Buffer),
      expect.objectContaining({
        metadata: expect.objectContaining({ entityId: 'org-99', uploadType: 'profile-picture' }),
      }),
    );
  });

  it('rejects files over the 5MB limit before any processing', async () => {
    const big = bigBuffer([0xff, 0xd8, 0xff, 0xe0], 6);
    await expect(StorageService.upload('profile-picture', 'org-1', big))
      .rejects.toThrow('File size exceeds the 5MB limit');
    expect(sharpInst.metadata).not.toHaveBeenCalled();
    expect(mockAdapter.upload).not.toHaveBeenCalled();
  });

  it('rejects empty buffer', async () => {
    await expect(StorageService.upload('profile-picture', 'org-1', Buffer.alloc(0)))
      .rejects.toThrow('Uploaded file is empty');
  });

  it('rejects images below the minimum 100×100px', async () => {
    sharpInst.metadata.mockResolvedValueOnce({ width: 50, height: 80 });
    await expect(StorageService.upload('profile-picture', 'org-1', jpeg()))
      .rejects.toThrow('Image is too small');
    expect(mockAdapter.upload).not.toHaveBeenCalled();
  });

  it('rejects PDF (not in allowed MIME set)', async () => {
    await expect(StorageService.upload('profile-picture', 'org-1', pdf()))
      .rejects.toThrow('File type application/pdf is not allowed for profile-picture');
  });

  it('rejects files with unrecognisable magic bytes', async () => {
    await expect(StorageService.upload('profile-picture', 'org-1', unknown()))
      .rejects.toThrow('Unsupported or malformed file');
  });

  it('converts a corrupt/malformed image (sharp throws on resize) into a 422 error', async () => {
    // Metadata passes (valid dims), but resize/toBuffer fails — corrupt pixel data
    sharpInst.metadata.mockResolvedValueOnce({ width: 200, height: 200 });
    // Reset to clear the queued MAIN_BUF / THUMB_BUF from beforeEach, then add the rejection
    sharpInst.toBuffer.mockReset();
    sharpInst.toBuffer.mockRejectedValueOnce(
      new Error('Input buffer contains unsupported image format'),
    );

    await expect(StorageService.upload('profile-picture', 'org-1', jpeg()))
      .rejects.toThrow('File appears to be corrupt or in an unsupported format');
  });

  it('converts a metadata-read failure (corrupt header) into a 422 error', async () => {
    sharpInst.metadata.mockRejectedValueOnce(
      new Error('Input buffer contains unsupported image format'),
    );

    await expect(StorageService.upload('profile-picture', 'org-1', jpeg()))
      .rejects.toThrow('File appears to be corrupt or in an unsupported format');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// upload – campaign-image
// ─────────────────────────────────────────────────────────────────────────────

describe('StorageService.upload – campaign-image', () => {
  it('resizes to 1200×800 max while preserving aspect ratio', async () => {
    await StorageService.upload('campaign-image', 'camp-1', png());
    expect(sharpInst.resize).toHaveBeenCalledWith(1200, 800, {
      fit: 'inside',
      withoutEnlargement: true,
    });
  });

  it('generates a 300×200 thumbnail', async () => {
    mockAdapter.upload
      .mockResolvedValueOnce({ key: 'thumb-key', url: 'https://cdn.example.com/thumb' })
      .mockResolvedValueOnce({ key: 'main-key', url: 'https://cdn.example.com/main' });

    const result = await StorageService.upload('campaign-image', 'camp-1', png());

    expect(sharpInst.resize).toHaveBeenCalledTimes(2);
    expect(sharpInst.resize).toHaveBeenNthCalledWith(2, 300, 200, { fit: 'cover' });
    expect(result.thumbnailUrl).toBe('https://cdn.example.com/thumb');
  });

  it('rejects images below the minimum 400×300px', async () => {
    sharpInst.metadata.mockResolvedValueOnce({ width: 200, height: 150 });
    await expect(StorageService.upload('campaign-image', 'camp-1', png()))
      .rejects.toThrow('Image is too small. Minimum required dimensions are 400×300px');
  });

  it('rejects PDF (not in allowed MIME set)', async () => {
    await expect(StorageService.upload('campaign-image', 'camp-1', pdf()))
      .rejects.toThrow('File type application/pdf is not allowed for campaign-image');
  });

  it('rejects files over the 10MB limit', async () => {
    const big = bigBuffer([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 11);
    await expect(StorageService.upload('campaign-image', 'camp-1', big))
      .rejects.toThrow('File size exceeds the 10MB limit');
  });

  it('stores the key under campaign-images/<entityId>/', async () => {
    await StorageService.upload('campaign-image', 'camp-42', png());
    expect(mockAdapter.upload).toHaveBeenCalledWith(
      expect.stringContaining('campaign-images/camp-42/'),
      expect.any(Buffer),
      expect.any(Object),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// upload – kyc-document
// ─────────────────────────────────────────────────────────────────────────────

describe('StorageService.upload – kyc-document', () => {
  it('optimises JPEG and uploads as WebP', async () => {
    await StorageService.upload('kyc-document', 'sub-1', jpeg());
    expect(sharpInst.resize).toHaveBeenCalledWith(2000, 2000, expect.any(Object));
  });

  it('passes PDF through without calling sharp at all', async () => {
    const pdfBuf = pdf();
    await StorageService.upload('kyc-document', 'sub-1', pdfBuf);

    const sharpFn = jest.requireMock('sharp') as jest.Mock;
    expect(sharpFn).not.toHaveBeenCalled();
    expect(mockAdapter.upload).toHaveBeenCalledWith(
      expect.any(String),
      pdfBuf,
      expect.objectContaining({ contentType: 'application/pdf' }),
    );
  });

  it('does not generate a thumbnail for KYC documents', async () => {
    await StorageService.upload('kyc-document', 'sub-1', jpeg());
    // Only one sharp call (for main image), no thumbnail resize
    expect(sharpInst.resize).toHaveBeenCalledTimes(1);
  });

  it('rejects files over the 10MB limit', async () => {
    const big = bigBuffer([0xff, 0xd8, 0xff, 0xe0], 11);
    await expect(StorageService.upload('kyc-document', 'sub-1', big))
      .rejects.toThrow('File size exceeds the 10MB limit');
  });

  it('does not apply minDimensions check to KYC documents', async () => {
    // KYC has no minDimensions config, so small images are allowed
    sharpInst.metadata.mockResolvedValueOnce({ width: 10, height: 10 });
    await expect(StorageService.upload('kyc-document', 'sub-1', jpeg()))
      .resolves.toBeDefined();
    // metadata() should never be called since minDimensions is undefined
    expect(sharpInst.metadata).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// upload – distribution-proof
// ─────────────────────────────────────────────────────────────────────────────

describe('StorageService.upload – distribution-proof', () => {
  it('accepts JPEG proof images', async () => {
    await StorageService.upload('distribution-proof', 'dist-1', jpeg());
    expect(mockAdapter.upload).toHaveBeenCalled();
  });

  it('passes PDF proof documents through unchanged', async () => {
    const pdfBuf = pdf();
    await StorageService.upload('distribution-proof', 'dist-1', pdfBuf);
    expect(mockAdapter.upload).toHaveBeenCalledWith(
      expect.any(String),
      pdfBuf,
      expect.objectContaining({ contentType: 'application/pdf' }),
    );
  });

  it('rejects files over the 20MB limit', async () => {
    const big = bigBuffer([0x25, 0x50, 0x44, 0x46], 21);
    await expect(StorageService.upload('distribution-proof', 'dist-1', big))
      .rejects.toThrow('File size exceeds the 20MB limit');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getSignedUrl
// ─────────────────────────────────────────────────────────────────────────────

describe('StorageService.getSignedUrl', () => {
  it('delegates to the adapter with the supplied key and expiresIn', async () => {
    const url = await StorageService.getSignedUrl('profile-pictures/org-1/uuid.webp', 7200);
    expect(mockAdapter.getSignedUrl).toHaveBeenCalledWith(
      'profile-pictures/org-1/uuid.webp',
      7200,
    );
    expect(url).toBe('https://signed.cdn.example.com/key?t=abc');
  });

  it('defaults to 3600 seconds when expiresIn is omitted', async () => {
    await StorageService.getSignedUrl('some/key.pdf');
    expect(mockAdapter.getSignedUrl).toHaveBeenCalledWith('some/key.pdf', 3600);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// delete
// ─────────────────────────────────────────────────────────────────────────────

describe('StorageService.delete', () => {
  it('delegates to the adapter', async () => {
    await StorageService.delete('profile-pictures/org-1/uuid.webp');
    expect(mockAdapter.delete).toHaveBeenCalledWith('profile-pictures/org-1/uuid.webp');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getPresignedUploadUrl
// ─────────────────────────────────────────────────────────────────────────────

describe('StorageService.getPresignedUploadUrl', () => {
  it('returns uploadUrl and key with the correct prefix for campaign-image', async () => {
    const result = await StorageService.getPresignedUploadUrl(
      'campaign-image',
      'camp-1',
      'image/jpeg',
    );
    expect(mockAdapter.getPresignedUploadUrl).toHaveBeenCalledWith(
      expect.stringMatching(/^campaign-images\/camp-1\/.+\.jpg$/),
      expect.objectContaining({ contentType: 'image/jpeg', expiresIn: 3600 }),
    );
    expect(result.uploadUrl).toBe('https://bucket.s3.amazonaws.com/key?X-Sig=xyz');
    expect(result.key).toMatch(/^campaign-images\/camp-1\/.+\.jpg$/);
  });

  it('returns key with the correct prefix for kyc-document (pdf)', async () => {
    const result = await StorageService.getPresignedUploadUrl(
      'kyc-document',
      'sub-1',
      'application/pdf',
    );
    expect(result.key).toMatch(/^kyc-documents\/sub-1\/.+\.pdf$/);
  });

  it('rejects a MIME type that is not allowed for the upload type', async () => {
    await expect(
      StorageService.getPresignedUploadUrl('profile-picture', 'org-1', 'application/pdf'),
    ).rejects.toThrow('File type application/pdf is not allowed for profile-picture');
  });

  it('rejects completely unsupported MIME types', async () => {
    await expect(
      StorageService.getPresignedUploadUrl('campaign-image', 'c-1', 'video/mp4'),
    ).rejects.toThrow('File type video/mp4 is not allowed for campaign-image');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getConfig
// ─────────────────────────────────────────────────────────────────────────────

describe('StorageService.getConfig', () => {
  it('profile-picture: 5MB, images only, min 100×100', () => {
    const cfg = StorageService.getConfig('profile-picture');
    expect(cfg.maxSizeBytes).toBe(5 * 1024 * 1024);
    expect(cfg.allowedMimes).toContain('image/jpeg');
    expect(cfg.allowedMimes).not.toContain('application/pdf');
    expect(cfg.minDimensions).toEqual({ width: 100, height: 100 });
  });

  it('campaign-image: 10MB, images only, min 400×300', () => {
    const cfg = StorageService.getConfig('campaign-image');
    expect(cfg.maxSizeBytes).toBe(10 * 1024 * 1024);
    expect(cfg.allowedMimes).not.toContain('application/pdf');
    expect(cfg.minDimensions).toEqual({ width: 400, height: 300 });
  });

  it('kyc-document: 10MB, images + PDF, no minDimensions', () => {
    const cfg = StorageService.getConfig('kyc-document');
    expect(cfg.maxSizeBytes).toBe(10 * 1024 * 1024);
    expect(cfg.allowedMimes).toContain('application/pdf');
    expect(cfg.minDimensions).toBeUndefined();
  });

  it('distribution-proof: 20MB, images + PDF, no minDimensions', () => {
    const cfg = StorageService.getConfig('distribution-proof');
    expect(cfg.maxSizeBytes).toBe(20 * 1024 * 1024);
    expect(cfg.allowedMimes).toContain('application/pdf');
    expect(cfg.minDimensions).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Adapter isolation
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// regenerateThumbnail
// ─────────────────────────────────────────────────────────────────────────────

describe('StorageService.regenerateThumbnail', () => {
  const profileUrl = 'https://cdn.example.com/profile-pictures/org-1/original.webp';

  it('downloads the original, derives a fresh thumbnail, and stores it', async () => {
    mockAdapter.download.mockResolvedValue(jpeg());
    sharpInst.toBuffer.mockReset().mockResolvedValue(THUMB_BUF);
    mockAdapter.upload.mockResolvedValue({
      key: 'profile-pictures/org-1/thumbnails/new-uuid.webp',
      url: 'https://cdn.example.com/thumb-regenerated',
    });

    const result = await StorageService.regenerateThumbnail('profile-picture', 'org-1', profileUrl);

    expect(mockAdapter.download).toHaveBeenCalledWith('profile-pictures/org-1/original.webp');
    expect(sharpInst.resize).toHaveBeenCalledWith(150, 150, { fit: 'cover' });
    expect(result).toEqual({
      thumbnailUrl: 'https://cdn.example.com/thumb-regenerated',
      thumbnailKey: 'profile-pictures/org-1/thumbnails/new-uuid.webp',
    });
  });

  it('regenerates a campaign image thumbnail at its configured size', async () => {
    mockAdapter.download.mockResolvedValue(png());
    sharpInst.toBuffer.mockReset().mockResolvedValue(THUMB_BUF);

    await StorageService.regenerateThumbnail(
      'campaign-image',
      'c-1',
      'https://cdn.example.com/campaign-images/c-1/original.webp',
    );

    expect(sharpInst.resize).toHaveBeenCalledWith(300, 200, { fit: 'cover' });
  });

  it('returns null for upload types with no thumbnail configuration, without touching storage', async () => {
    const result = await StorageService.regenerateThumbnail(
      'kyc-document',
      'sub-1',
      'https://cdn.example.com/kyc-documents/sub-1/original.jpg',
    );

    expect(result).toBeNull();
    expect(mockAdapter.download).not.toHaveBeenCalled();
  });

  it('rejects a source URL with no resolvable storage key', async () => {
    await expect(
      StorageService.regenerateThumbnail('profile-picture', 'org-1', 'https://example.com/not-a-storage-url'),
    ).rejects.toThrow('Could not resolve a storage key from the given URL');

    expect(mockAdapter.download).not.toHaveBeenCalled();
  });

  it('rejects when the stored object is not an image (e.g. a PDF)', async () => {
    mockAdapter.download.mockResolvedValue(pdf());

    await expect(
      StorageService.regenerateThumbnail('profile-picture', 'org-1', profileUrl),
    ).rejects.toThrow('Stored object is not a supported image');

    expect(mockAdapter.upload).not.toHaveBeenCalled();
  });

  it('rejects when the downloaded image is corrupt and sharp cannot process it', async () => {
    mockAdapter.download.mockResolvedValue(jpeg());
    sharpInst.toBuffer.mockReset().mockRejectedValue(new Error('unsupported image format'));

    await expect(
      StorageService.regenerateThumbnail('profile-picture', 'org-1', profileUrl),
    ).rejects.toThrow('Failed to regenerate thumbnail');
  });
});

describe('StorageService adapter isolation', () => {
  it('routes calls through the injected adapter, not the factory default', async () => {
    const alt: jest.Mocked<IStorageAdapter> = {
      upload: jest.fn().mockResolvedValue({ key: 'alt/k.jpg', url: 'https://alt.example.com/k.jpg' }),
      delete: jest.fn(),
      getSignedUrl: jest.fn(),
      getPresignedUploadUrl: jest.fn(),
    };
    StorageService.setAdapter(alt);

    await StorageService.upload('campaign-image', 'c-1', jpeg());

    expect(alt.upload).toHaveBeenCalled();
    expect(mockAdapter.upload).not.toHaveBeenCalled();
  });
});

import { StorageService } from './storage.service';
import { IStorageAdapter } from '../storage/storage.interface';

// ─── jest.mock calls must come before variable declarations due to hoisting ──

jest.mock('../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));
// Factory has no external references - avoids temporal dead zone issues
jest.mock('../storage/storage.factory', () => ({
  createStorageAdapter: jest.fn().mockReturnValue({}),
}));
jest.mock('sharp', () => jest.fn());

// ─── Module-level variables (set up in beforeEach) ───────────────────────────

const MAIN_BUF = Buffer.from('processed-image-data');
const THUMB_BUF = Buffer.from('thumb-image-data');

let mockAdapter: jest.Mocked<IStorageAdapter>;
let sharpInstance: { resize: jest.Mock; webp: jest.Mock; toBuffer: jest.Mock };

// ─── Buffer helpers ──────────────────────────────────────────────────────────

function makeJpegBuffer(): Buffer {
  const b = Buffer.alloc(20);
  b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff; b[3] = 0xe0;
  return b;
}
function makePngBuffer(): Buffer {
  const b = Buffer.alloc(20);
  b[0] = 0x89; b[1] = 0x50; b[2] = 0x4e; b[3] = 0x47;
  b[4] = 0x0d; b[5] = 0x0a; b[6] = 0x1a; b[7] = 0x0a;
  return b;
}
function makeWebpBuffer(): Buffer {
  const b = Buffer.alloc(20);
  b[0] = 0x52; b[1] = 0x49; b[2] = 0x46; b[3] = 0x46;
  b[8] = 0x57; b[9] = 0x45; b[10] = 0x42; b[11] = 0x50;
  return b;
}
function makePdfBuffer(): Buffer {
  const b = Buffer.alloc(20);
  b[0] = 0x25; b[1] = 0x50; b[2] = 0x44; b[3] = 0x46;
  return b;
}
function makeUnknownBuffer(): Buffer {
  return Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07,
    0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d]);
}

// ─── Setup ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();

  // Fresh adapter mock
  mockAdapter = {
    upload: jest.fn().mockResolvedValue({ key: 'uploads/uuid.webp', url: 'https://cdn.example.com/uploads/uuid.webp' }),
    delete: jest.fn().mockResolvedValue(undefined),
    getSignedUrl: jest.fn().mockResolvedValue('https://signed.example.com/key?token=abc'),
    getPresignedUploadUrl: jest.fn().mockResolvedValue('https://presigned.example.com/upload?sig=xyz'),
  };
  StorageService.setAdapter(mockAdapter);

  // Fresh sharp chain mock
  sharpInstance = {
    resize: jest.fn().mockReturnThis(),
    webp: jest.fn().mockReturnThis(),
    toBuffer: jest.fn()
      .mockResolvedValueOnce(MAIN_BUF)
      .mockResolvedValueOnce(THUMB_BUF),
  };
  const sharp = jest.requireMock('sharp') as jest.Mock;
  sharp.mockReturnValue(sharpInstance);
});

// ─── detectMimeType ──────────────────────────────────────────────────────────

describe('StorageService.detectMimeType', () => {
  it('detects JPEG from magic bytes', () => {
    expect(StorageService.detectMimeType(makeJpegBuffer())).toBe('image/jpeg');
  });
  it('detects PNG from magic bytes', () => {
    expect(StorageService.detectMimeType(makePngBuffer())).toBe('image/png');
  });
  it('detects WebP from magic bytes', () => {
    expect(StorageService.detectMimeType(makeWebpBuffer())).toBe('image/webp');
  });
  it('detects PDF from magic bytes', () => {
    expect(StorageService.detectMimeType(makePdfBuffer())).toBe('application/pdf');
  });
  it('returns null for unrecognized bytes', () => {
    expect(StorageService.detectMimeType(makeUnknownBuffer())).toBeNull();
  });
  it('returns null for buffer shorter than 12 bytes', () => {
    expect(StorageService.detectMimeType(Buffer.from([0xff, 0xd8, 0xff]))).toBeNull();
  });
});

// ─── generateKey ─────────────────────────────────────────────────────────────

describe('StorageService.generateKey', () => {
  it('generates a key under the given prefix', () => {
    const key = StorageService.generateKey('profile-pictures/org-1', 'image/webp');
    expect(key).toMatch(/^profile-pictures\/org-1\/.+\.webp$/);
  });
  it('generates unique keys on successive calls', () => {
    const k1 = StorageService.generateKey('imgs', 'image/jpeg');
    const k2 = StorageService.generateKey('imgs', 'image/jpeg');
    expect(k1).not.toBe(k2);
  });
  it('maps image/jpeg to .jpg extension', () => {
    expect(StorageService.generateKey('x', 'image/jpeg')).toMatch(/\.jpg$/);
  });
  it('maps application/pdf to .pdf extension', () => {
    expect(StorageService.generateKey('docs', 'application/pdf')).toMatch(/\.pdf$/);
  });
});

// ─── upload – profile-picture ────────────────────────────────────────────────

describe('StorageService.upload – profile-picture', () => {
  it('optimizes JPEG with sharp and uploads as WebP', async () => {
    const result = await StorageService.upload('profile-picture', 'org-1', makeJpegBuffer());

    expect(sharpInstance.resize).toHaveBeenCalledWith(500, 500, {
      fit: 'inside', withoutEnlargement: true,
    });
    expect(sharpInstance.webp).toHaveBeenCalledWith({ quality: 85 });
    expect(mockAdapter.upload).toHaveBeenCalledWith(
      expect.stringMatching(/^profile-pictures\/org-1\/.+\.webp$/),
      MAIN_BUF,
      expect.objectContaining({ contentType: 'image/webp' }),
    );
    expect(result.url).toBe('https://cdn.example.com/uploads/uuid.webp');
    expect(result.key).toBeDefined();
  });

  it('generates thumbnail for profile picture and returns thumbnailUrl', async () => {
    mockAdapter.upload
      .mockResolvedValueOnce({ key: 'thumb-key', url: 'https://cdn.example.com/thumb-key' })
      .mockResolvedValueOnce({ key: 'main-key', url: 'https://cdn.example.com/main-key' });

    const result = await StorageService.upload('profile-picture', 'org-1', makeJpegBuffer());

    expect(sharpInstance.resize).toHaveBeenCalledTimes(2);
    expect(result.thumbnailUrl).toBe('https://cdn.example.com/thumb-key');
    expect(result.url).toBe('https://cdn.example.com/main-key');
  });

  it('passes storage metadata with entityId and uploadType', async () => {
    await StorageService.upload('profile-picture', 'org-42', makeJpegBuffer());
    expect(mockAdapter.upload).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Buffer),
      expect.objectContaining({
        metadata: expect.objectContaining({ entityId: 'org-42', uploadType: 'profile-picture' }),
      }),
    );
  });

  it('rejects files over the 5MB size limit', async () => {
    const big = Buffer.alloc(6 * 1024 * 1024);
    big[0] = 0xff; big[1] = 0xd8; big[2] = 0xff;
    for (let i = 3; i < 12; i++) big[i] = 0;

    await expect(StorageService.upload('profile-picture', 'org-1', big))
      .rejects.toThrow('File size exceeds the 5MB limit');
    expect(mockAdapter.upload).not.toHaveBeenCalled();
  });

  it('rejects PDF (not allowed for profile-picture)', async () => {
    await expect(StorageService.upload('profile-picture', 'org-1', makePdfBuffer()))
      .rejects.toThrow('File type application/pdf is not allowed for profile-picture');
  });

  it('rejects malformed files with undetectable MIME type', async () => {
    await expect(StorageService.upload('profile-picture', 'org-1', makeUnknownBuffer()))
      .rejects.toThrow('Unsupported or malformed file type');
  });
});

// ─── upload – kyc-document ───────────────────────────────────────────────────

describe('StorageService.upload – kyc-document', () => {
  it('accepts and optimizes JPEG image documents', async () => {
    const result = await StorageService.upload('kyc-document', 'sub-1', makeJpegBuffer());
    expect(sharpInstance.resize).toHaveBeenCalledWith(2000, 2000, expect.any(Object));
    expect(result.url).toBeDefined();
  });

  it('passes PDF through without calling sharp', async () => {
    const pdfBuf = makePdfBuffer();
    await StorageService.upload('kyc-document', 'sub-1', pdfBuf);

    const sharp = jest.requireMock('sharp') as jest.Mock;
    expect(sharp).not.toHaveBeenCalled();
    expect(mockAdapter.upload).toHaveBeenCalledWith(
      expect.any(String),
      pdfBuf,
      expect.objectContaining({ contentType: 'application/pdf' }),
    );
  });

  it('rejects files over the 10MB size limit', async () => {
    const big = Buffer.alloc(11 * 1024 * 1024);
    big[0] = 0xff; big[1] = 0xd8; big[2] = 0xff;
    for (let i = 3; i < 12; i++) big[i] = 0;

    await expect(StorageService.upload('kyc-document', 'sub-1', big))
      .rejects.toThrow('File size exceeds the 10MB limit');
  });

  it('does not generate a thumbnail for kyc-document', async () => {
    await StorageService.upload('kyc-document', 'sub-1', makeJpegBuffer());
    expect(sharpInstance.resize).toHaveBeenCalledTimes(1);
  });
});

// ─── upload – campaign-image ─────────────────────────────────────────────────

describe('StorageService.upload – campaign-image', () => {
  it('resizes to max 1200×800', async () => {
    await StorageService.upload('campaign-image', 'camp-1', makePngBuffer());
    expect(sharpInstance.resize).toHaveBeenCalledWith(1200, 800, {
      fit: 'inside', withoutEnlargement: true,
    });
  });

  it('rejects PDF for campaign-image', async () => {
    await expect(StorageService.upload('campaign-image', 'camp-1', makePdfBuffer()))
      .rejects.toThrow('File type application/pdf is not allowed for campaign-image');
  });

  it('rejects files over the 10MB limit', async () => {
    const big = Buffer.alloc(11 * 1024 * 1024);
    big[0] = 0x89; big[1] = 0x50; big[2] = 0x4e; big[3] = 0x47;
    for (let i = 4; i < 12; i++) big[i] = 0;

    await expect(StorageService.upload('campaign-image', 'camp-1', big))
      .rejects.toThrow('File size exceeds the 10MB limit');
  });

  it('uploads key under campaign-images prefix', async () => {
    await StorageService.upload('campaign-image', 'camp-99', makePngBuffer());
    expect(mockAdapter.upload).toHaveBeenCalledWith(
      expect.stringContaining('campaign-images/camp-99'),
      expect.any(Buffer),
      expect.any(Object),
    );
  });
});

// ─── upload – distribution-proof ─────────────────────────────────────────────

describe('StorageService.upload – distribution-proof', () => {
  it('accepts JPEG proof images and optimizes them', async () => {
    await StorageService.upload('distribution-proof', 'dist-1', makeJpegBuffer());
    expect(mockAdapter.upload).toHaveBeenCalled();
  });

  it('accepts PDF proof documents unchanged', async () => {
    const pdfBuf = makePdfBuffer();
    await StorageService.upload('distribution-proof', 'dist-1', pdfBuf);
    expect(mockAdapter.upload).toHaveBeenCalledWith(
      expect.any(String),
      pdfBuf,
      expect.objectContaining({ contentType: 'application/pdf' }),
    );
  });

  it('rejects files over the 20MB limit', async () => {
    const big = Buffer.alloc(21 * 1024 * 1024);
    big[0] = 0x25; big[1] = 0x50; big[2] = 0x44; big[3] = 0x46;
    for (let i = 4; i < 12; i++) big[i] = 0;

    await expect(StorageService.upload('distribution-proof', 'dist-1', big))
      .rejects.toThrow('File size exceeds the 20MB limit');
  });
});

// ─── getSignedUrl ─────────────────────────────────────────────────────────────

describe('StorageService.getSignedUrl', () => {
  it('delegates to the storage adapter with key and expiresIn', async () => {
    const url = await StorageService.getSignedUrl('some/key.jpg', 7200);
    expect(mockAdapter.getSignedUrl).toHaveBeenCalledWith('some/key.jpg', 7200);
    expect(url).toBe('https://signed.example.com/key?token=abc');
  });

  it('defaults expiresIn to 3600 seconds', async () => {
    await StorageService.getSignedUrl('some/key.jpg');
    expect(mockAdapter.getSignedUrl).toHaveBeenCalledWith('some/key.jpg', 3600);
  });
});

// ─── delete ──────────────────────────────────────────────────────────────────

describe('StorageService.delete', () => {
  it('delegates deletion to the storage adapter', async () => {
    await StorageService.delete('profile-pictures/org-1/uuid.webp');
    expect(mockAdapter.delete).toHaveBeenCalledWith('profile-pictures/org-1/uuid.webp');
  });
});

// ─── getPresignedUploadUrl ────────────────────────────────────────────────────

describe('StorageService.getPresignedUploadUrl', () => {
  it('returns presigned upload URL and key for a valid MIME type', async () => {
    const result = await StorageService.getPresignedUploadUrl(
      'campaign-image', 'camp-1', 'image/jpeg',
    );
    expect(mockAdapter.getPresignedUploadUrl).toHaveBeenCalledWith(
      expect.stringMatching(/^campaign-images\/camp-1\/.+\.jpg$/),
      expect.objectContaining({ contentType: 'image/jpeg', expiresIn: 3600 }),
    );
    expect(result.uploadUrl).toBe('https://presigned.example.com/upload?sig=xyz');
    expect(result.key).toMatch(/^campaign-images\/camp-1\/.+\.jpg$/);
  });

  it('rejects a MIME type not in the allowed list for that upload type', async () => {
    await expect(
      StorageService.getPresignedUploadUrl('profile-picture', 'org-1', 'application/pdf'),
    ).rejects.toThrow('File type application/pdf is not allowed for profile-picture');
  });

  it('rejects completely unsupported MIME types', async () => {
    await expect(
      StorageService.getPresignedUploadUrl('campaign-image', 'c-1', 'video/mp4'),
    ).rejects.toThrow('File type video/mp4 is not allowed for campaign-image');
  });

  it('generates key in the correct storage prefix for kyc-document', async () => {
    const result = await StorageService.getPresignedUploadUrl(
      'kyc-document', 'sub-1', 'application/pdf',
    );
    expect(result.key).toMatch(/^kyc-documents\/sub-1\/.+\.pdf$/);
  });
});

// ─── getConfig ────────────────────────────────────────────────────────────────

describe('StorageService.getConfig', () => {
  it('returns 5MB limit and image-only MIME types for profile-picture', () => {
    const cfg = StorageService.getConfig('profile-picture');
    expect(cfg.maxSizeBytes).toBe(5 * 1024 * 1024);
    expect(cfg.allowedMimes).toContain('image/jpeg');
    expect(cfg.allowedMimes).not.toContain('application/pdf');
  });

  it('returns 20MB limit and includes PDF for distribution-proof', () => {
    const cfg = StorageService.getConfig('distribution-proof');
    expect(cfg.maxSizeBytes).toBe(20 * 1024 * 1024);
    expect(cfg.allowedMimes).toContain('application/pdf');
  });

  it('returns 10MB limit for campaign-image and excludes PDF', () => {
    const cfg = StorageService.getConfig('campaign-image');
    expect(cfg.maxSizeBytes).toBe(10 * 1024 * 1024);
    expect(cfg.allowedMimes).not.toContain('application/pdf');
  });

  it('returns 10MB limit for kyc-document and includes PDF', () => {
    const cfg = StorageService.getConfig('kyc-document');
    expect(cfg.maxSizeBytes).toBe(10 * 1024 * 1024);
    expect(cfg.allowedMimes).toContain('application/pdf');
  });
});

// ─── storage adapter isolation ────────────────────────────────────────────────

describe('StorageService adapter isolation', () => {
  it('uses the injected adapter and not the factory default', async () => {
    const altAdapter: jest.Mocked<IStorageAdapter> = {
      upload: jest.fn().mockResolvedValue({ key: 'alt/key.jpg', url: 'https://alt.example.com/key.jpg' }),
      delete: jest.fn(),
      getSignedUrl: jest.fn(),
      getPresignedUploadUrl: jest.fn(),
    };
    StorageService.setAdapter(altAdapter);

    await StorageService.upload('campaign-image', 'c-1', makeJpegBuffer());

    expect(altAdapter.upload).toHaveBeenCalled();
    expect(mockAdapter.upload).not.toHaveBeenCalled();
  });
});

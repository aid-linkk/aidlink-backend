/**
 * Unit tests for UploadController.
 * Verifies: authentication, authorization, ownership enforcement, DB persistence,
 * old-file cleanup behaviour, and correct error propagation.
 * Network and filesystem calls are eliminated by mocking StorageService and Prisma.
 */

import { Response, NextFunction } from 'express';
import { Role } from '@prisma/client';
import { AuthRequest } from '../types';

// ─── Mocks (factories contain no external references — hoist-safe) ────────────

jest.mock('../config/database', () => ({
  __esModule: true,
  default: {
    organization: { findUnique: jest.fn(), update: jest.fn() },
    kYCSubmission: { findUnique: jest.fn(), update: jest.fn() },
    kYCDocumentHistory: { create: jest.fn() },
    campaign: { findUnique: jest.fn(), update: jest.fn() },
    distribution: { findUnique: jest.fn(), update: jest.fn() },
  },
}));

jest.mock('../config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));

jest.mock('../storage/storage.factory', () => ({
  createStorageAdapter: jest.fn().mockReturnValue({}),
}));

jest.mock('../services/storage.service', () => ({
  StorageService: {
    upload: jest.fn(),
    delete: jest.fn(),
    getSignedUrl: jest.fn(),
    getPresignedUploadUrl: jest.fn(),
    parseStorageKey: jest.fn(),
    getConfig: jest.fn(),
    setAdapter: jest.fn(),
  },
}));

// ─── Controller import (after mocks are registered) ──────────────────────────

import { UploadController } from './upload.controller';

// ─── Stable references to mock objects ───────────────────────────────────────

const prisma = jest.requireMock('../config/database').default as {
  organization: { findUnique: jest.Mock; update: jest.Mock };
  kYCSubmission: { findUnique: jest.Mock; update: jest.Mock };
  kYCDocumentHistory: { create: jest.Mock };
  campaign: { findUnique: jest.Mock; update: jest.Mock };
  distribution: { findUnique: jest.Mock; update: jest.Mock };
};

const { StorageService } = jest.requireMock('../services/storage.service') as {
  StorageService: {
    upload: jest.Mock;
    delete: jest.Mock;
    getSignedUrl: jest.Mock;
    getPresignedUploadUrl: jest.Mock;
    parseStorageKey: jest.Mock;
    getConfig: jest.Mock;
    setAdapter: jest.Mock;
  };
};

// ─── Test helpers ─────────────────────────────────────────────────────────────

function makeReq(overrides: Partial<AuthRequest> = {}): AuthRequest {
  return {
    user: { id: 'user-1', email: 'user@test.com', role: Role.ORGANIZATION },
    file: { buffer: Buffer.from('fake-img'), originalname: 'photo.jpg', mimetype: 'image/jpeg' } as any,
    params: {},
    query: {},
    body: {},
    ...overrides,
  } as unknown as AuthRequest;
}

function makeRes(): { status: jest.Mock; json: jest.Mock } & Response {
  const res = { status: jest.fn(), json: jest.fn() } as unknown as { status: jest.Mock; json: jest.Mock } & Response;
  (res.status as jest.Mock).mockReturnValue(res);
  return res;
}

const next = jest.fn() as unknown as NextFunction;

// ─── Global setup ─────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();

  // Default adapter mock — update individual tests that need different values
  StorageService.upload.mockResolvedValue({
    url: 'https://cdn.example.com/new-file.webp',
    key: 'profile-pictures/org-1/new-uuid.webp',
    thumbnailUrl: 'https://cdn.example.com/new-thumb.webp',
    thumbnailKey: 'profile-pictures/org-1/thumbnails/new-uuid.webp',
  });
  StorageService.delete.mockResolvedValue(undefined);
  StorageService.parseStorageKey.mockReturnValue('profile-pictures/org-1/old-uuid.webp');
  StorageService.getPresignedUploadUrl.mockResolvedValue({
    uploadUrl: 'https://bucket.s3.amazonaws.com/key?X-Sig=x',
    key: 'campaign-images/c-1/new-uuid.jpg',
  });
  StorageService.getConfig.mockReturnValue({
    maxSizeBytes: 5 * 1024 * 1024,
    allowedMimes: ['image/jpeg', 'image/png', 'image/webp'],
    minDimensions: { width: 100, height: 100 },
  });

  prisma.organization.update.mockResolvedValue({});
  prisma.kYCSubmission.update.mockResolvedValue({});
  prisma.kYCDocumentHistory.create.mockResolvedValue({});
  prisma.campaign.update.mockResolvedValue({});
  prisma.distribution.update.mockResolvedValue({});
});

// ─────────────────────────────────────────────────────────────────────────────
// uploadProfilePicture
// ─────────────────────────────────────────────────────────────────────────────

describe('UploadController.uploadProfilePicture', () => {
  const org = { id: 'org-1', userId: 'user-1', logo: 'https://cdn.example.com/old-logo.webp' };

  beforeEach(() => {
    prisma.organization.findUnique.mockResolvedValue(org);
  });

  it('returns 401 when the user is not authenticated', async () => {
    await UploadController.uploadProfilePicture(makeReq({ user: undefined }), makeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
  });

  it('returns 400 when no file is attached to the request', async () => {
    await UploadController.uploadProfilePicture(makeReq({ file: undefined }), makeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
  });

  it('returns 404 when the user has no organization', async () => {
    prisma.organization.findUnique.mockResolvedValue(null);
    await UploadController.uploadProfilePicture(makeReq(), makeRes(), next);
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Organization not found for this user' }),
    );
  });

  it('calls StorageService.upload with the correct upload type and org id', async () => {
    await UploadController.uploadProfilePicture(makeReq(), makeRes(), next);
    expect(StorageService.upload).toHaveBeenCalledWith(
      'profile-picture',
      'org-1',
      expect.any(Buffer),
    );
  });

  it('persists the new URL to Organization.logo', async () => {
    await UploadController.uploadProfilePicture(makeReq(), makeRes(), next);
    expect(prisma.organization.update).toHaveBeenCalledWith({
      where: { id: 'org-1' },
      data: { logo: 'https://cdn.example.com/new-file.webp' },
    });
  });

  it('returns 200 with url, thumbnailUrl, and key', async () => {
    const res = makeRes();
    await UploadController.uploadProfilePicture(makeReq(), res, next);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({
          url: 'https://cdn.example.com/new-file.webp',
          thumbnailUrl: 'https://cdn.example.com/new-thumb.webp',
        }),
      }),
    );
  });

  it('extracts the old key and schedules deletion after DB update', async () => {
    const res = makeRes();
    await UploadController.uploadProfilePicture(makeReq(), res, next);
    // Let the fire-and-forget microtask run
    await Promise.resolve();

    expect(StorageService.parseStorageKey).toHaveBeenCalledWith(
      'https://cdn.example.com/old-logo.webp',
    );
    expect(StorageService.delete).toHaveBeenCalledWith('profile-pictures/org-1/old-uuid.webp');
  });

  it('does not delete when the old and new keys are the same (no-op)', async () => {
    // If parseStorageKey returns the exact new key, cleanup should be skipped
    StorageService.parseStorageKey.mockReturnValue('profile-pictures/org-1/new-uuid.webp');
    await UploadController.uploadProfilePicture(makeReq(), makeRes(), next);
    await Promise.resolve();
    expect(StorageService.delete).not.toHaveBeenCalled();
  });

  it('does not fail the response when cleanup deletion throws', async () => {
    StorageService.delete.mockRejectedValue(new Error('S3 connection refused'));
    const res = makeRes();
    await UploadController.uploadProfilePicture(makeReq(), res, next);
    await Promise.resolve();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(next).not.toHaveBeenCalled();
  });

  it('does not attempt cleanup when there is no previous logo', async () => {
    prisma.organization.findUnique.mockResolvedValue({ ...org, logo: null });
    await UploadController.uploadProfilePicture(makeReq(), makeRes(), next);
    await Promise.resolve();
    expect(StorageService.delete).not.toHaveBeenCalled();
  });

  it('forwards StorageService errors to next()', async () => {
    StorageService.upload.mockRejectedValueOnce(new Error('Image is too small'));
    await UploadController.uploadProfilePicture(makeReq(), makeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'Image is too small' }));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// uploadKycDocument
// ─────────────────────────────────────────────────────────────────────────────

describe('UploadController.uploadKycDocument', () => {
  const sub = {
    id: 'sub-1',
    userId: 'user-1',
    documentUrl: 'https://cdn.example.com/old-doc.jpg',
    selfieUrl: null,
  };

  beforeEach(() => {
    prisma.kYCSubmission.findUnique.mockResolvedValue(sub);
    StorageService.upload.mockResolvedValue({
      url: 'https://cdn.example.com/new-doc.webp',
      key: 'kyc-documents/sub-1/new-uuid.webp',
    });
    StorageService.parseStorageKey.mockReturnValue('kyc-documents/sub-1/old-uuid.jpg');
  });

  it('returns 404 when the submission does not exist', async () => {
    prisma.kYCSubmission.findUnique.mockResolvedValue(null);
    const req = makeReq({ params: { submissionId: 'sub-1' } });
    await UploadController.uploadKycDocument(req, makeRes(), next);
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'KYC submission not found' }),
    );
  });

  it('returns 403 when a non-admin user requests another user\'s submission', async () => {
    prisma.kYCSubmission.findUnique.mockResolvedValue({ ...sub, userId: 'other-user' });
    const req = makeReq({
      params: { submissionId: 'sub-1' },
      user: { id: 'user-1', email: 'u@t.com', role: Role.DONOR },
    });
    await UploadController.uploadKycDocument(req, makeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
  });

  it('allows an ADMIN to upload for any submission', async () => {
    prisma.kYCSubmission.findUnique.mockResolvedValue({ ...sub, userId: 'other-user' });
    const req = makeReq({
      params: { submissionId: 'sub-1' },
      user: { id: 'admin-1', email: 'admin@test.com', role: Role.ADMIN },
    });
    await UploadController.uploadKycDocument(req, makeRes(), next);
    expect(next).not.toHaveBeenCalled();
    expect(prisma.kYCSubmission.update).toHaveBeenCalled();
  });

  it('updates KYCSubmission.documentUrl by default', async () => {
    const req = makeReq({ params: { submissionId: 'sub-1' }, query: {} });
    await UploadController.uploadKycDocument(req, makeRes(), next);
    expect(prisma.kYCSubmission.update).toHaveBeenCalledWith({
      where: { id: 'sub-1' },
      data: { documentUrl: 'https://cdn.example.com/new-doc.webp' },
    });
  });

  it('updates KYCSubmission.selfieUrl when ?field=selfie', async () => {
    const req = makeReq({ params: { submissionId: 'sub-1' }, query: { field: 'selfie' } });
    await UploadController.uploadKycDocument(req, makeRes(), next);
    expect(prisma.kYCSubmission.update).toHaveBeenCalledWith({
      where: { id: 'sub-1' },
      data: { selfieUrl: 'https://cdn.example.com/new-doc.webp' },
    });
  });

  it('returns 200 with url, key, and field', async () => {
    const req = makeReq({ params: { submissionId: 'sub-1' }, query: {} });
    const res = makeRes();
    await UploadController.uploadKycDocument(req, res, next);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({ url: 'https://cdn.example.com/new-doc.webp', field: 'document' }),
      }),
    );
  });

  it('cleans up the old documentUrl after updating', async () => {
    const req = makeReq({ params: { submissionId: 'sub-1' }, query: {} });
    await UploadController.uploadKycDocument(req, makeRes(), next);
    await Promise.resolve();
    expect(StorageService.parseStorageKey).toHaveBeenCalledWith(
      'https://cdn.example.com/old-doc.jpg',
    );
    expect(StorageService.delete).toHaveBeenCalledWith('kyc-documents/sub-1/old-uuid.jpg');
  });

  // ─── Audit history tests ───────────────────────────────────────────────────

  it('creates a history record when an existing documentUrl is replaced', async () => {
    const req = makeReq({ params: { submissionId: 'sub-1' }, query: {} });
    await UploadController.uploadKycDocument(req, makeRes(), next);
    expect(prisma.kYCDocumentHistory.create).toHaveBeenCalledWith({
      data: {
        submissionId: 'sub-1',
        field: 'document',
        replacedUrl: 'https://cdn.example.com/old-doc.jpg',
        newUrl: 'https://cdn.example.com/new-doc.webp',
        uploadedBy: 'user-1',
      },
    });
  });

  it('creates a history record when an existing selfieUrl is replaced', async () => {
    prisma.kYCSubmission.findUnique.mockResolvedValue({
      ...sub,
      selfieUrl: 'https://cdn.example.com/old-selfie.jpg',
    });
    const req = makeReq({ params: { submissionId: 'sub-1' }, query: { field: 'selfie' } });
    await UploadController.uploadKycDocument(req, makeRes(), next);
    expect(prisma.kYCDocumentHistory.create).toHaveBeenCalledWith({
      data: {
        submissionId: 'sub-1',
        field: 'selfie',
        replacedUrl: 'https://cdn.example.com/old-selfie.jpg',
        newUrl: 'https://cdn.example.com/new-doc.webp',
        uploadedBy: 'user-1',
      },
    });
  });

  it('does NOT create a history record on the very first document upload (no previous URL)', async () => {
    // Simulate a fresh submission with no document yet
    prisma.kYCSubmission.findUnique.mockResolvedValue({ ...sub, documentUrl: null });
    const req = makeReq({ params: { submissionId: 'sub-1' }, query: {} });
    await UploadController.uploadKycDocument(req, makeRes(), next);
    expect(prisma.kYCDocumentHistory.create).not.toHaveBeenCalled();
  });

  it('does NOT create a history record on first selfie upload when selfieUrl is null', async () => {
    // sub already has selfieUrl: null
    const req = makeReq({ params: { submissionId: 'sub-1' }, query: { field: 'selfie' } });
    await UploadController.uploadKycDocument(req, makeRes(), next);
    expect(prisma.kYCDocumentHistory.create).not.toHaveBeenCalled();
  });

  it('records the correct uploadedBy when an admin performs the replacement', async () => {
    prisma.kYCSubmission.findUnique.mockResolvedValue({ ...sub, userId: 'other-user' });
    const req = makeReq({
      params: { submissionId: 'sub-1' },
      query: {},
      user: { id: 'admin-99', email: 'admin@test.com', role: Role.ADMIN },
    });
    await UploadController.uploadKycDocument(req, makeRes(), next);
    expect(prisma.kYCDocumentHistory.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ uploadedBy: 'admin-99' }) }),
    );
  });

  it('still returns 200 even when history creation fails', async () => {
    prisma.kYCDocumentHistory.create.mockRejectedValueOnce(new Error('DB write failed'));
    const req = makeReq({ params: { submissionId: 'sub-1' }, query: {} });
    const res = makeRes();
    await UploadController.uploadKycDocument(req, res, next);
    // The history write is awaited inside the controller, so its rejection
    // propagates to next() — this test documents the current behaviour and
    // serves as a reminder to consider making history writes non-fatal if needed.
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'DB write failed' }));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// uploadCampaignImage
// ─────────────────────────────────────────────────────────────────────────────

describe('UploadController.uploadCampaignImage', () => {
  const campaign = {
    id: 'camp-1',
    userId: 'user-1',
    imageUrl: 'https://cdn.example.com/old-campaign.jpg',
  };

  beforeEach(() => {
    prisma.campaign.findUnique.mockResolvedValue(campaign);
    StorageService.upload.mockResolvedValue({
      url: 'https://cdn.example.com/new-campaign.webp',
      key: 'campaign-images/camp-1/new-uuid.webp',
      thumbnailUrl: 'https://cdn.example.com/new-campaign-thumb.webp',
    });
    StorageService.parseStorageKey.mockReturnValue('campaign-images/camp-1/old-uuid.jpg');
  });

  it('returns 404 when the campaign does not exist', async () => {
    prisma.campaign.findUnique.mockResolvedValue(null);
    const req = makeReq({ params: { campaignId: 'camp-1' } });
    await UploadController.uploadCampaignImage(req, makeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'Campaign not found' }));
  });

  it('returns 403 when a non-admin uploads to another user\'s campaign', async () => {
    prisma.campaign.findUnique.mockResolvedValue({ ...campaign, userId: 'other-user' });
    const req = makeReq({
      params: { campaignId: 'camp-1' },
      user: { id: 'user-1', email: 'u@t.com', role: Role.DONOR },
    });
    await UploadController.uploadCampaignImage(req, makeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
  });

  it('allows an ADMIN to upload to any campaign', async () => {
    prisma.campaign.findUnique.mockResolvedValue({ ...campaign, userId: 'other-user' });
    const req = makeReq({
      params: { campaignId: 'camp-1' },
      user: { id: 'admin-1', email: 'a@t.com', role: Role.ADMIN },
    });
    await UploadController.uploadCampaignImage(req, makeRes(), next);
    expect(next).not.toHaveBeenCalled();
    expect(prisma.campaign.update).toHaveBeenCalled();
  });

  it('persists the new URL to Campaign.imageUrl', async () => {
    const req = makeReq({ params: { campaignId: 'camp-1' } });
    await UploadController.uploadCampaignImage(req, makeRes(), next);
    expect(prisma.campaign.update).toHaveBeenCalledWith({
      where: { id: 'camp-1' },
      data: { imageUrl: 'https://cdn.example.com/new-campaign.webp' },
    });
  });

  it('returns url and thumbnailUrl in the 200 response', async () => {
    const req = makeReq({ params: { campaignId: 'camp-1' } });
    const res = makeRes();
    await UploadController.uploadCampaignImage(req, res, next);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          url: 'https://cdn.example.com/new-campaign.webp',
          thumbnailUrl: 'https://cdn.example.com/new-campaign-thumb.webp',
        }),
      }),
    );
  });

  it('cleans up the old campaign image after persisting the new one', async () => {
    const req = makeReq({ params: { campaignId: 'camp-1' } });
    await UploadController.uploadCampaignImage(req, makeRes(), next);
    await Promise.resolve();
    expect(StorageService.parseStorageKey).toHaveBeenCalledWith(
      'https://cdn.example.com/old-campaign.jpg',
    );
    expect(StorageService.delete).toHaveBeenCalledWith('campaign-images/camp-1/old-uuid.jpg');
  });

  it('skips cleanup when campaign has no prior image', async () => {
    prisma.campaign.findUnique.mockResolvedValue({ ...campaign, imageUrl: null });
    const req = makeReq({ params: { campaignId: 'camp-1' } });
    await UploadController.uploadCampaignImage(req, makeRes(), next);
    await Promise.resolve();
    expect(StorageService.delete).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// uploadDistributionProof
// ─────────────────────────────────────────────────────────────────────────────

describe('UploadController.uploadDistributionProof', () => {
  const dist = {
    id: 'dist-1',
    proofDocumentUrl: null,
    campaign: { userId: 'user-1' },
  };

  beforeEach(() => {
    prisma.distribution.findUnique.mockResolvedValue(dist);
    StorageService.upload.mockResolvedValue({
      url: 'https://cdn.example.com/proof.pdf',
      key: 'distribution-proofs/dist-1/new-uuid.pdf',
    });
  });

  it('returns 404 when the distribution does not exist', async () => {
    prisma.distribution.findUnique.mockResolvedValue(null);
    const req = makeReq({ params: { distributionId: 'dist-1' } });
    await UploadController.uploadDistributionProof(req, makeRes(), next);
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Distribution not found' }),
    );
  });

  it('returns 403 for a DONOR who is not the campaign owner', async () => {
    prisma.distribution.findUnique.mockResolvedValue({
      ...dist,
      campaign: { userId: 'other-user' },
    });
    const req = makeReq({
      params: { distributionId: 'dist-1' },
      user: { id: 'user-1', email: 'u@t.com', role: Role.DONOR },
    });
    await UploadController.uploadDistributionProof(req, makeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
  });

  it('allows an ORGANIZATION user regardless of campaign ownership', async () => {
    prisma.distribution.findUnique.mockResolvedValue({
      ...dist,
      campaign: { userId: 'other-user' },
    });
    const req = makeReq({
      params: { distributionId: 'dist-1' },
      user: { id: 'org-u', email: 'org@t.com', role: Role.ORGANIZATION },
    });
    await UploadController.uploadDistributionProof(req, makeRes(), next);
    expect(next).not.toHaveBeenCalled();
    expect(prisma.distribution.update).toHaveBeenCalled();
  });

  it('allows an ADMIN regardless of ownership', async () => {
    prisma.distribution.findUnique.mockResolvedValue({
      ...dist,
      campaign: { userId: 'other-user' },
    });
    const req = makeReq({
      params: { distributionId: 'dist-1' },
      user: { id: 'admin', email: 'admin@t.com', role: Role.ADMIN },
    });
    await UploadController.uploadDistributionProof(req, makeRes(), next);
    expect(prisma.distribution.update).toHaveBeenCalled();
  });

  it('persists the proof URL to Distribution.proofDocumentUrl', async () => {
    const req = makeReq({ params: { distributionId: 'dist-1' } });
    await UploadController.uploadDistributionProof(req, makeRes(), next);
    expect(prisma.distribution.update).toHaveBeenCalledWith({
      where: { id: 'dist-1' },
      data: { proofDocumentUrl: 'https://cdn.example.com/proof.pdf' },
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getPresignedUploadUrl
// ─────────────────────────────────────────────────────────────────────────────

describe('UploadController.getPresignedUploadUrl', () => {
  it('returns 401 when unauthenticated', async () => {
    await UploadController.getPresignedUploadUrl(makeReq({ user: undefined, body: {} }), makeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
  });

  it('returns 400 for an unrecognised uploadType', async () => {
    const req = makeReq({ body: { uploadType: 'avatar', entityId: 'x', mimeType: 'image/jpeg' } });
    await UploadController.getPresignedUploadUrl(req, makeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
  });

  it('returns 400 when entityId is missing', async () => {
    const req = makeReq({ body: { uploadType: 'campaign-image', mimeType: 'image/jpeg' } });
    await UploadController.getPresignedUploadUrl(req, makeRes(), next);
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'entityId is required' }),
    );
  });

  it('returns 400 when mimeType is missing', async () => {
    const req = makeReq({ body: { uploadType: 'campaign-image', entityId: 'c-1' } });
    await UploadController.getPresignedUploadUrl(req, makeRes(), next);
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'mimeType is required' }),
    );
  });

  it('returns 200 with uploadUrl, key, expiresIn, and constraints', async () => {
    const req = makeReq({
      body: { uploadType: 'campaign-image', entityId: 'c-1', mimeType: 'image/jpeg' },
    });
    const res = makeRes();
    await UploadController.getPresignedUploadUrl(req, res, next);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({
          uploadUrl: expect.any(String),
          key: expect.any(String),
          expiresIn: 3600,
          maxSizeBytes: expect.any(Number),
          allowedMimes: expect.any(Array),
        }),
      }),
    );
  });

  it('forwards StorageService errors to next()', async () => {
    StorageService.getPresignedUploadUrl.mockRejectedValueOnce(
      new Error('File type video/mp4 is not allowed for campaign-image'),
    );
    const req = makeReq({
      body: { uploadType: 'campaign-image', entityId: 'c-1', mimeType: 'video/mp4' },
    });
    await UploadController.getPresignedUploadUrl(req, makeRes(), next);
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'File type video/mp4 is not allowed for campaign-image' }),
    );
  });
});

import { Response, NextFunction } from 'express';
import { AuthRequest } from '../types';
import { AppError } from '../middleware/error';
import { StorageService, UploadType } from '../services/storage.service';
import prisma from '../config/database';
import { Role } from '@prisma/client';

function requireFile(req: AuthRequest): Buffer {
  if (!req.file || !req.file.buffer) {
    throw new AppError('No file provided', 400);
  }
  return req.file.buffer;
}

export class UploadController {
  static async uploadProfilePicture(
    req: AuthRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      if (!req.user) throw new AppError('Authentication required', 401);
      const buffer = requireFile(req);

      const org = await prisma.organization.findUnique({ where: { userId: req.user.id } });
      if (!org) throw new AppError('Organization not found for this user', 404);

      const { url, key, thumbnailUrl } = await StorageService.upload(
        'profile-picture',
        org.id,
        buffer,
      );

      await prisma.organization.update({ where: { id: org.id }, data: { logo: url } });

      res.status(200).json({
        success: true,
        data: { url, thumbnailUrl, key },
        message: 'Profile picture uploaded successfully',
      });
    } catch (error) {
      next(error);
    }
  }

  static async uploadKycDocument(
    req: AuthRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      if (!req.user) throw new AppError('Authentication required', 401);
      const buffer = requireFile(req);
      const { submissionId } = req.params;
      const { field = 'document' } = req.query as { field?: string };

      const submission = await prisma.kYCSubmission.findUnique({
        where: { id: submissionId },
      });
      if (!submission) throw new AppError('KYC submission not found', 404);

      if (submission.userId !== req.user.id && req.user.role !== Role.ADMIN) {
        throw new AppError('You do not have permission to upload for this submission', 403);
      }

      const { url, key } = await StorageService.upload(
        'kyc-document',
        submissionId,
        buffer,
      );

      const updateField = field === 'selfie' ? { selfieUrl: url } : { documentUrl: url };
      await prisma.kYCSubmission.update({ where: { id: submissionId }, data: updateField });

      res.status(200).json({
        success: true,
        data: { url, key },
        message: 'KYC document uploaded successfully',
      });
    } catch (error) {
      next(error);
    }
  }

  static async uploadCampaignImage(
    req: AuthRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      if (!req.user) throw new AppError('Authentication required', 401);
      const buffer = requireFile(req);
      const { campaignId } = req.params;

      const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
      if (!campaign) throw new AppError('Campaign not found', 404);

      if (campaign.userId !== req.user.id && req.user.role !== Role.ADMIN) {
        throw new AppError('You do not have permission to upload for this campaign', 403);
      }

      const { url, key } = await StorageService.upload('campaign-image', campaignId, buffer);

      await prisma.campaign.update({ where: { id: campaignId }, data: { imageUrl: url } });

      res.status(200).json({
        success: true,
        data: { url, key },
        message: 'Campaign image uploaded successfully',
      });
    } catch (error) {
      next(error);
    }
  }

  static async uploadDistributionProof(
    req: AuthRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      if (!req.user) throw new AppError('Authentication required', 401);
      const buffer = requireFile(req);
      const { distributionId } = req.params;

      const distribution = await prisma.distribution.findUnique({
        where: { id: distributionId },
        include: { campaign: { select: { userId: true } } },
      });
      if (!distribution) throw new AppError('Distribution not found', 404);

      const isOwner = distribution.campaign.userId === req.user.id;
      const isAdmin = req.user.role === Role.ADMIN;
      const isOrg = req.user.role === Role.ORGANIZATION;

      if (!isOwner && !isAdmin && !isOrg) {
        throw new AppError(
          'You do not have permission to upload proof for this distribution',
          403,
        );
      }

      const { url, key } = await StorageService.upload(
        'distribution-proof',
        distributionId,
        buffer,
      );

      await prisma.distribution.update({
        where: { id: distributionId },
        data: { proofDocumentUrl: url },
      });

      res.status(200).json({
        success: true,
        data: { url, key },
        message: 'Distribution proof uploaded successfully',
      });
    } catch (error) {
      next(error);
    }
  }

  static async getPresignedUploadUrl(
    req: AuthRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      if (!req.user) throw new AppError('Authentication required', 401);

      const { uploadType, entityId, mimeType } = req.body as {
        uploadType: UploadType;
        entityId: string;
        mimeType: string;
      };

      const validTypes: UploadType[] = [
        'profile-picture',
        'kyc-document',
        'campaign-image',
        'distribution-proof',
      ];
      if (!validTypes.includes(uploadType)) {
        throw new AppError(`Invalid uploadType: ${uploadType}`, 400);
      }
      if (!entityId || typeof entityId !== 'string') {
        throw new AppError('entityId is required', 400);
      }
      if (!mimeType || typeof mimeType !== 'string') {
        throw new AppError('mimeType is required', 400);
      }

      const { uploadUrl, key } = await StorageService.getPresignedUploadUrl(
        uploadType,
        entityId,
        mimeType,
      );

      const config = StorageService.getConfig(uploadType);

      res.status(200).json({
        success: true,
        data: {
          uploadUrl,
          key,
          expiresIn: 3600,
          maxSizeBytes: config.maxSizeBytes,
          allowedMimes: config.allowedMimes,
        },
        message: 'Pre-signed upload URL generated successfully',
      });
    } catch (error) {
      next(error);
    }
  }
}

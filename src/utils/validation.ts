import { z } from 'zod';

export const registerSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  username: z.string().min(3).max(30).optional(),
  role: z.enum(['ADMIN', 'ORGANIZATION', 'DONOR', 'BENEFICIARY', 'VERIFIER', 'AUDITOR']).optional(),
});

export const loginSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(1, 'Password is required'),
});

export const walletAuthSchema = z.object({
  walletAddress: z.string().min(1, 'Wallet address is required'),
  signature: z.string().min(1, 'Signature is required'),
  message: z.string().min(1, 'Message is required'),
});

export const campaignSchema = z.object({
  title: z.string().min(5, 'Title must be at least 5 characters'),
  description: z.string().min(20, 'Description must be at least 20 characters'),
  imageUrl: z.string().url('Invalid image URL').optional(),
  targetAmount: z.number().positive('Target amount must be positive'),
  startDate: z.coerce.date(),
  endDate: z.coerce.date().optional(),
});

export const donationSchema = z.object({
  campaignId: z.string().min(1, 'Campaign ID is required'),
  amount: z.number().positive('Amount must be positive'),
  currency: z.string().default('XLM'),
  isAnonymous: z.boolean().default(false),
  donorMessage: z.string().optional(),
});

export const beneficiarySchema = z.object({
  firstName: z.string().min(2, 'First name must be at least 2 characters'),
  lastName: z.string().min(2, 'Last name must be at least 2 characters'),
  dateOfBirth: z.coerce.date(),
  gender: z.string().min(1, 'Gender is required'),
  nationality: z.string().min(1, 'Nationality is required'),
  idDocumentType: z.string().min(1, 'Document type is required'),
  idDocumentNumber: z.string().min(1, 'Document number is required'),
  phoneNumber: z.string().min(10, 'Phone number must be at least 10 characters'),
  address: z.string().min(10, 'Address must be at least 10 characters'),
  city: z.string().min(2, 'City is required'),
  country: z.string().min(2, 'Country is required'),
  familySize: z.number().int().positive().default(1),
  needsAssessment: z.string().optional(),
});

export const distributionSchema = z.object({
  campaignId: z.string().min(1, 'Campaign ID is required'),
  beneficiaryId: z.string().min(1, 'Beneficiary ID is required'),
  amount: z.number().positive('Amount must be positive'),
  currency: z.string().default('XLM'),
  method: z.enum(['CASH', 'BANK_TRANSFER', 'MOBILE_MONEY', 'CRYPTO', 'VOUCHER', 'IN_KIND']),
  notes: z.string().optional(),
});

export const kycSubmissionSchema = z.object({
  submissionType: z.enum(['INDIVIDUAL', 'ORGANIZATION']),
  documentType: z.string().min(1, 'Document type is required'),
  documentUrl: z.string().url('Invalid document URL'),
  selfieUrl: z.string().url('Invalid selfie URL').optional(),
  additionalDocs: z.any().optional(),
});

export const fraudReportSchema = z.object({
  type: z.enum(['SCAM', 'MISINFORMATION', 'INAPPROPRIATE_CONTENT', 'IMPERSONATION', 'DUPLICATE', 'OTHER']),
  details: z.string().max(2000).optional(),
});

export const appealSchema = z.object({
  message: z.string().min(10, 'Appeal message must be at least 10 characters').max(5000),
  attachments: z.array(z.string().url('Each attachment must be a valid URL')).max(10).optional(),
});

export const suspendCampaignSchema = z.object({
  reasonCode: z.enum(['LOW_VERIFICATION', 'FRAUD_REPORTS', 'POLICY_VIOLATION', 'MANUAL_REVIEW', 'OTHER']),
  reasonText: z.string().max(2000).optional(),
  evidence: z.array(z.string()).max(20).optional(),
});

export const reinstateCampaignSchema = z.object({
  adminNotes: z.string().max(2000).optional(),
});

export const resolveAppealSchema = z.object({
  decision: z.enum(['APPROVE', 'DENY']),
  adminNotes: z.string().max(2000).optional(),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type WalletAuthInput = z.infer<typeof walletAuthSchema>;
export type CampaignInput = z.infer<typeof campaignSchema>;
export type DonationInput = z.infer<typeof donationSchema>;
export type BeneficiaryInput = z.infer<typeof beneficiarySchema>;
export type DistributionInput = z.infer<typeof distributionSchema>;
export type KYCSubmissionInput = z.infer<typeof kycSubmissionSchema>;

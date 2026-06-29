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

export const organizationSchema = z.object({
  userId: z.string().optional(),
  name: z.string().min(2, 'Organization name must be at least 2 characters'),
  email: z.string().email('Invalid organization email'),
  country: z.string().min(2, 'Country is required'),
  registrationNumber: z.string().min(1, 'Registration number is required'),
  representativeContact: z.object({
    name: z.string().min(1, 'Representative name is required'),
    email: z.string().email('Invalid representative email').optional(),
    phone: z.string().min(3).optional(),
  }).passthrough(),
  website: z.string().url('Invalid website URL').optional(),
  description: z.string().max(5000).optional(),
  address: z.any().optional(),
  taxId: z.string().optional(),
  legalDocuments: z.any().optional(),
  supportingMetadata: z.any().optional(),
});

export const organizationUpdateSchema = organizationSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  'At least one organization field is required'
);

export const bankAccountSchema = z.object({
  accountHolderName: z.string().min(1, 'Account holder name is required'),
  accountNumber: z.string().min(4, 'Account number is required'),
  routingCode: z.string().min(2, 'Routing code or IBAN is required'),
  iban: z.string().optional(),
  bankName: z.string().min(1, 'Bank name is required'),
  currency: z.string().min(3).max(3),
  branchCode: z.string().optional(),
  country: z.string().optional(),
  accountType: z.string().optional(),
  isPrimary: z.boolean().optional(),
  metadata: z.any().optional(),
});

export const bankAccountUpdateSchema = bankAccountSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  'At least one bank account field is required'
);

export const organizationVerificationSchema = z.object({
  registrationDocs: z.array(z.string().min(1)).min(1, 'At least one registration document is required'),
  taxId: z.string().min(1, 'Tax ID is required'),
  representativeId: z.string().min(1, 'Representative ID is required'),
  bankVerificationInfo: z.unknown().refine((value) => value !== undefined, 'Bank verification info is required'),
  notes: z.string().max(2000).optional(),
});

export const organizationReviewSchema = z.object({
  notes: z.string().max(2000).optional(),
});

export const organizationRejectSchema = z.object({
  reason: z.string().min(1, 'Reason is required').max(2000),
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

export const beneficiarySearchSchema = z
  .object({
    q: z.string().trim().min(1).optional(),
    country: z.string().trim().min(1).optional(),
    city: z.string().trim().min(1).optional(),
    needsCategory: z.string().trim().min(1).optional(),
    verificationStatus: z
      .enum(['PENDING', 'VERIFIED', 'REJECTED', 'SUSPENDED', 'ACTIVE'])
      .optional(),
    riskScoreMin: z.coerce.number().int().min(0).optional(),
    riskScoreMax: z.coerce.number().int().min(0).optional(),
    ageMin: z.coerce.number().int().min(0).max(150).optional(),
    ageMax: z.coerce.number().int().min(0).max(150).optional(),
    familySizeMin: z.coerce.number().int().min(0).optional(),
    familySizeMax: z.coerce.number().int().min(0).optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    sortBy: z
      .enum(['relevance', 'createdAt', 'updatedAt', 'riskScore', 'age', 'familySize'])
      .default('createdAt'),
    sortOrder: z.enum(['asc', 'desc']).default('desc'),
  })
  .refine(
    (d) => d.riskScoreMin === undefined || d.riskScoreMax === undefined || d.riskScoreMin <= d.riskScoreMax,
    { message: 'riskScoreMin must be less than or equal to riskScoreMax', path: ['riskScoreMin'] }
  )
  .refine((d) => d.ageMin === undefined || d.ageMax === undefined || d.ageMin <= d.ageMax, {
    message: 'ageMin must be less than or equal to ageMax',
    path: ['ageMin'],
  })
  .refine(
    (d) =>
      d.familySizeMin === undefined || d.familySizeMax === undefined || d.familySizeMin <= d.familySizeMax,
    { message: 'familySizeMin must be less than or equal to familySizeMax', path: ['familySizeMin'] }
  );

  export const milestoneSubmissionSchema = z.object({
  description: z.string().min(10, 'Description must be at least 10 characters').max(5000),
  evidenceUrls: z
    .array(z.string().url('Each evidence URL must be a valid URL'))
    .min(1, 'At least one evidence URL is required')
    .max(20),
  metricsData: z.record(z.unknown()).default({}),
  submissionNotes: z.string().max(2000).optional(),
});

export const milestoneSubmissionUpdateSchema = milestoneSubmissionSchema
  .partial()
  .refine((v: object) => Object.keys(v).length > 0, 'At least one field is required');

export const milestoneReviewSchema = z.object({
  decision: z.enum(['APPROVED', 'REJECTED', 'REVISION_REQUESTED']),
  reason: z.string().min(1).max(2000).optional(),
  verifierNotes: z.string().max(2000).optional(),
  metricsConfirmed: z.record(z.unknown()).optional(),
  impactSummary: z.string().max(2000).optional(),
});

export const generateBatchReceiptsSchema = z
  .object({
    organizationId: z.string().min(1).optional(),
    campaignId: z.string().min(1).optional(),
    donationIds: z.array(z.string().min(1)).min(1).max(1000).optional(),
    dateRange: z
      .object({
        from: z.coerce.date().optional(),
        to: z.coerce.date().optional(),
      })
      .optional(),
    region: z.string().min(2).max(8).optional(),
  })
  .refine(
    (data) =>
      Boolean(
        data.organizationId ||
          data.campaignId ||
          (data.donationIds && data.donationIds.length > 0) ||
          data.dateRange?.from ||
          data.dateRange?.to,
      ),
    {
      message:
        'At least one filter is required (organizationId, campaignId, donationIds, or dateRange)',
    },
  );

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type WalletAuthInput = z.infer<typeof walletAuthSchema>;
export type CampaignInput = z.infer<typeof campaignSchema>;
export type DonationInput = z.infer<typeof donationSchema>;
export type BeneficiaryInput = z.infer<typeof beneficiarySchema>;
export type OrganizationInput = z.infer<typeof organizationSchema>;
export type DistributionInput = z.infer<typeof distributionSchema>;
export type KYCSubmissionInput = z.infer<typeof kycSubmissionSchema>;
export type BeneficiarySearchInput = z.infer<typeof beneficiarySearchSchema>;
export type GenerateBatchReceiptsInput = z.infer<typeof generateBatchReceiptsSchema>;

import { Request } from 'express';
import { Role, DistributionMethod } from '@prisma/client';

export interface AuthRequest extends Request {
  user?: {
    id: string;
    email: string;
    role: Role;
  };
  file?: Express.Multer.File;
}

export interface JWTPayload {
  id: string;
  email: string;
  role: Role;
  iat?: number;
  exp?: number;
}

export interface WalletAuthPayload {
  walletAddress: string;
  signature: string;
  message: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export interface LoginCredentials {
  email: string;
  password: string;
}

export interface RegisterData {
  email: string;
  password: string;
  username?: string;
  role?: Role;
}

export interface PaginationParams {
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  message?: string;
  error?: string;
  errors?: Record<string, string>;
}

export interface CampaignFilters {
  status?: string;
  organizationId?: string;
  startDate?: Date;
  endDate?: Date;
  search?: string;
}

export interface DonationFilters {
  campaignId?: string;
  userId?: string;
  status?: string;
  startDate?: Date;
  endDate?: Date;
}

export interface BeneficiaryFilters {
  status?: string;
  country?: string;
  city?: string;
  riskScore?: number;
  search?: string;
}

export interface BeneficiaryInput {
  firstName: string;
  lastName: string;
  dateOfBirth: Date;
  gender: string;
  nationality: string;
  idDocumentType: string;
  idDocumentNumber: string;
  phoneNumber: string;
  country: string;
  city: string;
  address: string;
  familySize?: number;
  needsDescription: string;
  needsAssessment?: string;
  needsCategory?: string;
}

export interface CampaignInput {
  title: string;
  description: string;
  imageUrl?: string;
  targetAmount: number;
  startDate: Date;
  endDate?: Date;
  organizationId: string;
}

export interface DonationInput {
  campaignId: string;
  amount: number;
  currency?: string;
  donorName?: string;
  donorEmail?: string;
  message?: string;
  isAnonymous?: boolean;
}

export interface DistributionInput {
  campaignId: string;
  beneficiaryId: string;
  amount: number;
  method: DistributionMethod;
  description?: string;
}

export interface TrendingCampaignFilters {
  period?: 'last24h' | 'last7d' | 'last30d';
  sortBy?: 'trendScore' | 'donationVelocity' | 'distributionImpact';
  limit?: number;
}

export interface TrendingCampaign {
  campaignId: string;
  title: string;
  imageUrl: string | null;
  status: string;
  currentAmount: number;
  targetAmount: number;
  trendScore: number;
  donationVelocity: number;
  donorGrowth: number;
  distributionImpact: number;
  period: string;
  rank: number;
  organization: {
    id: string;
    name: string;
    logo: string | null;
  };
}

export interface ImpactMetrics {
  campaignId: string;
  title: string;
  totalDonations: number;
  totalRaised: number;
  donorGrowth: number;
  totalDistributions: number;
  totalDistributedAmount: number;
  beneficiariesReached: number;
  conversionRate: number;
  avgDonationAmount: number;
  progressPercentage: number;
  impactScore: number;
}

export interface HistoricalStats {
  campaignId: string;
  granularity: 'hourly' | 'monthly';
  data: Array<{
    timestamp: Date;
    donationCount: number;
    donationVolume: number;
    uniqueDonors: number;
    distributionCount: number;
    distributionVolume: number;
    itemsDistributed: number;
    donorGrowth?: number;
    distributionReach?: number;
    campaignActivity?: number;
    activeDonors: number;
  }>;
}

export interface CampaignAnalyticsFilters {
  status?: string;
  startDate?: Date;
  endDate?: Date;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

import { Role, CampaignStatus } from '@prisma/client';
import prisma from '../config/database';
import redis from '../config/redis';
import logger from '../config/logger';

export interface AuthorizationContext {
  userId: string;
  userRole: Role;
}

export interface AuthorizationResult {
  authorized: boolean;
  reason?: 'forbidden' | 'invalid_input' | 'not_found';
}

const CACHE_TTL_SECONDS = 30;
const CACHE_KEY_PREFIX = 'ws-auth';

/**
 * Validates a resource ID (campaignId, organizationId, beneficiaryId)
 * Guards against empty strings, overly large inputs, and prototype pollution
 */
export function validateResourceId(id: unknown): id is string {
  if (typeof id !== 'string') {
    return false;
  }
  
  // Check for empty string
  if (id.length === 0) {
    return false;
  }
  
  // Check for overly large inputs (500 chars max as per requirements)
  if (id.length > 500) {
    return false;
  }
  
  // Check for prototype pollution attempts
  if (id === '__proto__' || id === 'constructor' || id === 'prototype') {
    return false;
  }
  
  return true;
}

/**
 * Generates a cache key for authorization results
 */
function getCacheKey(userId: string, room: string): string {
  return `${CACHE_KEY_PREFIX}:${userId}:${room}`;
}

/**
 * Retrieves cached authorization result
 */
async function getCachedAuthorization(userId: string, room: string): Promise<boolean | null> {
  try {
    const cached = await redis.get(getCacheKey(userId, room));
    if (cached !== null) {
      return cached === '1';
    }
  } catch (error) {
    logger.error('Redis cache get error:', error);
  }
  return null;
}

/**
 * Caches authorization result
 */
async function setCachedAuthorization(userId: string, room: string, authorized: boolean): Promise<void> {
  try {
    await redis.setex(getCacheKey(userId, room), CACHE_TTL_SECONDS, authorized ? '1' : '0');
  } catch (error) {
    logger.error('Redis cache set error:', error);
  }
}

/**
 * Invalidates all cached authorization results for a specific campaign
 * Used when a campaign is suspended
 */
export async function invalidateCampaignAuthorizationCache(campaignId: string): Promise<void> {
  try {
    const pattern = `${CACHE_KEY_PREFIX}:*:campaign:${campaignId}`;
    const keys: string[] = [];
    
    // Use scanStream to avoid blocking Redis with KEYS command
    for await (const keyBatch of redis.scanStream({ match: pattern, count: 100 })) {
      keys.push(...keyBatch);
    }
    
    if (keys.length > 0) {
      await redis.del(...keys);
      logger.info(`Invalidated ${keys.length} authorization cache entries for campaign ${campaignId}`);
    }
  } catch (error) {
    logger.error('Redis cache invalidation error:', error);
  }
}

/**
 * Checks if a user is authorized to join a campaign room
 * Authorization rules:
 * - ADMIN/AUDITOR: always authorized
 * - ORGANIZATION: authorized if they own the campaign (Campaign.userId = userId)
 * - Any authenticated user: authorized if campaign status is ACTIVE or COMPLETED
 */
export async function authorizeCampaignJoin(
  context: AuthorizationContext,
  campaignId: string
): Promise<AuthorizationResult> {
  // Input validation
  if (!validateResourceId(campaignId)) {
    return { authorized: false, reason: 'invalid_input' };
  }

  const room = `campaign:${campaignId}`;
  
  // Check cache first
  const cached = await getCachedAuthorization(context.userId, room);
  if (cached !== null) {
    return { authorized: cached };
  }

  // ADMIN and AUDITOR always have access
  if (context.userRole === Role.ADMIN || context.userRole === Role.AUDITOR) {
    await setCachedAuthorization(context.userId, room, true);
    return { authorized: true };
  }

  // Fetch campaign from database
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { userId: true, status: true },
  });

  if (!campaign) {
    return { authorized: false, reason: 'not_found' };
  }

  // ORGANIZATION users can join if they own the campaign
  if (context.userRole === Role.ORGANIZATION && campaign.userId === context.userId) {
    await setCachedAuthorization(context.userId, room, true);
    return { authorized: true };
  }

  // Any authenticated user can join if campaign is ACTIVE or COMPLETED (public read)
  if (campaign.status === CampaignStatus.ACTIVE || campaign.status === CampaignStatus.COMPLETED) {
    await setCachedAuthorization(context.userId, room, true);
    return { authorized: true };
  }

  await setCachedAuthorization(context.userId, room, false);
  return { authorized: false, reason: 'forbidden' };
}

/**
 * Checks if a user is authorized to join an organization room
 * Authorization rules:
 * - ADMIN/AUDITOR: always authorized
 * - The organization's owner (Organization.userId = userId)
 */
export async function authorizeOrganizationJoin(
  context: AuthorizationContext,
  organizationId: string
): Promise<AuthorizationResult> {
  // Input validation
  if (!validateResourceId(organizationId)) {
    return { authorized: false, reason: 'invalid_input' };
  }

  const room = `organization:${organizationId}`;
  
  // Check cache first
  const cached = await getCachedAuthorization(context.userId, room);
  if (cached !== null) {
    return { authorized: cached };
  }

  // ADMIN and AUDITOR always have access
  if (context.userRole === Role.ADMIN || context.userRole === Role.AUDITOR) {
    await setCachedAuthorization(context.userId, room, true);
    return { authorized: true };
  }

  // Fetch organization from database
  const organization = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { userId: true },
  });

  if (!organization) {
    return { authorized: false, reason: 'not_found' };
  }

  // User can join if they own the organization
  if (organization.userId === context.userId) {
    await setCachedAuthorization(context.userId, room, true);
    return { authorized: true };
  }

  await setCachedAuthorization(context.userId, room, false);
  return { authorized: false, reason: 'forbidden' };
}

/**
 * Checks if a user is authorized to join a beneficiary room
 * Authorization rules:
 * - ADMIN/AUDITOR/VERIFIER: always authorized
 * - The beneficiary themselves (Beneficiary.userId = userId)
 * - ORGANIZATION if the beneficiary is assigned to one of their campaigns
 */
export async function authorizeBeneficiaryJoin(
  context: AuthorizationContext,
  beneficiaryId: string
): Promise<AuthorizationResult> {
  // Input validation
  if (!validateResourceId(beneficiaryId)) {
    return { authorized: false, reason: 'invalid_input' };
  }

  const room = `beneficiary:${beneficiaryId}`;
  
  // Check cache first
  const cached = await getCachedAuthorization(context.userId, room);
  if (cached !== null) {
    return { authorized: cached };
  }

  // ADMIN, AUDITOR, and VERIFIER always have access
  if (
    context.userRole === Role.ADMIN ||
    context.userRole === Role.AUDITOR ||
    context.userRole === Role.VERIFIER
  ) {
    await setCachedAuthorization(context.userId, room, true);
    return { authorized: true };
  }

  // Fetch beneficiary from database
  const beneficiary = await prisma.beneficiary.findUnique({
    where: { id: beneficiaryId },
    select: { userId: true },
  });

  if (!beneficiary) {
    return { authorized: false, reason: 'not_found' };
  }

  // Beneficiary can join their own room
  if (beneficiary.userId === context.userId) {
    await setCachedAuthorization(context.userId, room, true);
    return { authorized: true };
  }

  // ORGANIZATION users can join if beneficiary is assigned to one of their campaigns
  if (context.userRole === Role.ORGANIZATION) {
    // Check if beneficiary is assigned to any campaign owned by this organization
    const assignment = await prisma.beneficiaryAssignment.findFirst({
      where: {
        beneficiaryId,
        campaign: {
          userId: context.userId,
        },
      },
    });

    if (assignment) {
      await setCachedAuthorization(context.userId, room, true);
      return { authorized: true };
    }
  }

  await setCachedAuthorization(context.userId, room, false);
  return { authorized: false, reason: 'forbidden' };
}

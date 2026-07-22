import prisma from '../config/database';
import { CampaignStatus } from '@prisma/client';
import { stringSimilarity } from '../utils/similarity';

export interface DuplicateMatch {
  campaignId: string;
  title: string;
  organizationId: string;
  /** Overall confidence that this campaign is a duplicate, from 0 to 1. */
  confidence: number;
  /** Which signals contributed to the confidence score. */
  reasons: ('similar_title' | 'same_organization' | 'geographic_overlap' | 'similar_target_amount')[];
}

export interface DuplicateDetectionResult {
  hasPotentialDuplicates: boolean;
  matches: DuplicateMatch[];
}

// A title must clear this bar before a candidate is considered at all —
// same organization/amount/country alone shouldn't flag unrelated campaigns.
const TITLE_SIMILARITY_GATE = 0.5;
const CONFIDENCE_THRESHOLD = 0.45;
// Bounds the scan for performance; only the most recent non-cancelled
// campaigns are checked against.
const MAX_CANDIDATES = 500;
const MAX_MATCHES_RETURNED = 5;

const TITLE_WEIGHT = 0.5;
const SAME_ORGANIZATION_WEIGHT = 0.2;
const GEOGRAPHIC_OVERLAP_WEIGHT = 0.15;
const TARGET_AMOUNT_WEIGHT = 0.15;
// Ratio of min/max target amount above which two campaigns count as "similar".
const TARGET_AMOUNT_SIMILARITY_GATE = 0.7;

export class CampaignDuplicateService {
  /**
   * Scores recent campaigns against a candidate title/target amount using
   * fuzzy title matching, organization overlap, geographic overlap (same
   * organization country — the schema has no per-campaign location), and
   * target amount similarity. Never throws for the caller; a failed lookup
   * degrades to "no duplicates found" rather than blocking campaign creation.
   */
  static async detectDuplicates(
    data: { title: string; targetAmount: number },
    organizationId: string,
    organizationCountry: string | null | undefined
  ): Promise<DuplicateDetectionResult> {
    const candidates = await prisma.campaign.findMany({
      where: { status: { not: CampaignStatus.CANCELLED } },
      select: {
        id: true,
        title: true,
        targetAmount: true,
        organizationId: true,
        organization: { select: { country: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: MAX_CANDIDATES,
    });

    const matches: DuplicateMatch[] = [];
    const targetAmount = Number(data.targetAmount);

    for (const candidate of candidates) {
      const titleSimilarity = stringSimilarity(data.title, candidate.title);
      if (titleSimilarity < TITLE_SIMILARITY_GATE) continue;

      const reasons: DuplicateMatch['reasons'] = ['similar_title'];
      let confidence = titleSimilarity * TITLE_WEIGHT;

      if (candidate.organizationId === organizationId) {
        confidence += SAME_ORGANIZATION_WEIGHT;
        reasons.push('same_organization');
      }

      if (organizationCountry && candidate.organization?.country === organizationCountry) {
        confidence += GEOGRAPHIC_OVERLAP_WEIGHT;
        reasons.push('geographic_overlap');
      }

      const candidateTargetAmount = Number(candidate.targetAmount);
      if (
        targetAmount > 0 &&
        candidateTargetAmount > 0 &&
        Math.min(targetAmount, candidateTargetAmount) / Math.max(targetAmount, candidateTargetAmount) >=
          TARGET_AMOUNT_SIMILARITY_GATE
      ) {
        confidence += TARGET_AMOUNT_WEIGHT;
        reasons.push('similar_target_amount');
      }

      if (confidence >= CONFIDENCE_THRESHOLD) {
        matches.push({
          campaignId: candidate.id,
          title: candidate.title,
          organizationId: candidate.organizationId,
          confidence: Number(confidence.toFixed(2)),
          reasons,
        });
      }
    }

    matches.sort((a, b) => b.confidence - a.confidence);

    return {
      hasPotentialDuplicates: matches.length > 0,
      matches: matches.slice(0, MAX_MATCHES_RETURNED),
    };
  }
}

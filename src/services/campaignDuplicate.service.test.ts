import { CampaignDuplicateService } from './campaignDuplicate.service';
import { CampaignStatus } from '@prisma/client';

jest.mock('../config/database', () => ({
  __esModule: true,
  default: {
    campaign: { findMany: jest.fn() },
  },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const prismaMock = require('../config/database').default;

describe('CampaignDuplicateService.detectDuplicates', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns no matches when there are no candidates', async () => {
    prismaMock.campaign.findMany.mockResolvedValue([]);

    const result = await CampaignDuplicateService.detectDuplicates(
      { title: 'Emergency Relief Fund', targetAmount: 10000 },
      'org-1',
      'KE'
    );

    expect(result.hasPotentialDuplicates).toBe(false);
    expect(result.matches).toEqual([]);
  });

  it('flags a near-identical title in the same organization as a high-confidence duplicate', async () => {
    prismaMock.campaign.findMany.mockResolvedValue([
      {
        id: 'campaign-1',
        title: 'Emergency Relief Fund',
        targetAmount: 10500,
        organizationId: 'org-1',
        organization: { country: 'KE' },
      },
    ]);

    const result = await CampaignDuplicateService.detectDuplicates(
      { title: 'Emergency Relief Fund', targetAmount: 10000 },
      'org-1',
      'KE'
    );

    expect(result.hasPotentialDuplicates).toBe(true);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({ campaignId: 'campaign-1', confidence: expect.any(Number) });
    expect(result.matches[0].reasons).toEqual(
      expect.arrayContaining(['similar_title', 'same_organization', 'geographic_overlap', 'similar_target_amount'])
    );
    expect(result.matches[0].confidence).toBeGreaterThan(0.9);
  });

  it('does not flag campaigns with dissimilar titles even if org/amount match', async () => {
    prismaMock.campaign.findMany.mockResolvedValue([
      {
        id: 'campaign-1',
        title: 'Annual Charity Gala',
        targetAmount: 10000,
        organizationId: 'org-1',
        organization: { country: 'KE' },
      },
    ]);

    const result = await CampaignDuplicateService.detectDuplicates(
      { title: 'Emergency Relief Fund', targetAmount: 10000 },
      'org-1',
      'KE'
    );

    expect(result.hasPotentialDuplicates).toBe(false);
  });

  it('gives a lower confidence score to a similar title from a different organization with no geo overlap', async () => {
    prismaMock.campaign.findMany.mockResolvedValue([
      {
        id: 'campaign-1',
        title: 'Emergency Relief Fund',
        targetAmount: 500,
        organizationId: 'org-2',
        organization: { country: 'NG' },
      },
    ]);

    const result = await CampaignDuplicateService.detectDuplicates(
      { title: 'Emergency Relief Fund', targetAmount: 10000 },
      'org-1',
      'KE'
    );

    expect(result.matches[0].reasons).toEqual(['similar_title']);
    expect(result.matches[0].confidence).toBeLessThan(0.6);
  });

  it('excludes cancelled campaigns from the candidate query', async () => {
    prismaMock.campaign.findMany.mockResolvedValue([]);

    await CampaignDuplicateService.detectDuplicates({ title: 'Test', targetAmount: 100 }, 'org-1', null);

    expect(prismaMock.campaign.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: { not: CampaignStatus.CANCELLED } } })
    );
  });

  it('returns at most 5 matches, sorted by confidence descending', async () => {
    const candidates = Array.from({ length: 8 }, (_, i) => ({
      id: `campaign-${i}`,
      title: `Emergency Relief Fund ${i}`,
      targetAmount: 10000,
      organizationId: 'org-1',
      organization: { country: 'KE' },
    }));
    prismaMock.campaign.findMany.mockResolvedValue(candidates);

    const result = await CampaignDuplicateService.detectDuplicates(
      { title: 'Emergency Relief Fund', targetAmount: 10000 },
      'org-1',
      'KE'
    );

    expect(result.matches.length).toBeLessThanOrEqual(5);
    const confidences = result.matches.map((m) => m.confidence);
    expect(confidences).toEqual([...confidences].sort((a, b) => b - a));
  });
});

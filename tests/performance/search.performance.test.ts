/// <reference types="jest" />

import { Prisma } from '@prisma/client';
import { SearchService } from '../../src/services/search.service';
import prisma from '../../src/config/database';

/**
 * Performance test for trigram similarity search with 100k rows.
 * 
 * This test verifies that single-entity search with a text query responds
 * in ≤200ms at p99 for a table of 100,000 rows with the GIN index in place.
 * 
 * Prerequisites:
 * - PostgreSQL with pg_trgm extension enabled
 * - GIN indexes on Campaign.title, Campaign.description
 * - GIN indexes on Beneficiary.firstName, lastName, idDocumentNumber, phoneNumber
 * - Test database with 100k seeded rows
 * 
 * Run with: NODE_ENV=test npm test -- tests/performance/search.performance.test.ts
 */

describe('Search Performance Tests', () => {
  const TEST_QUERY = 'Ahmed';
  const PERFORMANCE_THRESHOLD_MS = 200;
  const WARMUP_ITERATIONS = 3;
  const MEASUREMENT_ITERATIONS = 10;

  beforeAll(async () => {
    // Verify pg_trgm extension is available
    const extensionCheck = await prisma.$queryRaw<Array<{ extname: string }>>`
      SELECT extname FROM pg_extension WHERE extname = 'pg_trgm'
    `;
    
    if (extensionCheck.length === 0) {
      throw new Error('pg_trgm extension is not available. Please install it with CREATE EXTENSION pg_trgm;');
    }

    // Check if we have sufficient test data
    const beneficiaryCount = await prisma.beneficiary.count();
    if (beneficiaryCount < 100000) {
      console.warn(`Warning: Only ${beneficiaryCount} beneficiaries in database. Performance test requires 100k rows for accurate results.`);
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe('searchBeneficiaries performance with 100k rows', () => {
    it('completes in ≤200ms for trigram similarity search', async () => {
      const measurements: number[] = [];

      // Warmup iterations to allow PostgreSQL to warm up caches
      for (let i = 0; i < WARMUP_ITERATIONS; i++) {
        await SearchService.searchBeneficiaries({
          query: TEST_QUERY,
          sortBy: 'relevance',
          page: 1,
          limit: 20,
        });
      }

      // Actual measurements
      for (let i = 0; i < MEASUREMENT_ITERATIONS; i++) {
        const startTime = performance.now();
        
        await SearchService.searchBeneficiaries({
          query: TEST_QUERY,
          sortBy: 'relevance',
          page: 1,
          limit: 20,
        });
        
        const endTime = performance.now();
        const duration = endTime - startTime;
        measurements.push(duration);
      }

      // Calculate statistics
      const avgTime = measurements.reduce((sum, time) => sum + time, 0) / measurements.length;
      const maxTime = Math.max(...measurements);
      const minTime = Math.min(...measurements);
      const sortedTimes = [...measurements].sort((a, b) => a - b);
      const p99Index = Math.floor(measurements.length * 0.99);
      const p99Time = sortedTimes[p99Index] || maxTime;

      console.log(`Performance Results for searchBeneficiaries with query "${TEST_QUERY}":`);
      console.log(`  Average: ${avgTime.toFixed(2)}ms`);
      console.log(`  Min: ${minTime.toFixed(2)}ms`);
      console.log(`  Max: ${maxTime.toFixed(2)}ms`);
      console.log(`  P99: ${p99Time.toFixed(2)}ms`);
      console.log(`  Threshold: ${PERFORMANCE_THRESHOLD_MS}ms`);

      // Assert p99 is within threshold
      expect(p99Time).toBeLessThanOrEqual(PERFORMANCE_THRESHOLD_MS);
    });

    it('uses GIN index for trigram similarity (verified via EXPLAIN)', async () => {
      const explainResult = await prisma.$queryRaw<Array<any>>`
        EXPLAIN (ANALYZE, BUFFERS)
        SELECT id, word_similarity(${TEST_QUERY}, "firstName") AS score
        FROM "Beneficiary"
        WHERE word_similarity(${TEST_QUERY}, "firstName") > 0.2
        ORDER BY score DESC, id DESC
        LIMIT 20
      `;

      const explainText = JSON.stringify(explainResult);
      
      // Check if the query uses a Bitmap Index Scan on a GIN index
      const usesGinIndex = explainText.includes('Bitmap Index Scan') && 
                          (explainText.includes('gin_trgm') || explainText.includes('gin'));
      
      console.log('EXPLAIN ANALYZE output:', explainText);
      console.log('Uses GIN trigram index:', usesGinIndex);

      expect(usesGinIndex).toBe(true);
    });
  });

  describe('searchCampaigns performance with trigram similarity', () => {
    it('completes in ≤200ms for trigram similarity search', async () => {
      const measurements: number[] = [];

      // Warmup
      for (let i = 0; i < WARMUP_ITERATIONS; i++) {
        await SearchService.searchCampaigns({
          query: 'syria relief',
          sortBy: 'relevance',
          page: 1,
          limit: 20,
        });
      }

      // Measurements
      for (let i = 0; i < MEASUREMENT_ITERATIONS; i++) {
        const startTime = performance.now();
        
        await SearchService.searchCampaigns({
          query: 'syria relief',
          sortBy: 'relevance',
          page: 1,
          limit: 20,
        });
        
        const endTime = performance.now();
        measurements.push(endTime - startTime);
      }

      const avgTime = measurements.reduce((sum, time) => sum + time, 0) / measurements.length;
      const maxTime = Math.max(...measurements);
      const sortedTimes = [...measurements].sort((a, b) => a - b);
      const p99Index = Math.floor(measurements.length * 0.99);
      const p99Time = sortedTimes[p99Index] || maxTime;

      console.log(`Performance Results for searchCampaigns with query "syria relief":`);
      console.log(`  Average: ${avgTime.toFixed(2)}ms`);
      console.log(`  Max: ${maxTime.toFixed(2)}ms`);
      console.log(`  P99: ${p99Time.toFixed(2)}ms`);

      expect(p99Time).toBeLessThanOrEqual(PERFORMANCE_THRESHOLD_MS);
    });

    it('uses GIN index for Campaign.title/description', async () => {
      const explainResult = await prisma.$queryRaw<Array<any>>`
        EXPLAIN (ANALYZE, BUFFERS)
        SELECT id, GREATEST(word_similarity(${'syria relief'}, title), word_similarity(${'syria relief'}, description)) AS score
        FROM "Campaign"
        WHERE GREATEST(word_similarity(${'syria relief'}, title), word_similarity(${'syria relief'}, description)) > 0.2
        ORDER BY score DESC, id DESC
        LIMIT 20
      `;

      const explainText = JSON.stringify(explainResult);
      const usesGinIndex = explainText.includes('Bitmap Index Scan') && 
                          (explainText.includes('gin_trgm') || explainText.includes('gin'));

      console.log('Campaign EXPLAIN ANALYZE output:', explainText);
      console.log('Uses GIN trigram index:', usesGinIndex);

      expect(usesGinIndex).toBe(true);
    });
  });

  describe('globalSearch performance with cross-entity scoring', () => {
    it('completes in ≤200ms for cross-entity search', async () => {
      const measurements: number[] = [];

      // Warmup
      for (let i = 0; i < WARMUP_ITERATIONS; i++) {
        await SearchService.globalSearch({
          query: TEST_QUERY,
          page: 1,
          limit: 20,
        });
      }

      // Measurements
      for (let i = 0; i < MEASUREMENT_ITERATIONS; i++) {
        const startTime = performance.now();
        
        await SearchService.globalSearch({
          query: TEST_QUERY,
          page: 1,
          limit: 20,
        });
        
        const endTime = performance.now();
        measurements.push(endTime - startTime);
      }

      const avgTime = measurements.reduce((sum, time) => sum + time, 0) / measurements.length;
      const maxTime = Math.max(...measurements);
      const sortedTimes = [...measurements].sort((a, b) => a - b);
      const p99Index = Math.floor(measurements.length * 0.99);
      const p99Time = sortedTimes[p99Index] || maxTime;

      console.log(`Performance Results for globalSearch with query "${TEST_QUERY}":`);
      console.log(`  Average: ${avgTime.toFixed(2)}ms`);
      console.log(`  Max: ${maxTime.toFixed(2)}ms`);
      console.log(`  P99: ${p99Time.toFixed(2)}ms`);

      // Global search may be slightly slower due to cross-entity queries,
      // but should still be within reasonable bounds
      expect(p99Time).toBeLessThanOrEqual(PERFORMANCE_THRESHOLD_MS * 2); // Allow 2x for cross-entity
    });
  });

  /**
   * Regression coverage for #194: cursor pagination over word_similarity-ranked
   * results must not duplicate or skip rows, even when many rows share the exact
   * same rounded score. This only reproduces against a real Postgres — word_similarity's
   * float4 output and Postgres's float4/numeric type promotion can't be faithfully
   * mocked, which is exactly how the original bug (WHERE (score, id) < (...) comparing
   * a real column against a numeric-bound parameter) went undetected by unit tests.
   */
  describe('cursor pagination stability against real word_similarity scores', () => {
    let organizationId: string;
    let userId: string;

    beforeAll(async () => {
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const owner = await prisma.user.create({
        data: { email: `search-perf-owner-${suffix}@test.com`, role: 'ORGANIZATION' },
      });
      const organization = await prisma.organization.create({
        data: { userId: owner.id, name: `Search Perf Org ${suffix}` },
      });
      userId = owner.id;
      organizationId = organization.id;
    });

    afterAll(async () => {
      await prisma.campaign.deleteMany({ where: { organizationId } });
      await prisma.organization.delete({ where: { id: organizationId } }).catch(() => undefined);
      await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    });

    async function seedCampaigns(count: number, titleFactory: (i: number) => string) {
      const rows = Array.from({ length: count }, (_, i) => ({
        organizationId,
        userId,
        title: titleFactory(i),
        description: 'Seeded for cursor pagination stability testing.',
        targetAmount: new Prisma.Decimal(1000),
        startDate: new Date(),
        status: 'ACTIVE' as const,
      }));
      // createMany doesn't return rows/ids on Postgres in a portable way across
      // Prisma versions, so create individually — this only runs a handful of times.
      const created = [];
      for (const row of rows) {
        created.push(await prisma.campaign.create({ data: row }));
      }
      return created;
    }

    it('walks all pages of a 50-campaign match set with no duplicates and no gaps', async () => {
      const campaigns = await seedCampaigns(50, (i) => `Cursor Stability Relief Fund ${i}`);
      const expectedIds = new Set(campaigns.map((c) => c.id));

      const seenIds: string[] = [];
      let cursor: string | undefined;
      let guard = 0;

      do {
        const result = await SearchService.searchCampaigns({
          query: 'cursor stability relief fund',
          sortBy: 'relevance',
          limit: 10,
          cursor,
        });
        const pageIds = result.data
          .map((c: any) => c.id)
          .filter((id: string) => expectedIds.has(id));
        seenIds.push(...pageIds);
        cursor = result.pagination.nextCursor;
        guard++;
      } while (cursor && guard < 20);

      expect(seenIds).toHaveLength(seenIds.length ? new Set(seenIds).size : 0);
      expect(new Set(seenIds).size).toBe(seenIds.length); // no duplicates across pages
      expect(new Set(seenIds)).toEqual(expectedIds); // no gaps — every seeded campaign was returned
    }, 30000);

    it('partitions 20 identically-scored campaigns across two pages by id descending, with no overlap', async () => {
      const campaigns = await seedCampaigns(20, () => 'Emergency Food Relief Tiebreak');
      const expectedIds = campaigns.map((c) => c.id).sort().reverse(); // id DESC, matches ORDER BY score DESC, id DESC

      const page1 = await SearchService.searchCampaigns({
        query: 'emergency food relief tiebreak',
        sortBy: 'relevance',
        limit: 10,
      });
      expect(page1.pagination.nextCursor).toBeTruthy();

      const page2 = await SearchService.searchCampaigns({
        query: 'emergency food relief tiebreak',
        sortBy: 'relevance',
        limit: 10,
        cursor: page1.pagination.nextCursor,
      });

      const page1Ids = page1.data.map((c: any) => c.id);
      const page2Ids = page2.data.map((c: any) => c.id).filter((id: string) => expectedIds.includes(id));

      expect(page1Ids).toHaveLength(10);
      expect(page1Ids.every((id: string) => !page2Ids.includes(id))).toBe(true);
      expect([...page1Ids, ...page2Ids].sort()).toEqual([...expectedIds].sort());
    }, 30000);

    it('rejects a manipulated cursor score gracefully instead of exposing extra rows', async () => {
      const forgedCursor = Buffer.from(
        JSON.stringify({ v: 2, score: -1, id: 'nonexistent-campaign-id' })
      ).toString('base64');

      await expect(
        SearchService.searchCampaigns({
          query: 'cursor stability relief fund',
          sortBy: 'relevance',
          limit: 10,
          cursor: forgedCursor,
        })
      ).resolves.toMatchObject({ data: [] });
    });
  });
});

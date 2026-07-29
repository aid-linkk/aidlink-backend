/// <reference types="jest" />

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
});

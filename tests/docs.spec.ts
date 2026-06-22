import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';

const SPEC_PATH = path.join(__dirname, '..', 'openapi.yaml');

// All route prefixes registered in src/index.ts (without /api/v1 prefix — we
// check the paths section of the spec uses the full /api/v1/... form).
const REQUIRED_PATH_PREFIXES = [
  '/api/v1/auth/',
  '/api/v1/campaigns',
  '/api/v1/donations',
  '/api/v1/beneficiaries',
  '/api/v1/distributions',
  '/api/v1/notifications',
  '/api/v1/admin/',
  '/api/v1/analytics/',
  '/api/v1/search/',
  '/api/v1/upload/',
  '/api/v1/organizations',
];

// Spot-check specific paths mentioned in the issue acceptance criteria
const REQUIRED_EXACT_PATHS = [
  '/api/v1/campaigns/{campaignId}/multipliers',
  '/api/v1/donations',
  '/api/v1/campaigns/{id}/stats',
  '/api/v1/auth/register',
  '/api/v1/auth/login',
  '/api/v1/auth/wallet',
];

interface OpenApiDoc {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<string, Record<string, unknown>>;
  components?: {
    schemas?: Record<string, unknown>;
    securitySchemes?: Record<string, unknown>;
  };
  'x-webhooks'?: Record<string, unknown>;
  'x-websocket-events'?: Record<string, unknown>;
  'x-blockchain-formats'?: Record<string, unknown>;
}

describe('OpenAPI spec smoke tests', () => {
  let doc: OpenApiDoc;
  let specPaths: string[];

  beforeAll(() => {
    const raw = fs.readFileSync(SPEC_PATH, 'utf8');
    doc = yaml.load(raw) as OpenApiDoc;
    specPaths = Object.keys(doc.paths || {});
  });

  test('openapi.yaml exists and is parseable', () => {
    expect(fs.existsSync(SPEC_PATH)).toBe(true);
    expect(doc).toBeDefined();
    expect(typeof doc).toBe('object');
  });

  test('spec declares OpenAPI 3.x', () => {
    expect(doc.openapi).toMatch(/^3\./);
  });

  test('info block is present with title and version', () => {
    expect(doc.info).toBeDefined();
    expect(doc.info.title).toBeTruthy();
    expect(doc.info.version).toBeTruthy();
  });

  test('paths section exists and has 50+ entries', () => {
    expect(doc.paths).toBeDefined();
    expect(specPaths.length).toBeGreaterThanOrEqual(50);
  });

  test.each(REQUIRED_PATH_PREFIXES)(
    'spec contains at least one path starting with %s',
    (prefix) => {
      const match = specPaths.some((p) => p.startsWith(prefix));
      expect(match).toBe(true);
    },
  );

  test.each(REQUIRED_EXACT_PATHS)(
    'spec contains required path: %s',
    (requiredPath) => {
      expect(specPaths).toContain(requiredPath);
    },
  );

  test('every operation has an operationId', () => {
    const missing: string[] = [];
    for (const [pathKey, pathItem] of Object.entries(doc.paths)) {
      const methods = ['get', 'post', 'put', 'patch', 'delete'] as const;
      for (const method of methods) {
        const op = (pathItem as Record<string, { operationId?: string }>)[method];
        if (op && !op.operationId) {
          missing.push(`${method.toUpperCase()} ${pathKey}`);
        }
      }
    }
    expect(missing).toHaveLength(0);
  });

  test('every operation defines at least one response', () => {
    const missing: string[] = [];
    for (const [pathKey, pathItem] of Object.entries(doc.paths)) {
      const methods = ['get', 'post', 'put', 'patch', 'delete'] as const;
      for (const method of methods) {
        const op = (pathItem as Record<string, { responses?: Record<string, unknown> }>)[method];
        if (op && (!op.responses || Object.keys(op.responses).length === 0)) {
          missing.push(`${method.toUpperCase()} ${pathKey}`);
        }
      }
    }
    expect(missing).toHaveLength(0);
  });

  test('bearerAuth security scheme is defined in components', () => {
    expect(doc.components?.securitySchemes?.bearerAuth).toBeDefined();
  });

  test('core schemas are defined in components', () => {
    const requiredSchemas = [
      'User',
      'Campaign',
      'Donation',
      'Beneficiary',
      'Distribution',
      'Notification',
      'Organization',
      'ErrorResponse',
      'SuccessResponse',
    ];
    for (const schema of requiredSchemas) {
      expect(doc.components?.schemas?.[schema]).toBeDefined();
    }
  });

  test('webhook section exists with at least one event', () => {
    expect(doc['x-webhooks']).toBeDefined();
    expect(Object.keys(doc['x-webhooks'] || {}).length).toBeGreaterThan(0);
  });

  test('websocket events section exists', () => {
    expect(doc['x-websocket-events']).toBeDefined();
    expect(Object.keys(doc['x-websocket-events'] || {}).length).toBeGreaterThan(0);
  });

  test('blockchain formats section exists', () => {
    expect(doc['x-blockchain-formats']).toBeDefined();
    expect(Object.keys(doc['x-blockchain-formats'] || {}).length).toBeGreaterThan(0);
  });

  test('donation:created webhook payload example is present', () => {
    const webhooks = doc['x-webhooks'] as Record<string, { post: { requestBody: { content: { 'application/json': { example: { event: string } } } } } }>;
    expect(webhooks?.['donation.created']?.post?.requestBody?.content?.['application/json']?.example?.event).toBe('donation.created');
  });

  test('campaign stats path returns totalDonated, totalMatched, combinedRaised in example', () => {
    const statsPath = doc.paths['/api/v1/campaigns/{id}/stats'];
    const getOp = (statsPath as Record<string, { responses: { '200': { content: { 'application/json': { example: { data: Record<string, unknown> } } } } } }>)?.get;
    const example = getOp?.responses?.['200']?.content?.['application/json']?.example?.data;
    expect(example).toBeDefined();
    expect(example?.totalDonated).toBeDefined();
    expect(example?.totalMatched).toBeDefined();
    expect(example?.combinedRaised).toBeDefined();
  });

  test('donation POST response example includes matchedFunds', () => {
    const donationPath = doc.paths['/api/v1/donations'];
    const postOp = (donationPath as Record<string, { responses: { '201': { content: { 'application/json': { example: { data: Record<string, unknown> } } } } } }>)?.post;
    const example = postOp?.responses?.['201']?.content?.['application/json']?.example?.data;
    expect(example?.matchedFunds).toBeDefined();
  });
});

import { ErrorCodes } from './errorCodes';
import { AppError, getDefaultErrorCode } from '../middleware/error';

describe('ErrorCodes registry', () => {
  const entries = Object.entries(ErrorCodes);

  it('is not empty', () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  it('keys follow the <DOMAIN>_<3-digit sequence> naming convention', () => {
    for (const key of Object.keys(ErrorCodes)) {
      expect(key).toMatch(/^[A-Z]+_\d{3}$/);
    }
  });

  it('every entry has a valid httpStatus, non-empty message/cause/solution', () => {
    for (const [key, def] of entries) {
      expect(def.httpStatus).toBeGreaterThanOrEqual(400);
      expect(def.httpStatus).toBeLessThan(600);
      expect(typeof def.message).toBe('string');
      expect(def.message.length).toBeGreaterThan(0);
      expect(typeof def.cause).toBe('string');
      expect(def.cause.length).toBeGreaterThan(0);
      expect(typeof def.solution).toBe('string');
      expect(def.solution.length).toBeGreaterThan(0);
      // Sanity check the code prefix matches a status getDefaultErrorCode understands.
      expect(() => getDefaultErrorCode(def.httpStatus)).not.toThrow();
      expect(key).toBeTruthy();
    }
  });

  it('has no duplicate (httpStatus, message) pairs across different codes', () => {
    const seen = new Map<string, string>();
    for (const [key, def] of entries) {
      const dedupeKey = `${def.httpStatus}:${def.message}`;
      const existing = seen.get(dedupeKey);
      expect(existing).toBeUndefined();
      seen.set(dedupeKey, key);
    }
  });
});

describe('AppError.from', () => {
  it('builds an AppError using the registry httpStatus and default message', () => {
    const err = AppError.from('CAMPAIGN_002');
    expect(err.statusCode).toBe(404);
    expect(err.message).toBe('Campaign not found');
    expect(err.errorCode).toBe('CAMPAIGN_002');
  });

  it('overrides the message while keeping the same errorCode and status', () => {
    const err = AppError.from('CAMPAIGN_001', 'Title must be at least 3 characters long');
    expect(err.statusCode).toBe(400);
    expect(err.message).toBe('Title must be at least 3 characters long');
    expect(err.errorCode).toBe('CAMPAIGN_001');
  });

  it('derives the generic ApiErrorCode category from the httpStatus', () => {
    const err = AppError.from('AUTH_002');
    expect(err.statusCode).toBe(401);
    expect(err.code).toBe('UNAUTHORIZED');
  });
});

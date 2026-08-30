import { CircuitBreaker, CircuitBreakerState, CircuitBreakerRegistry, FailFastFallback } from './circuitBreaker';

describe('CircuitBreaker', () => {
  beforeEach(() => {
    CircuitBreakerRegistry.clear();
  });

  it('should transition to OPEN when failure threshold is exceeded', async () => {
    const cb = new CircuitBreaker('test', {
      failureRateThreshold: 0.5,
      minimumRequests: 2,
      latencyThresholdMs: 5000,
      openTimeoutMs: 1000,
      halfOpenMaxRequests: 1
    }, new FailFastFallback());

    await expect(cb.execute(async () => { throw new Error('fail'); })).rejects.toThrow('fail');
    await expect(cb.execute(async () => { throw new Error('fail'); })).rejects.toThrow('fail');

    expect(cb.getState()).toBe(CircuitBreakerState.OPEN);
  });

  it('should transition to HALF_OPEN after timeout', async () => {
    jest.useFakeTimers();
    const cb = new CircuitBreaker('test2', {
      failureRateThreshold: 0.5,
      minimumRequests: 2,
      latencyThresholdMs: 5000,
      openTimeoutMs: 1000,
      halfOpenMaxRequests: 1
    }, new FailFastFallback());

    await expect(cb.execute(async () => { throw new Error('fail'); })).rejects.toThrow('fail');
    await expect(cb.execute(async () => { throw new Error('fail'); })).rejects.toThrow('fail');

    expect(cb.getState()).toBe(CircuitBreakerState.OPEN);

    jest.advanceTimersByTime(1100);

    // Should allow one request as HALF_OPEN
    await expect(cb.execute(async () => 'success')).resolves.toBe('success');
    expect(cb.getState()).toBe(CircuitBreakerState.CLOSED);

    jest.useRealTimers();
  });
});

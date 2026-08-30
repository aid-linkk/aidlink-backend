import logger from '../config/logger';

export enum CircuitBreakerState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
}

export interface CircuitBreakerConfig {
  failureRateThreshold: number; 
  minimumRequests: number;
  latencyThresholdMs: number; 
  openTimeoutMs: number;
  halfOpenMaxRequests: number;
  windowSize?: number;
}

export class CircuitBreakerOpenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CircuitBreakerOpenError';
  }
}

export interface FallbackStrategy<T> {
  fallback(error: Error): Promise<T> | T;
}

export class FailFastFallback<T> implements FallbackStrategy<T> {
  fallback(error: Error): never {
    throw error;
  }
}

export class DefaultValueFallback<T> implements FallbackStrategy<T> {
  constructor(private readonly defaultValue: T) {}
  fallback(error: Error): T {
    return this.defaultValue;
  }
}

export class CircularBuffer {
  private outcomes: boolean[]; 
  private latencies: number[];
  private head: number = 0;
  private count: number = 0;
  
  constructor(private readonly capacity: number) {
    this.outcomes = new Array(capacity).fill(true);
    this.latencies = new Array(capacity).fill(0);
  }

  add(success: boolean, latency: number) {
    this.outcomes[this.head] = success;
    this.latencies[this.head] = latency;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) {
      this.count++;
    }
  }

  getMetrics() {
    if (this.count === 0) return { failureRate: 0, p95Latency: 0, total: 0 };
    let failures = 0;
    const validLatencies = new Float64Array(this.count);
    for (let i = 0; i < this.count; i++) {
      if (!this.outcomes[i]) failures++;
      validLatencies[i] = this.latencies[i];
    }
    validLatencies.sort();
    const p95Index = Math.floor(validLatencies.length * 0.95);
    const p95Latency = validLatencies[p95Index] || 0;
    
    return {
      failureRate: failures / this.count,
      p95Latency,
      total: this.count
    };
  }

  reset() {
    this.head = 0;
    this.count = 0;
  }
}

export class CircuitBreaker<T> {
  private state: CircuitBreakerState = CircuitBreakerState.CLOSED;
  private nextAttemptAt: number = 0;
  private halfOpenSuccesses: number = 0;
  private halfOpenRequests: number = 0;
  private buffer: CircularBuffer;

  constructor(
    public readonly name: string,
    private readonly config: CircuitBreakerConfig,
    private readonly fallbackStrategy: FallbackStrategy<T>
  ) {
    this.buffer = new CircularBuffer(config.windowSize || 100);
  }

  getState(): CircuitBreakerState {
    return this.state;
  }

  async execute(action: () => Promise<T>): Promise<T> {
    if (this.state === CircuitBreakerState.OPEN) {
      if (Date.now() >= this.nextAttemptAt) {
        this.transitionTo(CircuitBreakerState.HALF_OPEN);
      } else {
        return this.fallbackStrategy.fallback(
          new CircuitBreakerOpenError(`Circuit ${this.name} is OPEN.`)
        );
      }
    }

    if (this.state === CircuitBreakerState.HALF_OPEN) {
      if (this.halfOpenRequests >= this.config.halfOpenMaxRequests) {
        return this.fallbackStrategy.fallback(
          new CircuitBreakerOpenError(`Circuit ${this.name} is HALF_OPEN and testing.`)
        );
      }
      this.halfOpenRequests++;
    }

    const startTime = performance.now();
    try {
      const result = await action();
      const latency = performance.now() - startTime;
      this.onSuccess(latency);
      return result;
    } catch (error) {
      const latency = performance.now() - startTime;
      this.onFailure(latency);
      return this.fallbackStrategy.fallback(error as Error);
    }
  }

  private onSuccess(latency: number) {
    if (this.state === CircuitBreakerState.HALF_OPEN) {
      this.halfOpenSuccesses++;
      if (this.halfOpenSuccesses >= this.config.halfOpenMaxRequests) {
        this.transitionTo(CircuitBreakerState.CLOSED);
      }
      return;
    }

    this.buffer.add(true, latency);
    this.checkThresholds();
  }

  private onFailure(latency: number) {
    if (this.state === CircuitBreakerState.HALF_OPEN) {
      this.transitionTo(CircuitBreakerState.OPEN);
      return;
    }

    this.buffer.add(false, latency);
    this.checkThresholds();
  }

  private checkThresholds() {
    const metrics = this.buffer.getMetrics();
    if (metrics.total >= this.config.minimumRequests) {
      if (metrics.failureRate >= this.config.failureRateThreshold || metrics.p95Latency >= this.config.latencyThresholdMs) {
        this.transitionTo(CircuitBreakerState.OPEN);
      }
    }
  }

  private transitionTo(newState: CircuitBreakerState) {
    const oldState = this.state;
    this.state = newState;
    
    logger.info(`CircuitBreaker [${this.name}] transitioned from ${oldState} to ${newState}`);

    if (newState === CircuitBreakerState.OPEN) {
      this.nextAttemptAt = Date.now() + this.config.openTimeoutMs;
    } else if (newState === CircuitBreakerState.HALF_OPEN) {
      this.halfOpenRequests = 0;
      this.halfOpenSuccesses = 0;
    } else if (newState === CircuitBreakerState.CLOSED) {
      this.buffer.reset();
    }
  }
}

export const CircuitBreakerRegistry = new Map<string, CircuitBreaker<any>>();

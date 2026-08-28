/**
 * Backpressure and flow-control sub-system for AidLink WebSocket server.
 *
 * Public surface:
 *   BackpressureMonitor        — Buffer-size inspection and threshold signals
 *   PriorityEventQueue         — Four-level (CRITICAL/HIGH/MEDIUM/LOW) event queue
 *   FlowController             — Throttle, coalesce and queue wrapper over emit
 *   ClientEvictionManager      — Slow/idle eviction and per-client rate-limiting
 *   BackpressureObservability  — Periodic structured logging and snapshot API
 *
 * Utility re-exports:
 *   classifyEvent              — Map event name → EventPriority
 *   EventPriority              — Priority enum
 */

export * from './BackpressureMonitor';
export * from './PriorityEventQueue';
export * from './FlowController';
export * from './ClientEvictionManager';
export * from './BackpressureObservability';

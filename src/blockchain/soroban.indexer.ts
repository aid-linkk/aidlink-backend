/**
 * SorobanIndexer — Production-grade Soroban/Stellar blockchain indexer
 *
 * ## Design
 *
 * The indexer runs a single background loop (`indexLoop`) that is started
 * once at application boot and never blocks the Express HTTP server.
 *
 * ### Cursor persistence
 * An `IndexerCheckpoint` singleton row in Postgres records the
 * `lastSequence` and `lastHash` of the most recently committed ledger.
 * On restart the indexer reads this row instead of deriving
 * `startBlock = latestLedger - 1000`.
 *
 * ### Gap detection & backfill
 * Each tick compares `checkpoint.lastSequence` with the current chain tip.
 * If the gap ≥ 1 it enters catch-up mode: it processes up to
 * `SOROBAN_INDEXER_BATCH_SIZE` (default 50) ledgers per tick, advancing
 * the checkpoint after each batch commits.
 *
 * ### Real transaction fetching
 * Each ledger is fetched via the Horizon REST API
 * (`GET /ledgers/{seq}/transactions`).  The `result_meta_xdr` field is
 * decoded to extract Soroban contract events.
 *
 * ### Soroban contract event parsing
 * For each transaction involving `config.soroban.contractAddress`, we also
 * call the Soroban RPC `getEvents` method to retrieve events in a batch for
 * the current range, then decode each event's topics and data ScVal into
 * the `ContractEvent.parameters` JSON column.
 *
 * ### Idempotency
 * Duplicate `txHash` inserts are silently swallowed (Prisma P2002).
 * The checkpoint upsert and batch `BlockchainTransaction` / `ContractEvent`
 * inserts are wrapped in a single Prisma interactive transaction so a
 * partial failure is fully rolled back.
 *
 * ### Reorg detection
 * Before inserting a ledger's transactions we check whether any existing
 * `BlockchainTransaction` row has `blockNumber = seq` but a different
 * `ledgerHash`.  If so, those rows are marked `status = 'ORPHANED'` and the
 * canonical rows are inserted fresh.
 *
 * ### Rate limiting
 * A `TokenBucketRateLimiter` (configured via `SOROBAN_INDEXER_RPS_LIMIT`)
 * gates every outbound HTTP call to Horizon and the Soroban RPC.  A 429
 * from either source triggers an exponential sleep then retry.
 */

import { Server } from 'soroban-client';
import { Prisma, TransactionType } from '@prisma/client';
import prisma from '../config/database';
import logger from '../config/logger';
import { config } from '../config/index';
import { HorizonClient, HorizonError } from '../utils/horizonClient';
import { TokenBucketRateLimiter } from '../utils/rateLimiter';
import {
  parseHorizonTransaction,
  extractContractEventsFromMeta,
  parseContractEvent,
  parseRpcEvent,
  ParsedContractEvent,
} from '../utils/xdrParser';

// ── Constants ─────────────────────────────────────────────────────────────────

const CHECKPOINT_ID = 'singleton';

/** Maximum number of times to retry a single Horizon/RPC request. */
const MAX_FETCH_RETRIES = 4;

/**
 * Base delay for exponential backoff on transient errors (excluding 429).
 * Doubles on each retry up to ~16 s.
 */
const BASE_RETRY_DELAY_MS = 500;

// ── Types ─────────────────────────────────────────────────────────────────────

interface SorobanRpcEvent {
  id: string;
  type: string;
  ledger: number;
  ledgerClosedAt: string;
  contractId: string;
  txHash: string;
  topic: string[];
  value: string;
}

interface SorobanRpcGetEventsResponse {
  result?: {
    events: SorobanRpcEvent[];
    cursor?: string;
  };
  error?: { code: number; message: string };
}

// ── Indexer ───────────────────────────────────────────────────────────────────

export class SorobanIndexer {
  private readonly rpcServer: Server;
  private readonly horizon: HorizonClient;
  private readonly rateLimiter: TokenBucketRateLimiter;
  private isRunning: boolean = false;

  constructor() {
    this.rpcServer = new Server(config.soroban.networkUrl);
    this.horizon = new HorizonClient(config.indexer.horizonUrl);
    this.rateLimiter = new TokenBucketRateLimiter(config.indexer.rpsLimit);
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Soroban indexer is already running');
      return;
    }

    this.isRunning = true;
    logger.info('Starting Soroban blockchain indexer', {
      horizonUrl: config.indexer.horizonUrl,
      rpcUrl: config.soroban.networkUrl,
      batchSize: config.indexer.batchSize,
      rpsLimit: config.indexer.rpsLimit,
    });

    // Fire-and-forget; errors are caught inside indexLoop so they don't
    // propagate to and crash the caller.
    this.indexLoop().catch((err) => {
      logger.error('Indexer loop crashed unexpectedly:', err);
      this.isRunning = false;
    });
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    logger.info('Stopping Soroban blockchain indexer');
  }

  /**
   * Manually record an on-chain transaction written by an external caller
   * (e.g. the pledge worker).  Idempotent via the unique `txHash` constraint.
   */
  async indexTransaction(txHash: string, type: TransactionType, metadata: Record<string, unknown>): Promise<void> {
    try {
      await prisma.blockchainTransaction.create({
        data: {
          txHash,
          type,
          fromAddress: metadata.fromAddress as string | undefined,
          toAddress: metadata.toAddress as string | undefined,
          amount: metadata.amount ? new Prisma.Decimal(metadata.amount as string) : undefined,
          currency: (metadata.currency as string | undefined) ?? 'XLM',
          contractAddress: metadata.contractAddress as string | undefined,
          functionName: metadata.functionName as string | undefined,
          parameters: metadata.parameters as Prisma.InputJsonValue | undefined,
          status: 'CONFIRMED',
          blockNumber: metadata.blockNumber ? BigInt(metadata.blockNumber as string) : undefined,
          ledgerHash: metadata.ledgerHash as string | undefined,
          timestamp: metadata.timestamp ? new Date(metadata.timestamp as string) : new Date(),
          indexed: true,
        },
      });
      logger.info('Transaction manually indexed', { txHash, type });
    } catch (err) {
      if ((err as any).code !== 'P2002') {
        logger.error('Error manually indexing transaction', { txHash, err });
      }
    }
  }

  /** Manually record a contract event. Idempotent via the txHash+eventName pair. */
  async indexEvent(txHash: string, contractAddress: string, eventName: string, parameters: unknown): Promise<void> {
    try {
      await prisma.contractEvent.create({
        data: {
          txHash,
          contractAddress,
          eventName,
          parameters: parameters as Prisma.InputJsonValue,
          processed: false,
        },
      });
      logger.info('Event manually indexed', { txHash, eventName });
    } catch (err) {
      if ((err as any).code !== 'P2002') {
        logger.error('Error manually indexing event', { txHash, eventName, err });
      }
    }
  }

  async getTransactionByHash(txHash: string) {
    return prisma.blockchainTransaction.findUnique({ where: { txHash } });
  }

  async getUnprocessedEvents() {
    return prisma.contractEvent.findMany({
      where: { processed: false },
      take: 100,
    });
  }

  async markEventProcessed(eventId: string): Promise<void> {
    await prisma.contractEvent.update({
      where: { id: eventId },
      data: { processed: true },
    });
  }

  // ── Main loop ───────────────────────────────────────────────────────────────

  private async indexLoop(): Promise<void> {
    while (this.isRunning) {
      try {
        await this.tick();
        await sleep(config.indexer.pollIntervalMs);
      } catch (err) {
        logger.error('Indexer tick failed:', err);
        await sleep(config.indexer.errorBackoffMs);
      }
    }
  }

  /**
   * One indexer tick:
   * 1. Fetch the latest ledger sequence from the Soroban RPC.
   * 2. Read the persisted checkpoint.
   * 3. If gap ≥ 1, process up to `batchSize` ledgers.
   * 4. Commit the checkpoint atomically with the new rows.
   */
  private async tick(): Promise<void> {
    // Respect rate limiter for the getLatestLedger call
    await this.rateLimiter.throttle();
    const latest = await this.rpcServer.getLatestLedger();
    const chainTip: number = latest.sequence;

    const checkpoint = await this.getOrCreateCheckpoint();
    const fromSeq = checkpoint.lastSequence + 1;

    if (fromSeq > chainTip) {
      logger.debug('Indexer is at chain tip', { sequence: chainTip });
      return;
    }

    const gap = chainTip - checkpoint.lastSequence;
    const batchEnd = Math.min(chainTip, checkpoint.lastSequence + config.indexer.batchSize);

    logger.info('Indexer catch-up', {
      from: fromSeq,
      to: batchEnd,
      chainTip,
      gap,
    });

    await this.processLedgerRange(fromSeq, batchEnd);
  }

  // ── Ledger range processing ─────────────────────────────────────────────────

  /**
   * Process ledgers from `fromSeq` to `toSeq` (inclusive).
   * After each ledger the checkpoint is updated atomically with the inserts
   * so that a mid-batch crash doesn't replay already-committed ledgers.
   */
  private async processLedgerRange(fromSeq: number, toSeq: number): Promise<void> {
    // Pre-fetch Soroban events for the entire range in one RPC call (more
    // efficient than one call per ledger when processing a batch).
    const rpcEvents = await this.fetchRpcEvents(fromSeq, toSeq);
    // Group them by ledger sequence for O(1) look-up
    const rpcEventsByLedger = groupBy(rpcEvents, (e) => e.ledger);

    for (let seq = fromSeq; seq <= toSeq; seq++) {
      await this.processLedger(seq, rpcEventsByLedger.get(seq) ?? []);
    }
  }

  /**
   * Process a single ledger:
   * 1. Fetch ledger header (to get the canonical hash).
   * 2. Detect reorgs — mark ORPHANED rows that don't match the new hash.
   * 3. Fetch and parse all transactions.
   * 4. Parse contract events from result_meta_xdr + RPC events.
   * 5. Atomically upsert checkpoint + insert new rows.
   */
  private async processLedger(
    seq: number,
    rpcEvents: SorobanRpcEvent[],
  ): Promise<void> {
    // ── 1. Fetch ledger header ─────────────────────────────────────────────
    let ledgerHeader: Awaited<ReturnType<HorizonClient['getLedger']>>;
    try {
      await this.rateLimiter.throttle();
      ledgerHeader = await this.fetchWithRetry(() => this.horizon.getLedger(seq));
    } catch (err) {
      logger.error(`Failed to fetch ledger header for seq ${seq}:`, err);
      return;
    }

    const ledgerHash = ledgerHeader.hash;
    const ledgerTimestamp = new Date(ledgerHeader.closed_at).getTime();

    // ── 2. Fetch transactions ──────────────────────────────────────────────
    let horizonTxs: Awaited<ReturnType<HorizonClient['getLedgerTransactions']>>;
    try {
      await this.rateLimiter.throttle();
      horizonTxs = await this.fetchWithRetry(() => this.horizon.getLedgerTransactions(seq));
    } catch (err) {
      logger.error(`Failed to fetch transactions for ledger ${seq}:`, err);
      return;
    }

    logger.debug(`Ledger ${seq}: ${horizonTxs.length} txs, hash=${ledgerHash.slice(0, 12)}…`);

    // ── 3. Parse transactions ──────────────────────────────────────────────
    const parsedTxs = horizonTxs.map((htx) =>
      parseHorizonTransaction(htx, ledgerTimestamp),
    );

    // ── 4. Parse contract events from result_meta_xdr ──────────────────────
    const metaEvents: ParsedContractEvent[] = [];
    for (const htx of horizonTxs) {
      if (!htx.result_meta_xdr) continue;
      const rawEvents = extractContractEventsFromMeta(htx.result_meta_xdr);
      for (const raw of rawEvents) {
        const parsed = parseContractEvent(raw, {
          txHash: htx.hash,
          ledger: seq,
          ledgerTimestamp,
        });
        if (parsed && this.isTargetContract(parsed.contractAddress)) {
          metaEvents.push(parsed);
        }
      }
    }

    // ── 5. Parse Soroban RPC events for the target contract ────────────────
    const parsedRpcEvents: ParsedContractEvent[] = rpcEvents
      .map((re) => parseRpcEvent(re))
      .filter((e): e is ParsedContractEvent => e !== null);

    // Merge and deduplicate events (prefer meta-derived events; RPC events
    // are a fallback for events that don't appear in the meta)
    const allEvents = deduplicateEvents([...metaEvents, ...parsedRpcEvents]);

    // ── 6. Detect reorgs — must happen BEFORE the new inserts ─────────────
    const txHashes = new Set(parsedTxs.map((t) => t.txHash));
    await this.detectAndMarkOrphans(seq, ledgerHash, txHashes);

    // ── 7. Commit atomically ───────────────────────────────────────────────
    await this.commitLedger({
      seq,
      ledgerHash,
      ledgerTimestamp,
      parsedTxs,
      allEvents,
    });
  }

  // ── Reorg detection ─────────────────────────────────────────────────────────

  /**
   * Mark any existing `BlockchainTransaction` rows for ledger `seq` as
   * ORPHANED if:
   *   a) the stored `ledgerHash` differs from the canonical `newHash`, OR
   *   b) the stored `txHash` is not present in the canonical tx set for
   *      this ledger (i.e. the tx was on a minority fork).
   */
  private async detectAndMarkOrphans(
    seq: number,
    newHash: string,
    canonicalTxHashes: Set<string>,
  ): Promise<void> {
    // Fetch all existing rows at this ledger sequence
    const existingRows = await prisma.blockchainTransaction.findMany({
      where: { blockNumber: BigInt(seq), status: { not: 'ORPHANED' } },
      select: { id: true, txHash: true, ledgerHash: true },
    });

    if (existingRows.length === 0) return;

    const orphanIds: string[] = [];

    for (const row of existingRows) {
      const hashMismatch = row.ledgerHash !== null && row.ledgerHash !== newHash;
      const txNotOnChain = !canonicalTxHashes.has(row.txHash);

      if (hashMismatch || txNotOnChain) {
        orphanIds.push(row.id);
        logger.warn('Reorg detected — marking tx as ORPHANED', {
          txHash: row.txHash,
          seq,
          storedHash: row.ledgerHash,
          canonicalHash: newHash,
        });
      }
    }

    if (orphanIds.length > 0) {
      await prisma.blockchainTransaction.updateMany({
        where: { id: { in: orphanIds } },
        data: { status: 'ORPHANED' },
      });
    }
  }

  // ── Atomic commit ───────────────────────────────────────────────────────────

  private async commitLedger(params: {
    seq: number;
    ledgerHash: string;
    ledgerTimestamp: number;
    parsedTxs: ReturnType<typeof parseHorizonTransaction>[];
    allEvents: ParsedContractEvent[];
  }): Promise<void> {
    const { seq, ledgerHash, ledgerTimestamp, parsedTxs, allEvents } = params;

    await prisma.$transaction(async (tx) => {
      // Insert / skip-duplicate BlockchainTransaction rows
      for (const ptx of parsedTxs) {
        try {
          await tx.blockchainTransaction.create({
            data: {
              txHash: ptx.txHash,
              type: ptx.contractAddress
                ? TransactionType.CONTRACT_CALL
                : TransactionType.DONATION,
              fromAddress: ptx.fromAddress ?? undefined,
              toAddress: ptx.toAddress ?? undefined,
              amount: ptx.amount ? new Prisma.Decimal(ptx.amount) : undefined,
              currency: 'XLM',
              contractAddress: ptx.contractAddress ?? undefined,
              functionName: ptx.functionName ?? undefined,
              status: 'CONFIRMED',
              blockNumber: BigInt(seq),
              ledgerHash,
              timestamp: new Date(ledgerTimestamp),
              indexed: true,
            },
          });
        } catch (err) {
          // P2002 = unique constraint on txHash; safe to ignore (idempotent)
          if ((err as any).code !== 'P2002') throw err;
        }
      }

      // Insert / skip-duplicate ContractEvent rows
      for (const ev of allEvents) {
        try {
          await tx.contractEvent.create({
            data: {
              txHash: ev.txHash,
              contractAddress: ev.contractAddress,
              eventName: ev.eventName,
              parameters: {
                topics: ev.topics,
                data: ev.data,
              } as Prisma.InputJsonValue,
              blockNumber: BigInt(seq),
              timestamp: new Date(ev.ledgerTimestamp),
              processed: false,
            },
          });
        } catch (err) {
          if ((err as any).code !== 'P2002') throw err;
        }
      }

      // Advance the checkpoint (upsert so the first call creates the row)
      await tx.indexerCheckpoint.upsert({
        where: { id: CHECKPOINT_ID },
        update: { lastSequence: seq, lastHash: ledgerHash },
        create: { id: CHECKPOINT_ID, lastSequence: seq, lastHash: ledgerHash },
      });
    });

    logger.info(`Ledger ${seq} committed`, {
      txs: parsedTxs.length,
      events: allEvents.length,
    });
  }

  // ── Checkpoint ──────────────────────────────────────────────────────────────

  private async getOrCreateCheckpoint(): Promise<{ lastSequence: number; lastHash: string }> {
    const existing = await prisma.indexerCheckpoint.findUnique({
      where: { id: CHECKPOINT_ID },
    });

    if (existing) return existing;

    // No checkpoint yet — start from latestLedger - batchSize so we don't
    // scan the entire chain on first boot.
    await this.rateLimiter.throttle();
    const latest = await this.rpcServer.getLatestLedger();
    const startSeq = Math.max(1, latest.sequence - config.indexer.batchSize);

    await prisma.indexerCheckpoint.create({
      data: { id: CHECKPOINT_ID, lastSequence: startSeq, lastHash: '' },
    });

    logger.info('Created initial indexer checkpoint', { lastSequence: startSeq });
    return { lastSequence: startSeq, lastHash: '' };
  }

  // ── Soroban RPC events ──────────────────────────────────────────────────────

  /**
   * Call the Soroban RPC `getEvents` method for the target contract address
   * over the ledger range [fromSeq, toSeq].
   *
   * Returns an empty array if no contract address is configured or if the
   * RPC call fails.
   */
  private async fetchRpcEvents(fromSeq: number, toSeq: number): Promise<SorobanRpcEvent[]> {
    if (!config.soroban.contractAddress) return [];

    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getEvents',
      params: {
        startLedger: fromSeq,
        endLedger: toSeq,
        filters: [
          {
            type: 'contract',
            contractIds: [config.soroban.contractAddress],
          },
        ],
        limit: 1000,
      },
    });

    try {
      await this.rateLimiter.throttle();
      const response = await this.fetchWithRetry(() =>
        fetch(config.soroban.networkUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        }).then(async (res) => {
          if (!res.ok) {
            const retryAfterHeader = res.headers.get('Retry-After');
            const retryAfterMs = retryAfterHeader ? parseFloat(retryAfterHeader) * 1_000 : null;
            throw new HorizonError(config.soroban.networkUrl, res.status, retryAfterMs, `RPC returned ${res.status}`);
          }
          return res.json() as Promise<SorobanRpcGetEventsResponse>;
        }),
      );

      if (response.error) {
        logger.warn('Soroban RPC getEvents returned error', { error: response.error });
        return [];
      }

      return response.result?.events ?? [];
    } catch (err) {
      logger.error('Failed to fetch Soroban RPC events', { fromSeq, toSeq, err });
      return [];
    }
  }

  // ── Utilities ───────────────────────────────────────────────────────────────

  /**
   * Execute `fn` with up to `MAX_FETCH_RETRIES` attempts.
   *
   * On a 429 (rate limit) response we wait for `retryAfterMs` before
   * retrying.  On other transient errors we use exponential back-off.
   */
  private async fetchWithRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastErr: unknown;

    for (let attempt = 0; attempt < MAX_FETCH_RETRIES; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;

        if (err instanceof HorizonError && err.status === 429) {
          const waitMs = err.retryAfterMs ?? 1_000 * Math.pow(2, attempt);
          logger.warn('Rate limited by Horizon/RPC, backing off', {
            waitMs,
            attempt,
            url: err.url,
          });
          await sleep(waitMs);
          // Refill rate limiter after waiting
          this.rateLimiter.reset();
        } else {
          const waitMs = BASE_RETRY_DELAY_MS * Math.pow(2, attempt);
          logger.warn('Transient fetch error, retrying', { attempt, waitMs, err });
          await sleep(waitMs);
        }
      }
    }

    throw lastErr;
  }

  /** Returns true if `addr` matches the configured contract address. */
  private isTargetContract(addr: string): boolean {
    if (!config.soroban.contractAddress) return true; // no filter = accept all
    return addr === config.soroban.contractAddress;
  }
}

// ── Singleton export ──────────────────────────────────────────────────────────

export const sorobanIndexer = new SorobanIndexer();

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function groupBy<T, K>(items: T[], keyFn: (item: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const list = map.get(key);
    if (list) {
      list.push(item);
    } else {
      map.set(key, [item]);
    }
  }
  return map;
}

/**
 * Remove duplicate events (same txHash + eventName) keeping the first
 * occurrence, which is from `result_meta_xdr` (more reliable source).
 */
function deduplicateEvents(events: ParsedContractEvent[]): ParsedContractEvent[] {
  const seen = new Set<string>();
  return events.filter((e) => {
    const key = `${e.txHash}:${e.eventName}:${JSON.stringify(e.topics)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

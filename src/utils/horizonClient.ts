/**
 * HorizonClient
 *
 * Thin wrapper around the Stellar Horizon REST API for fetching ledger-level
 * data needed by the indexer.  We use the built-in Node.js `fetch` (available
 * since Node 18) rather than introducing a new dependency.
 *
 * Horizon docs: https://developers.stellar.org/docs/data/horizon
 *
 * Endpoints used:
 *   GET /ledgers/{sequence}                     — ledger header (hash, closed_at)
 *   GET /ledgers/{sequence}/transactions        — all transactions in a ledger
 */

import logger from '../config/logger';

// ── Types ─────────────────────────────────────────────────────────────────────

/** Subset of the Horizon ledger record we care about. */
export interface HorizonLedger {
  sequence: number;
  hash: string;
  closed_at: string; // ISO-8601
  transaction_count: number;
}

/** Subset of the Horizon transaction record we care about. */
export interface HorizonTransaction {
  id: string;
  hash: string;
  ledger: number;
  created_at: string; // ISO-8601
  source_account: string;
  fee_account: string | null;
  envelope_xdr: string;       // base64-encoded TransactionEnvelope XDR
  result_xdr: string;         // base64-encoded TransactionResult XDR
  result_meta_xdr: string;    // base64-encoded TransactionMeta XDR (contains Soroban events)
  successful: boolean;
  operation_count: number;
}

/** Horizon HAL page wrapper. */
interface HorizonPage<T> {
  _embedded: { records: T[] };
  _links: {
    self: { href: string };
    next?: { href: string };
    prev?: { href: string };
  };
}

/** Error thrown when a Horizon request fails with a non-2xx status. */
export class HorizonError extends Error {
  constructor(
    public readonly url: string,
    public readonly status: number,
    public readonly retryAfterMs: number | null,
    message: string,
  ) {
    super(message);
    this.name = 'HorizonError';
  }
}

// ── Client ────────────────────────────────────────────────────────────────────

export class HorizonClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    // Strip trailing slash for clean URL construction.
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  /**
   * Fetch the ledger header for the given sequence number.
   *
   * Throws HorizonError on 4xx/5xx.  A 429 response will have
   * `retryAfterMs` populated from the `Retry-After` header.
   */
  async getLedger(sequence: number): Promise<HorizonLedger> {
    const url = `${this.baseUrl}/ledgers/${sequence}`;
    return this.getJson<HorizonLedger>(url);
  }

  /**
   * Fetch all successful transactions in the given ledger.
   *
   * Pages through Horizon's cursor-based pagination automatically so the
   * caller always gets the full set (up to Horizon's internal limit of 200
   * per page, typically all transactions for a normal ledger).
   */
  async getLedgerTransactions(sequence: number): Promise<HorizonTransaction[]> {
    // include_failed=false: we only index successful transactions.
    const url = `${this.baseUrl}/ledgers/${sequence}/transactions?limit=200&include_failed=false&order=asc`;
    const results: HorizonTransaction[] = [];

    let nextUrl: string | null = url;

    while (nextUrl) {
      const page: HorizonPage<HorizonTransaction> = await this.getJson<HorizonPage<HorizonTransaction>>(nextUrl);
      results.push(...page._embedded.records);

      // Follow the `next` link only if Horizon returned a full page; if the
      // page is smaller than limit we know we have everything.
      const next = page._links.next?.href ?? null;
      nextUrl = page._embedded.records.length === 200 ? next : null;
    }

    return results;
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private async getJson<T>(url: string): Promise<T> {
    logger.debug(`HorizonClient GET ${url}`);

    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Accept: 'application/json' },
      });
    } catch (networkError) {
      throw new HorizonError(url, 0, null, `Network error fetching ${url}: ${String(networkError)}`);
    }

    if (!response.ok) {
      const retryAfterHeader = response.headers.get('Retry-After');
      const retryAfterMs = retryAfterHeader ? parseFloat(retryAfterHeader) * 1_000 : null;

      throw new HorizonError(
        url,
        response.status,
        retryAfterMs,
        `Horizon returned HTTP ${response.status} for ${url}`,
      );
    }

    return response.json() as Promise<T>;
  }
}

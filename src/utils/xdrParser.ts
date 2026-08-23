/**
 * XDR Parsing Utilities
 *
 * Decodes Stellar/Soroban XDR structures returned by Horizon and the
 * Soroban RPC without introducing additional dependencies.  All decoding is
 * done via `stellar-base`, which is bundled as a direct dependency of the
 * `soroban-client` package already in package.json.
 *
 * Key XDR types used:
 *   xdr.TransactionMeta   — meta for each transaction; V3 variant contains
 *                           SorobanTransactionMeta with `events[]`
 *   xdr.ContractEvent     — a single Soroban contract event with topics + data
 *   xdr.ScVal             — Soroban generic value (Symbol, Address, Int, etc.)
 *
 * References:
 *   https://developers.stellar.org/docs/learn/smart-contract-internals/events
 *   https://github.com/stellar/js-stellar-base
 */

// stellar-base is a CommonJS package; we import via require so the TypeScript
// compiler is happy even when module resolution is "node16".
// eslint-disable-next-line @typescript-eslint/no-var-requires
const stellarBase = require('stellar-base') as typeof import('stellar-base');
const { xdr, StrKey } = stellarBase;

// ── Exported types ────────────────────────────────────────────────────────────

/** Flat, database-friendly representation of a parsed transaction. */
export interface ParsedTransaction {
  txHash: string;
  fromAddress: string | null;
  toAddress: string | null;
  /** Decimal string (stroops), or null if not a payment */
  amount: string | null;
  contractAddress: string | null;
  functionName: string | null;
  /** Epoch milliseconds */
  ledgerTimestamp: number;
}

/** Flat representation of a parsed Soroban contract event. */
export interface ParsedContractEvent {
  txHash: string;
  contractAddress: string;
  /** The first Symbol-type topic is treated as the event name, e.g. "transfer" */
  eventName: string;
  /** Full topic array decoded as JSON-safe values */
  topics: unknown[];
  /** Decoded data ScVal as a JSON-safe value */
  data: unknown;
  ledger: number;
  ledgerTimestamp: number;
}

// ── ScVal decoder ─────────────────────────────────────────────────────────────

/**
 * Recursively convert an `xdr.ScVal` to a JSON-safe JavaScript value.
 *
 * We cover the most common variants.  Unknown or rarely-used variants are
 * returned as `{ _type: 'unknown', xdrType: val.switch().name }`.
 */
export function scValToNative(val: ReturnType<typeof xdr.ScVal.fromXDR>): unknown {
  const type = val.switch();
  const typeName: string = type.name as string;

  switch (typeName) {
    case 'scvBool':
      return val.b();
    case 'scvVoid':
      return null;
    case 'scvError':
      return { _type: 'error', value: (val as any).error()?.toString() };
    case 'scvU32':
      return (val as any).u32() as number;
    case 'scvI32':
      return (val as any).i32() as number;
    case 'scvU64': {
      const u64 = (val as any).u64() as bigint;
      return u64.toString();
    }
    case 'scvI64': {
      const i64 = (val as any).i64() as bigint;
      return i64.toString();
    }
    case 'scvU128': {
      const parts = (val as any).u128();
      const lo: bigint = BigInt(parts.lo().toString());
      const hi: bigint = BigInt(parts.hi().toString());
      return ((hi << 64n) | lo).toString();
    }
    case 'scvI128': {
      const parts = (val as any).i128();
      const lo: bigint = BigInt(parts.lo().toString());
      const hi: bigint = BigInt(parts.hi().toString());
      return ((hi << 64n) | lo).toString();
    }
    case 'scvU256': {
      const parts = (val as any).u256();
      // Combine four 64-bit parts
      const hiHi: bigint = BigInt(parts.hiHi().toString());
      const hiLo: bigint = BigInt(parts.hiLo().toString());
      const loHi: bigint = BigInt(parts.loHi().toString());
      const loLo: bigint = BigInt(parts.loLo().toString());
      return ((((hiHi << 64n) | hiLo) << 64n | loHi) << 64n | loLo).toString();
    }
    case 'scvI256': {
      const parts = (val as any).i256();
      const hiHi: bigint = BigInt(parts.hiHi().toString());
      const hiLo: bigint = BigInt(parts.hiLo().toString());
      const loHi: bigint = BigInt(parts.loHi().toString());
      const loLo: bigint = BigInt(parts.loLo().toString());
      return ((((hiHi << 64n) | hiLo) << 64n | loHi) << 64n | loLo).toString();
    }
    case 'scvBytes':
      return (val as any).bytes().toString('hex');
    case 'scvString': {
      const buf: Buffer = (val as any).str();
      return buf.toString('utf-8');
    }
    case 'scvSymbol': {
      const buf: Buffer = (val as any).sym();
      return buf.toString('utf-8');
    }
    case 'scvVec': {
      const items: unknown[] = ((val as any).vec() ?? []).map(scValToNative);
      return items;
    }
    case 'scvMap': {
      const entries: { key: unknown; val: unknown }[] = ((val as any).map() ?? []).map(
        (entry: any) => ({ key: scValToNative(entry.key()), val: scValToNative(entry.val()) }),
      );
      return entries;
    }
    case 'scvAddress': {
      const addr = (val as any).address();
      const addrType: string = addr.switch().name;
      if (addrType === 'scAddressTypeAccount') {
        const pubKey: Buffer = addr.accountId().ed25519();
        return StrKey.encodeEd25519PublicKey(pubKey);
      } else if (addrType === 'scAddressTypeContract') {
        const contractId: Buffer = addr.contractId();
        return StrKey.encodeContract(contractId);
      }
      return { _type: 'address', raw: addr.toXDR('base64') };
    }
    case 'scvContractInstance':
      return { _type: 'contractInstance' };
    case 'scvLedgerKeyContractInstance':
      return { _type: 'ledgerKeyContractInstance' };
    case 'scvLedgerKeyNonce':
      return { _type: 'ledgerKeyNonce' };
    default:
      return { _type: 'unknown', xdrType: typeName };
  }
}

// ── Transaction meta parser ───────────────────────────────────────────────────

/**
 * Parse a base64-encoded `result_meta_xdr` string from Horizon and extract
 * the `sorobanMeta.events` array.
 *
 * Returns an empty array if the meta is not a V3 transaction (i.e. it is a
 * classic Stellar transaction without Soroban involvement) or if decoding
 * fails.
 */
export function extractContractEventsFromMeta(
  resultMetaXdrBase64: string,
): Array<ReturnType<typeof xdr.ContractEvent.fromXDR>> {
  try {
    const meta = xdr.TransactionMeta.fromXDR(resultMetaXdrBase64, 'base64');
    // TransactionMeta is a union: v0 / v1 / v2 / v3
    // The switch() returns an XDR enum object; we compare using its name string
    // rather than the integer discriminant so we don't depend on the wire format.
    const switchName: string = (meta.switch() as any).name ?? '';
    if (switchName !== 'metaV3') {
      // Not a Soroban (V3) transaction
      return [];
    }
    const sorobanMeta = (meta as any).v3().sorobanMeta();
    if (!sorobanMeta) return [];
    const events: Array<ReturnType<typeof xdr.ContractEvent.fromXDR>> = sorobanMeta.events() ?? [];
    return events;
  } catch {
    // Malformed or unexpected XDR; don't crash the indexer
    return [];
  }
}

/**
 * Parse a Horizon transaction record into a flat `ParsedTransaction`.
 *
 * We read `source_account` as the `fromAddress`, and attempt to extract
 * a `toAddress` and `amount` from the operation list inside the envelope XDR.
 * For Soroban contract calls, `contractAddress` and `functionName` are
 * extracted from the inner `invokeHostFunction` operation.
 */
export function parseHorizonTransaction(
  tx: {
    hash: string;
    source_account: string;
    envelope_xdr: string;
    created_at: string;
    ledger: number;
  },
  ledgerTimestamp?: number,
): ParsedTransaction {
  const ts = ledgerTimestamp ?? new Date(tx.created_at).getTime();
  const base: ParsedTransaction = {
    txHash: tx.hash,
    fromAddress: tx.source_account ?? null,
    toAddress: null,
    amount: null,
    contractAddress: null,
    functionName: null,
    ledgerTimestamp: ts,
  };

  try {
    const envelope = xdr.TransactionEnvelope.fromXDR(tx.envelope_xdr, 'base64');
    const inner = extractInnerTransaction(envelope);
    if (!inner) return base;

    const ops: any[] = inner.operations() ?? [];
    for (const op of ops) {
      const body = op.body();
      const bodyType: string = body.switch().name;

      if (bodyType === 'invokeHostFunction') {
        // Soroban contract invocation
        const hostFn = body.invokeHostFunction().hostFunction();
        const fnType: string = hostFn.switch().name;

        if (fnType === 'hostFunctionTypeInvokeContract') {
          const invoke = hostFn.invokeContract();
          const contractIdBytes: Buffer = invoke.contractAddress().contractId();
          base.contractAddress = StrKey.encodeContract(contractIdBytes);
          base.functionName = invoke.functionName().toString('utf-8');
        }
      } else if (bodyType === 'payment') {
        // Classic XLM / asset payment
        const payment = body.payment();
        const destAccount = payment.destination();
        if (destAccount.switch().name === 'publicKeyTypeEd25519') {
          base.toAddress = StrKey.encodeEd25519PublicKey(destAccount.ed25519());
        }
        const amount: bigint = payment.amount();
        base.amount = amount.toString();
      } else if (bodyType === 'pathPaymentStrictSend' || bodyType === 'pathPaymentStrictReceive') {
        const payment = bodyType === 'pathPaymentStrictSend'
          ? body.pathPaymentStrictSend()
          : body.pathPaymentStrictReceive();
        const destAccount = payment.destination();
        if (destAccount.switch().name === 'publicKeyTypeEd25519') {
          base.toAddress = StrKey.encodeEd25519PublicKey(destAccount.ed25519());
        }
        const amount: bigint = payment.destAmount?.() ?? payment.sendAmount?.() ?? 0n;
        base.amount = amount.toString();
      }
      // We stop after the first meaningful operation we can decode
      if (base.contractAddress || base.toAddress) break;
    }
  } catch {
    // Malformed envelope — return the partial record
  }

  return base;
}

/**
 * Parse a raw `xdr.ContractEvent` (as returned by `extractContractEventsFromMeta`
 * or by the Soroban RPC `getEvents`) into a flat `ParsedContractEvent`.
 */
export function parseContractEvent(
  rawEvent: ReturnType<typeof xdr.ContractEvent.fromXDR>,
  context: { txHash: string; ledger: number; ledgerTimestamp: number },
): ParsedContractEvent | null {
  try {
    // Use `any` to access the XDR union members; stellar-base's TypeScript
    // declarations don't always perfectly model the union discriminant.
    const ev = rawEvent as any;

    const eventType: string = ev.switch().name ?? ev.switch();
    if (eventType !== 'contractEventTypeContract') {
      // SYSTEM and DIAGNOSTIC events are not application-level contract events
      return null;
    }

    const contractIdBytes: Buffer = ev.contractId() as Buffer;
    const contractAddress = StrKey.encodeContract(contractIdBytes);

    const body = ev.body();
    const bodyType: string = body.switch().name ?? body.switch();
    if (bodyType !== 'v0') return null;

    const v0 = body.v0();
    const topics: unknown[] = (v0.topics() ?? []).map(scValToNative);
    const data: unknown = scValToNative(v0.data());

    // Treat the first Symbol topic as the event name (convention in SEP-41 and SAC)
    const eventName =
      typeof topics[0] === 'string' ? topics[0] : JSON.stringify(topics[0] ?? 'unknown');

    return {
      txHash: context.txHash,
      contractAddress,
      eventName,
      topics,
      data,
      ledger: context.ledger,
      ledgerTimestamp: context.ledgerTimestamp,
    };
  } catch {
    return null;
  }
}

/**
 * Parse a Soroban RPC `getEvents` response event (topic and value are
 * base64-encoded XDR strings) into a `ParsedContractEvent`.
 */
export function parseRpcEvent(rpcEvent: {
  id: string;
  type: string;
  ledger: number;
  ledgerClosedAt: string;
  contractId: string;
  txHash: string;
  topic: string[];   // base64 ScVal XDR strings
  value: string;     // base64 ScVal XDR string
}): ParsedContractEvent | null {
  try {
    if (rpcEvent.type !== 'contract') return null;

    const topics = rpcEvent.topic.map((t) => {
      const scval = xdr.ScVal.fromXDR(t, 'base64');
      return scValToNative(scval);
    });

    const dataScVal = xdr.ScVal.fromXDR(rpcEvent.value, 'base64');
    const data = scValToNative(dataScVal);

    const eventName =
      typeof topics[0] === 'string' ? topics[0] : JSON.stringify(topics[0] ?? 'unknown');

    return {
      txHash: rpcEvent.txHash,
      contractAddress: rpcEvent.contractId,
      eventName,
      topics,
      data,
      ledger: rpcEvent.ledger,
      ledgerTimestamp: new Date(rpcEvent.ledgerClosedAt).getTime(),
    };
  } catch {
    return null;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Extract the inner `Transaction` from a `TransactionEnvelope` regardless
 * of whether it is V0, V1, or FeeBump.
 */
function extractInnerTransaction(envelope: ReturnType<typeof xdr.TransactionEnvelope.fromXDR>): any | null {
  const envType: string = (envelope as any).switch().name;
  if (envType === 'envelopeTypeTxV0') {
    return (envelope as any).v0().tx();
  } else if (envType === 'envelopeTypeTx') {
    return (envelope as any).v1().tx();
  } else if (envType === 'envelopeTypeTxFeeBump') {
    // The inner fee-bump transaction wraps the actual tx
    const inner = (envelope as any).feeBump().tx().innerTx();
    return inner.v1().tx();
  }
  return null;
}

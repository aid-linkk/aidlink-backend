-- Add ledgerHash column to BlockchainTransaction for reorg detection.
-- Nullable so existing rows are unaffected (backwards-compatible).
ALTER TABLE "BlockchainTransaction" ADD COLUMN "ledgerHash" TEXT;

-- Create index on ledgerHash to speed up the reorg detection query
-- (SELECT WHERE blockNumber = ? AND ledgerHash != ?).
CREATE INDEX "BlockchainTransaction_ledgerHash_idx" ON "BlockchainTransaction"("ledgerHash");

-- CreateTable: IndexerCheckpoint (singleton row, id = 'singleton')
-- Persists the last successfully processed ledger sequence and its hash so
-- the indexer can resume from the correct position after a process restart,
-- rather than re-deriving startBlock from latestLedger.sequence - 1000.
CREATE TABLE "IndexerCheckpoint" (
    "id"           TEXT NOT NULL DEFAULT 'singleton',
    "lastSequence" INTEGER NOT NULL DEFAULT 0,
    "lastHash"     TEXT NOT NULL DEFAULT '',
    "updatedAt"    TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IndexerCheckpoint_pkey" PRIMARY KEY ("id")
);

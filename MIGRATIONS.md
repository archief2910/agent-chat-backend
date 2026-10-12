# Migrations

PostgreSQL is the only application database. Apply migrations with `pnpm db:deploy`.

## 20261010120000_init

Creates the relational model: users, chats, messages, runs, tool invocations, skill snapshots, waitpoints, assets, attachments, the credit ledger, sessions, upload usage, and rate-limit buckets.

Compatibility:
- Requires PostgreSQL 14 or newer because of descending index columns.
- `Message.clientMessageId` is unique per chat and nullable. PostgreSQL treats nulls as distinct, so assistant messages can omit it.
- Run-to-message foreign keys use `ON DELETE SET NULL` so deleting a chat does not deadlock on a cascade cycle. The application always sets both ids when it creates a run.
- Clear `Chat.activeRunId` before deleting a chat. The delete service does this.

Rollback: drop the tables in reverse dependency order, then drop the enums. Do not roll back after the search migration has been applied unless that migration is rolled back first.

## 20261010123000_search_and_checks

Adds:
- `pg_trgm` for chat title search
- a stored `Message.searchVector` generated from `contentText`
- checks that balances, holds, charges, and ledger amounts are non-negative

`searchVector` is not in the Prisma schema. Search reads it with SQL. Writers update `contentText`; PostgreSQL maintains the vector.

Rollback:
```sql
ALTER TABLE "CreditLedger" DROP CONSTRAINT "CreditLedger_amount_nonnegative";
ALTER TABLE "AgentRun" DROP CONSTRAINT "AgentRun_charged_nonnegative";
ALTER TABLE "AgentRun" DROP CONSTRAINT "AgentRun_held_nonnegative";
ALTER TABLE "User" DROP CONSTRAINT "User_creditBalance_nonnegative";
DROP INDEX "Chat_title_trgm_idx";
DROP INDEX "Message_searchVector_idx";
ALTER TABLE "Message" DROP COLUMN "searchVector";
```
Leave `pg_trgm` installed if another database object uses it.

## 20261010140000_uploads_assets_waitpoints

Adds:
- `UploadAssembly`: one row per signed Transloadit upload, with declared and actual bytes and a terminal status
- `Asset.source` (upload or generated), `originalName`, `isTemporaryUrl`, `uploadId`, and nullable `bytes`
- a unique `(toolInvocationId, sourceUrl)` so a generated asset is stored once per tool result
- `Waitpoint.toolCallId` with a unique `(runId, toolCallId)`, so a retried approval reuses its row

Compatibility: `Waitpoint.toolCallId` is `NOT NULL` without a default. It is safe here because no build has written waitpoints yet. On a database that already has waitpoint rows, add the column as nullable, backfill, then set `NOT NULL`.

Rollback:
```sql
ALTER TABLE "UploadUsage" DROP CONSTRAINT "UploadUsage_bytes_nonnegative";
ALTER TABLE "Asset" DROP CONSTRAINT "Asset_uploadId_fkey";
DROP INDEX "Asset_toolInvocationId_sourceUrl_key";
DROP INDEX "Waitpoint_runId_toolCallId_key";
DROP INDEX "Waitpoint_status_expiresAt_idx";
DROP TABLE "UploadAssembly";
ALTER TABLE "Asset" DROP COLUMN "uploadId", DROP COLUMN "source", DROP COLUMN "originalName", DROP COLUMN "isTemporaryUrl";
ALTER TABLE "Waitpoint" DROP COLUMN "toolCallId";
DROP TYPE "AssemblyStatus";
DROP TYPE "AssetSource";
```
Restoring `Asset.bytes` to `INTEGER NOT NULL` needs every row to have a size that fits in 32 bits.

## 20261010160000_public_api

Adds API keys (only a SHA-256 hash is stored), webhook endpoints and deliveries, and direct Magica tool runs. `CreditLedger.directToolRunId` is nullable and uses `ON DELETE SET NULL`, so a ledger row outlives the tool run.

Rollback: drop the new foreign keys, indexes, and tables, then drop `CreditLedger.directToolRunId`. Deliveries must be dropped before endpoints.

## 20261011030000_webhook_retry

Adds `WebhookDelivery.nextAttemptAt`. A null value means the delivery is due. The status index follows that column so a retry pass can skip rows that are still waiting.

Rollback:
```sql
DROP INDEX "WebhookDelivery_status_nextAttemptAt_idx";
ALTER TABLE "WebhookDelivery" DROP COLUMN "nextAttemptAt";
CREATE INDEX "WebhookDelivery_status_createdAt_idx" ON "WebhookDelivery"("status", "createdAt");
```

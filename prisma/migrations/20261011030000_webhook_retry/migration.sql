-- Outbound webhook retries wait until nextAttemptAt. A null value means the row is due now.
ALTER TABLE "WebhookDelivery" ADD COLUMN "nextAttemptAt" TIMESTAMP(3);

DROP INDEX "WebhookDelivery_status_createdAt_idx";
CREATE INDEX "WebhookDelivery_status_nextAttemptAt_idx" ON "WebhookDelivery"("status", "nextAttemptAt");

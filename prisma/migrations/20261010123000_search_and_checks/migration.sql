-- Search and balance checks. Forward-only additions; see MIGRATIONS.md for rollback.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE "Message"
ADD COLUMN "searchVector" tsvector
GENERATED ALWAYS AS (to_tsvector('english', coalesce("contentText", ''))) STORED;

CREATE INDEX "Message_searchVector_idx" ON "Message" USING GIN ("searchVector");

CREATE INDEX "Chat_title_trgm_idx" ON "Chat" USING GIN ("title" gin_trgm_ops);

ALTER TABLE "User"
ADD CONSTRAINT "User_creditBalance_nonnegative" CHECK ("creditBalance" >= 0);

ALTER TABLE "AgentRun"
ADD CONSTRAINT "AgentRun_held_nonnegative" CHECK ("heldMicrocredits" >= 0);

ALTER TABLE "AgentRun"
ADD CONSTRAINT "AgentRun_charged_nonnegative" CHECK ("chargedMicrocredits" >= 0);

ALTER TABLE "CreditLedger"
ADD CONSTRAINT "CreditLedger_amount_nonnegative" CHECK ("amount" >= 0);

-- Migration: add_automation_followup_messages
-- Run this manually in the Supabase SQL Editor.
-- After running, mark it as applied in Prisma:
--   npx prisma migrate resolve --applied 20260806120000_add_automation_followup_messages
--
-- Purely additive: two nullable columns with no default and no backfill. Rows
-- created before this migration keep working — both stay NULL, and the send
-- function skips a follow-up whose value is null or blank.

ALTER TABLE "automations"
  ADD COLUMN IF NOT EXISTS "message_2" TEXT;

ALTER TABLE "automations"
  ADD COLUMN IF NOT EXISTS "message_3" TEXT;

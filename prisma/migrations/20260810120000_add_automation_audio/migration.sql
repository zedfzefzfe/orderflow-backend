-- Migration: add_automation_audio
-- Run this manually in the Supabase SQL Editor.
-- After running, mark it as applied in Prisma:
--   npx prisma migrate resolve --applied 20260810120000_add_automation_audio
--
-- Purely additive: one nullable column, no default and no backfill. Existing
-- automations keep working with it NULL, and the send function skips the step.

ALTER TABLE "automations"
  ADD COLUMN IF NOT EXISTS "audio_url" TEXT;

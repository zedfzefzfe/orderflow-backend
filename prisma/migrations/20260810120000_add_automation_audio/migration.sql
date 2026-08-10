-- Migration: add_automation_audio
-- Run this manually in the Supabase SQL Editor.
-- After running, mark it as applied in Prisma:
--   npx prisma migrate resolve --applied 20260810120000_add_automation_audio
--
-- Additive: one array column, defaulted to empty. Existing automations keep
-- working with it empty and skip the voice-note step.
--
-- Safe to run even if an earlier version of this file (which added a single
-- "audio_url" column) was already applied: the DO block carries that value over
-- and drops the old column. Running it twice is a no-op.

ALTER TABLE "automations"
  ADD COLUMN IF NOT EXISTS "audio_urls" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'automations' AND column_name = 'audio_url'
  ) THEN
    UPDATE "automations"
       SET "audio_urls" = ARRAY["audio_url"]
     WHERE "audio_url" IS NOT NULL
       AND cardinality("audio_urls") = 0;

    ALTER TABLE "automations" DROP COLUMN "audio_url";
  END IF;
END $$;

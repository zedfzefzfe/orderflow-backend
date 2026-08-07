-- Migration: add_automation_video_urls
-- Run this manually in the Supabase SQL Editor.
-- After running, mark it as applied in Prisma:
--   npx prisma migrate resolve --applied 20260807120000_add_automation_video_urls
--
-- Additive: one new array column, defaulted to empty. The existing video_url
-- column is deliberately KEPT — the dashboard still reads and writes it, and
-- the backend keeps it in sync with video_urls[0]. Dropping it is a separate
-- cleanup, once the frontend has moved to video_urls.

ALTER TABLE "automations"
  ADD COLUMN IF NOT EXISTS "video_urls" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Backfill: carry the single video over into the array. Idempotent — reruns
-- skip any row that already has entries, so it cannot duplicate a URL.
UPDATE "automations"
   SET "video_urls" = ARRAY["video_url"]
 WHERE "video_url" IS NOT NULL
   AND cardinality("video_urls") = 0;

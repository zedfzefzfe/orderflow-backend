-- Migration: add_automation_video_documents
-- Run this manually in the Supabase SQL Editor.
-- After running, mark it as applied in Prisma:
--   npx prisma migrate resolve --applied 20260803120000_add_automation_video_documents
--
-- Purely additive: two nullable/defaulted columns on an existing table. Rows
-- created before this migration keep working — video_url stays NULL and
-- document_urls defaults to an empty array.

ALTER TABLE "automations"
  ADD COLUMN IF NOT EXISTS "video_url" TEXT;

ALTER TABLE "automations"
  ADD COLUMN IF NOT EXISTS "document_urls" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

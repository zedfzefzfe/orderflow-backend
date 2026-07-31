-- Migration: add_automations
-- Run this manually in the Supabase SQL Editor.
-- After running, mark it as applied in Prisma:
--   npx prisma migrate resolve --applied 20260731120000_add_automations
--
-- Purely additive: creates one new table. No existing table is touched, so the
-- Zethnika flow (businesses.whatsapp_flow_config) keeps working untouched.

CREATE TABLE "automations" (
  "id"              TEXT         NOT NULL,
  "business_id"     TEXT         NOT NULL,
  "name"            TEXT         NOT NULL,
  "trigger_message" TEXT         NOT NULL,
  "welcome_message" TEXT         NOT NULL,
  "photo_urls"      TEXT[]       NOT NULL DEFAULT ARRAY[]::TEXT[],
  "is_active"       BOOLEAN      NOT NULL DEFAULT true,
  "priority"        INTEGER      NOT NULL DEFAULT 0,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMP(3) NOT NULL,

  CONSTRAINT "automations_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "automations_business_id_idx" ON "automations"("business_id");

ALTER TABLE "automations"
  ADD CONSTRAINT "automations_business_id_fkey"
  FOREIGN KEY ("business_id") REFERENCES "businesses"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

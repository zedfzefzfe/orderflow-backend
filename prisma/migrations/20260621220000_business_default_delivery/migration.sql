-- Migration: 20260621220000_business_default_delivery
-- À coller dans Supabase SQL Editor.

ALTER TABLE "businesses"
  ADD COLUMN IF NOT EXISTS "default_delivery_company" "DeliveryCompany";

INSERT INTO "_prisma_migrations" (
  id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count
) VALUES (
  gen_random_uuid()::text,
  'business_default_delivery_manual',
  NOW(),
  '20260621220000_business_default_delivery',
  NULL, NULL, NOW(), 1
);

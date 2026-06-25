-- Migration: add_whatsapp_automation
-- Run this manually in the Supabase SQL Editor.
-- After running, mark it as applied in Prisma:
--   npx prisma migrate resolve --applied 20260625000000_add_whatsapp_automation

ALTER TABLE businesses
  ADD COLUMN whatsapp_instance_name TEXT,
  ADD COLUMN whatsapp_connected     BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN whatsapp_flow_config   JSONB;

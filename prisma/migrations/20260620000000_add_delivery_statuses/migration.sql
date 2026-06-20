-- Add new delivery lifecycle statuses to the OrderStatus enum
-- PostgreSQL allows adding enum values non-destructively with IF NOT EXISTS
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'EN_LIVRAISON';
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'LIVRE';
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'RETOURNE';
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'ANNULE';

-- Add deliveredAt timestamp (set when order reaches LIVRE status)
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "delivered_at" TIMESTAMP(3);

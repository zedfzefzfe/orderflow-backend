-- Migrate all existing 'NEW' orders to 'CONFIRMED'
UPDATE "orders" SET "status" = 'CONFIRMED' WHERE "status" = 'NEW';

-- Recreate the OrderStatus enum without 'NEW'
-- PostgreSQL does not support removing enum values directly, so we:
-- 1. Create a new enum type
-- 2. Migrate the column
-- 3. Drop the old type and rename

CREATE TYPE "OrderStatus_new" AS ENUM ('CONFIRMED', 'DELIVERED', 'CANCELLED');

ALTER TABLE "orders"
  ALTER COLUMN "status" DROP DEFAULT,
  ALTER COLUMN "status" TYPE "OrderStatus_new"
    USING "status"::text::"OrderStatus_new";

DROP TYPE "OrderStatus";
ALTER TYPE "OrderStatus_new" RENAME TO "OrderStatus";

-- Set new default to CONFIRMED
ALTER TABLE "orders" ALTER COLUMN "status" SET DEFAULT 'CONFIRMED';

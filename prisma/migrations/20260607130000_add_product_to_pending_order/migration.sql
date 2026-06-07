-- AlterTable
ALTER TABLE "PendingOrder"
  ADD COLUMN "product"       TEXT,
  ADD COLUMN "price"         DOUBLE PRECISION,
  ADD COLUMN "deliveryPrice" DOUBLE PRECISION;

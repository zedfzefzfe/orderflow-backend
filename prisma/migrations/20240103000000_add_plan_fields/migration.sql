-- AlterTable
ALTER TABLE "businesses" ADD COLUMN "email" TEXT;
ALTER TABLE "businesses" ADD COLUMN "plan" TEXT NOT NULL DEFAULT 'trial';
ALTER TABLE "businesses" ADD COLUMN "trial_ends_at" TIMESTAMP(3);

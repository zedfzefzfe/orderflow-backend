-- CreateEnum: ReturnReason
CREATE TYPE "ReturnReason" AS ENUM (
  'INJOIGNABLE',
  'REFUSE_LIVRAISON',
  'FAUSSE_COMMANDE',
  'ANNULE_AVANT_LIVRAISON',
  'REPORTE_CLIENT',
  'MAUVAISE_ADRESSE',
  'PROBLEME_PRODUIT',
  'AUTRE'
);

-- AddColumn: merchant status layer fields on orders
ALTER TABLE "orders"
  ADD COLUMN IF NOT EXISTS "estimated_delivery_at"   TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "confirmation_resolved"    BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "confirmation_resolved_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "confirmation_source"      TEXT,
  ADD COLUMN IF NOT EXISTS "return_reason"            "ReturnReason",
  ADD COLUMN IF NOT EXISTS "delivery_attempted_at"    TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "merchant_notified_at"     TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "escalation_triggered_at"  TIMESTAMP(3);

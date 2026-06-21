-- Migration: 20260621210000_add_structured_fields
-- Tous les champs sont nullable — zéro breaking change.
-- À coller dans Supabase SQL Editor.

-- ── Enums ──────────────────────────────────────────────────────────────────────

CREATE TYPE "BusinessSector" AS ENUM (
  'BEAUTE_COSMETIQUES',
  'MODE_VETEMENTS',
  'DECORATION_MAISON',
  'ELECTRONIQUE_HIGH_TECH',
  'ALIMENTATION_EPICERIE',
  'SPORT_FITNESS',
  'BEBE_ENFANT',
  'BIJOUX_ACCESSOIRES',
  'AUTRE'
);

CREATE TYPE "ProductCategory" AS ENUM (
  'BOUGIES_BOUQUETS',
  'PARFUMS',
  'VETEMENTS_MODE',
  'COSMETIQUES_BEAUTE',
  'BIJOUX_ACCESSOIRES',
  'DECORATION_MAISON',
  'ELECTRONIQUE',
  'ALIMENTATION',
  'SPORT_FITNESS',
  'BEBE_ENFANT',
  'AUTRE'
);

CREATE TYPE "MoroccanWilaya" AS ENUM (
  'CASABLANCA',
  'RABAT',
  'MARRAKECH',
  'FES',
  'TANGER',
  'AGADIR',
  'MEKNES',
  'OUJDA',
  'KENITRA',
  'TETOUAN',
  'SALE',
  'TEMARA',
  'MOHAMMEDIA',
  'EL_JADIDA',
  'BENI_MELLAL',
  'NADOR',
  'SETTAT',
  'KHOURIBGA',
  'SAFI',
  'LAAYOUNE',
  'AUTRE'
);

CREATE TYPE "DeliveryCompany" AS ENUM (
  'AMANA',
  'MAYSTRO',
  'OZONEXPRESS',
  'CATHEDIS',
  'SENDIT',
  'TAWSSIL',
  'AMEEX',
  'AUTRE'
);

-- ── businesses ─────────────────────────────────────────────────────────────────

ALTER TABLE "businesses"
  ADD COLUMN "sector" "BusinessSector",
  ADD COLUMN "wilaya" "MoroccanWilaya",
  ADD COLUMN "city"   TEXT;

-- ── orders ─────────────────────────────────────────────────────────────────────

ALTER TABLE "orders"
  ADD COLUMN "product_category" "ProductCategory",
  ADD COLUMN "wilaya"           "MoroccanWilaya",
  ADD COLUMN "city"             TEXT,
  ADD COLUMN "delivery_company" "DeliveryCompany";

-- ── customers ──────────────────────────────────────────────────────────────────

ALTER TABLE "customers"
  ADD COLUMN "wilaya"          "MoroccanWilaya",
  ADD COLUMN "city"            TEXT,
  ADD COLUMN "first_order_at"  TIMESTAMP(3),
  ADD COLUMN "avg_order_value" DOUBLE PRECISION;

-- ── Marquer la migration comme appliquée dans _prisma_migrations ───────────────

INSERT INTO "_prisma_migrations" (
  id,
  checksum,
  finished_at,
  migration_name,
  logs,
  rolled_back_at,
  started_at,
  applied_steps_count
) VALUES (
  gen_random_uuid()::text,
  'add_structured_fields_manual',
  NOW(),
  '20260621210000_add_structured_fields',
  NULL,
  NULL,
  NOW(),
  1
);

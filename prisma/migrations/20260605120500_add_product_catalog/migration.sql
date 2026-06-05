-- CreateTable
CREATE TABLE "product_catalog" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_catalog_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "product_catalog" ADD CONSTRAINT "product_catalog_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

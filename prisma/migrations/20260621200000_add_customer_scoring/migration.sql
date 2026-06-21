-- CreateTable: customers (scoring par client / par business)
CREATE TABLE "customers" (
    "id"                   TEXT NOT NULL,
    "phone"                TEXT NOT NULL,
    "business_id"          TEXT NOT NULL,
    "names"                TEXT[] NOT NULL DEFAULT '{}',
    "total_orders"         INTEGER NOT NULL DEFAULT 0,
    "delivered"            INTEGER NOT NULL DEFAULT 0,
    "client_fault_returns" INTEGER NOT NULL DEFAULT 0,
    "reporte_client"       INTEGER NOT NULL DEFAULT 0,
    "legit_returns"        INTEGER NOT NULL DEFAULT 0,
    "fault_points"         DOUBLE PRECISION NOT NULL DEFAULT 0,
    "risk_score"           INTEGER NOT NULL DEFAULT 0,
    "risk_level"           TEXT NOT NULL DEFAULT 'FIABLE',
    "last_order_at"        TIMESTAMP(3),
    "created_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: unicité (phone, business_id)
CREATE UNIQUE INDEX "customers_phone_business_id_key" ON "customers"("phone", "business_id");

-- AddForeignKey
ALTER TABLE "customers"
    ADD CONSTRAINT "customers_business_id_fkey"
    FOREIGN KEY ("business_id") REFERENCES "businesses"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

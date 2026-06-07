-- CreateTable
CREATE TABLE "PendingOrder" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "customerPhone" TEXT NOT NULL,
    "customerName" TEXT,
    "phone" TEXT,
    "address" TEXT,
    "deliveryDate" TEXT,
    "status" TEXT NOT NULL DEFAULT 'WAITING_CLIENT_INFO',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PendingOrder_pkey" PRIMARY KEY ("id")
);

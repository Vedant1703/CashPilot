-- CreateEnum
CREATE TYPE "PaymentProvenance" AS ENUM ('NONE', 'PAYPAL_VERIFIED', 'SIMULATED_DEMO_PAYMENT');

-- AlterEnum
ALTER TYPE "CashPilotStatus" ADD VALUE 'SIMULATED_PAID';

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN "paymentProvenance" "PaymentProvenance" NOT NULL DEFAULT 'NONE',
ADD COLUMN "simulatedPaymentAt" TIMESTAMP(3),
ADD COLUMN "simulatedAmountMinorUnits" INTEGER,
ADD COLUMN "simulatedActorId" TEXT,
ADD COLUMN "simulatedRef" TEXT;

-- CreateIndex
CREATE INDEX "Invoice_paymentProvenance_idx" ON "Invoice"("paymentProvenance");

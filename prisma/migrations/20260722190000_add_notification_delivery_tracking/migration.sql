-- CreateEnum
CREATE TYPE "NotificationDeliveryStatus" AS ENUM ('PENDING', 'SENT', 'FAILED_TRANSIENT', 'FAILED_PERMANENT');

-- AlterTable: add delivery-retry tracking to Notification
ALTER TABLE "Notification" ADD COLUMN "deliveryStatus" "NotificationDeliveryStatus" NOT NULL DEFAULT 'PENDING';
ALTER TABLE "Notification" ADD COLUMN "attemptCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Notification" ADD COLUMN "lastAttemptAt" TIMESTAMP(3);
ALTER TABLE "Notification" ADD COLUMN "lastError" TEXT;

-- CreateIndex
CREATE INDEX "Notification_deliveryStatus_idx" ON "Notification"("deliveryStatus");

-- AlterTable: add delivery-retry tracking to TaxReceipt
ALTER TABLE "TaxReceipt" ADD COLUMN "attemptCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "TaxReceipt" ADD COLUMN "lastAttemptAt" TIMESTAMP(3);
ALTER TABLE "TaxReceipt" ADD COLUMN "lastError" TEXT;

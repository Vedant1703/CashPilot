-- CreateEnum
CREATE TYPE "CashPilotStatus" AS ENUM ('DRAFT', 'AWAITING_PAYMENT', 'DUE_SOON', 'OVERDUE', 'PAID', 'CANCELLED', 'NEEDS_REVIEW');

-- CreateEnum
CREATE TYPE "AiDraftReviewStatus" AS ENUM ('PENDING', 'ACCEPTED', 'EDITED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ApprovalAction" AS ENUM ('SEND_INVOICE', 'SEND_REMINDER', 'CANCEL_INVOICE');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'INVALIDATED', 'EXPIRED', 'USED');

-- CreateEnum
CREATE TYPE "OperationType" AS ENUM ('CREATE_DRAFT', 'SEND_INVOICE', 'SEND_REMINDER', 'CANCEL_INVOICE', 'GET_INVOICE');

-- CreateEnum
CREATE TYPE "OperationAttemptState" AS ENUM ('PENDING', 'IN_FLIGHT', 'SUCCESS', 'FAILED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "ActivityEventType" AS ENUM ('INVOICE_CREATED', 'INVOICE_UPDATED', 'INVOICE_DELETED', 'INVOICE_STATUS_CHANGED', 'AI_DRAFT_GENERATED', 'AI_DRAFT_ACCEPTED', 'AI_DRAFT_REJECTED', 'APPROVAL_CREATED', 'APPROVAL_APPROVED', 'APPROVAL_INVALIDATED', 'APPROVAL_EXPIRED', 'OPERATION_ATTEMPTED', 'OPERATION_SUCCEEDED', 'OPERATION_FAILED', 'OPERATION_TIMED_OUT', 'STATUS_SYNC_SUCCESS', 'STATUS_SYNC_FAILED', 'STATUS_SYNC_RECONCILED', 'SYSTEM_EVENT');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('USER', 'SYSTEM', 'AI');

-- CreateTable
CREATE TABLE "Workspace" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Client" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "company" TEXT,
    "notes" TEXT,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Client_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "number" TEXT,
    "title" TEXT,
    "notes" TEXT,
    "terms" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "subtotalMinorUnits" INTEGER NOT NULL,
    "taxRateBasisPoints" INTEGER NOT NULL DEFAULT 0,
    "taxMinorUnits" INTEGER NOT NULL DEFAULT 0,
    "totalMinorUnits" INTEGER NOT NULL,
    "invoiceDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "cashpilotStatus" "CashPilotStatus" NOT NULL DEFAULT 'DRAFT',
    "paypalInvoiceId" TEXT,
    "paypalStatus" TEXT,
    "paypalStatusRaw" JSONB,
    "lastSyncAt" TIMESTAMP(3),
    "syncIsStale" BOOLEAN NOT NULL DEFAULT false,
    "isDemoData" BOOLEAN NOT NULL DEFAULT false,
    "aiDraftId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceLineItem" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPriceMinorUnits" INTEGER NOT NULL,
    "totalMinorUnits" INTEGER NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InvoiceLineItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiDraft" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "inputText" TEXT NOT NULL,
    "structuredOutput" JSONB NOT NULL,
    "evidenceSources" JSONB,
    "modelName" TEXT,
    "promptVersion" TEXT,
    "reviewStatus" "AiDraftReviewStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedAt" TIMESTAMP(3),
    "invoiceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiDraft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Approval" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "invoiceId" TEXT,
    "actorId" TEXT NOT NULL,
    "actionType" "ApprovalAction" NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "payloadSnapshot" JSONB NOT NULL,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "approvedAt" TIMESTAMP(3),
    "invalidatedAt" TIMESTAMP(3),
    "invalidationReason" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Approval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExternalOperation" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "invoiceId" TEXT,
    "approvalId" TEXT,
    "operationType" "OperationType" NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'paypal',
    "idempotencyKey" TEXT,
    "correlationId" TEXT,
    "attemptState" "OperationAttemptState" NOT NULL DEFAULT 'PENDING',
    "attemptedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "providerInvoiceId" TEXT,
    "providerResponse" JSONB,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "isOutcomeUnknown" BOOLEAN NOT NULL DEFAULT false,
    "reconciledAt" TIMESTAMP(3),
    "reconcileResult" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExternalOperation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivityEvent" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "invoiceId" TEXT,
    "approvalId" TEXT,
    "operationId" TEXT,
    "eventType" "ActivityEventType" NOT NULL,
    "actorType" "ActorType" NOT NULL,
    "actorId" TEXT,
    "description" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivityEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Workspace_ownerId_idx" ON "Workspace"("ownerId");

-- CreateIndex
CREATE INDEX "Client_workspaceId_idx" ON "Client"("workspaceId");

-- CreateIndex
CREATE INDEX "Client_email_workspaceId_idx" ON "Client"("email", "workspaceId");

-- CreateIndex
CREATE INDEX "Invoice_workspaceId_idx" ON "Invoice"("workspaceId");

-- CreateIndex
CREATE INDEX "Invoice_clientId_idx" ON "Invoice"("clientId");

-- CreateIndex
CREATE INDEX "Invoice_cashpilotStatus_idx" ON "Invoice"("cashpilotStatus");

-- CreateIndex
CREATE INDEX "Invoice_paypalInvoiceId_idx" ON "Invoice"("paypalInvoiceId");

-- CreateIndex
CREATE INDEX "InvoiceLineItem_invoiceId_idx" ON "InvoiceLineItem"("invoiceId");

-- CreateIndex
CREATE INDEX "AiDraft_workspaceId_idx" ON "AiDraft"("workspaceId");

-- CreateIndex
CREATE INDEX "Approval_workspaceId_idx" ON "Approval"("workspaceId");

-- CreateIndex
CREATE INDEX "Approval_invoiceId_idx" ON "Approval"("invoiceId");

-- CreateIndex
CREATE INDEX "Approval_payloadHash_idx" ON "Approval"("payloadHash");

-- CreateIndex
CREATE INDEX "ExternalOperation_workspaceId_idx" ON "ExternalOperation"("workspaceId");

-- CreateIndex
CREATE INDEX "ExternalOperation_invoiceId_idx" ON "ExternalOperation"("invoiceId");

-- CreateIndex
CREATE INDEX "ExternalOperation_idempotencyKey_idx" ON "ExternalOperation"("idempotencyKey");

-- CreateIndex
CREATE INDEX "ActivityEvent_workspaceId_idx" ON "ActivityEvent"("workspaceId");

-- CreateIndex
CREATE INDEX "ActivityEvent_invoiceId_idx" ON "ActivityEvent"("invoiceId");

-- CreateIndex
CREATE INDEX "ActivityEvent_createdAt_idx" ON "ActivityEvent"("createdAt");

-- AddForeignKey
ALTER TABLE "Client" ADD CONSTRAINT "Client_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceLineItem" ADD CONSTRAINT "InvoiceLineItem_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalOperation" ADD CONSTRAINT "ExternalOperation_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalOperation" ADD CONSTRAINT "ExternalOperation_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalOperation" ADD CONSTRAINT "ExternalOperation_approvalId_fkey" FOREIGN KEY ("approvalId") REFERENCES "Approval"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityEvent" ADD CONSTRAINT "ActivityEvent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityEvent" ADD CONSTRAINT "ActivityEvent_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityEvent" ADD CONSTRAINT "ActivityEvent_approvalId_fkey" FOREIGN KEY ("approvalId") REFERENCES "Approval"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityEvent" ADD CONSTRAINT "ActivityEvent_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "ExternalOperation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

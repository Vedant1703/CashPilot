-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- Backfill existing workspace owners into User table before enforcing foreign key
INSERT INTO "User" ("id", "email", "name", "passwordHash", "createdAt", "updatedAt")
SELECT DISTINCT
    w."ownerId" AS "id",
    CASE
        WHEN w."ownerId" = 'demo-user-1' THEN 'demo@cashpilot.test'
        ELSE 'legacy+' || w."ownerId" || '@legacy.cashpilot.internal'
    END AS "email",
    CASE
        WHEN w."ownerId" = 'demo-user-1' THEN 'Demo User'
        ELSE 'Legacy Workspace Owner (' || w."ownerId" || ')'
    END AS "name",
    CASE
        WHEN w."ownerId" = 'demo-user-1' THEN '!LOCKED:DEMO_USER_MANAGED_AUTH'
        ELSE '!LOCKED:LEGACY_BACKFILL'
    END AS "passwordHash",
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "Workspace" w
WHERE NOT EXISTS (
    SELECT 1 FROM "User" u WHERE u."id" = w."ownerId"
);

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Workspace" ADD CONSTRAINT "Workspace_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

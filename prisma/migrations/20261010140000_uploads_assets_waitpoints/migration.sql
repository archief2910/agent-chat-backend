-- CreateEnum
CREATE TYPE "AssetSource" AS ENUM ('upload', 'generated');

-- CreateEnum
CREATE TYPE "AssemblyStatus" AS ENUM ('pending', 'completed', 'failed', 'canceled');

-- AlterTable
ALTER TABLE "Waitpoint" ADD COLUMN     "toolCallId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "Asset" ADD COLUMN     "isTemporaryUrl" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "originalName" TEXT,
ADD COLUMN     "source" "AssetSource" NOT NULL DEFAULT 'upload',
ADD COLUMN     "uploadId" TEXT,
ALTER COLUMN "bytes" DROP NOT NULL,
ALTER COLUMN "bytes" SET DATA TYPE BIGINT;

-- CreateTable
CREATE TABLE "UploadAssembly" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "assemblyId" TEXT,
    "status" "AssemblyStatus" NOT NULL DEFAULT 'pending',
    "declaredBytes" BIGINT NOT NULL,
    "actualBytes" BIGINT NOT NULL DEFAULT 0,
    "fileCount" INTEGER NOT NULL,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UploadAssembly_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UploadAssembly_assemblyId_key" ON "UploadAssembly"("assemblyId");

-- CreateIndex
CREATE INDEX "UploadAssembly_userId_createdAt_idx" ON "UploadAssembly"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "UploadAssembly_status_createdAt_idx" ON "UploadAssembly"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Waitpoint_status_expiresAt_idx" ON "Waitpoint"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Waitpoint_runId_toolCallId_key" ON "Waitpoint"("runId", "toolCallId");

-- CreateIndex
CREATE UNIQUE INDEX "Asset_toolInvocationId_sourceUrl_key" ON "Asset"("toolInvocationId", "sourceUrl");

-- AddForeignKey
ALTER TABLE "UploadAssembly" ADD CONSTRAINT "UploadAssembly_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_uploadId_fkey" FOREIGN KEY ("uploadId") REFERENCES "UploadAssembly"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "UploadAssembly"
ADD CONSTRAINT "UploadAssembly_bytes_nonnegative" CHECK ("declaredBytes" >= 0 AND "actualBytes" >= 0);

ALTER TABLE "UploadUsage"
ADD CONSTRAINT "UploadUsage_bytes_nonnegative" CHECK ("bytes" >= 0);

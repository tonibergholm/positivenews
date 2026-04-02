-- AlterTable: add rejection tracking fields to Article
ALTER TABLE "Article" ADD COLUMN "rejectionReason" TEXT;
ALTER TABLE "Article" ADD COLUMN "rejectionPass" INTEGER;

-- AlterTable: add IP tracking and staleness fields to LearnedKeyword
ALTER TABLE "LearnedKeyword" ADD COLUMN "uniqueIps" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "LearnedKeyword" ADD COLUMN "lastHitAt" TIMESTAMP(3);
ALTER TABLE "LearnedKeyword" ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateTable
CREATE TABLE "LearnedKeywordFlag" (
    "id" TEXT NOT NULL,
    "keyword" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "ip" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LearnedKeywordFlag_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LearnedKeywordFlag_keyword_language_ip_key" ON "LearnedKeywordFlag"("keyword", "language", "ip");

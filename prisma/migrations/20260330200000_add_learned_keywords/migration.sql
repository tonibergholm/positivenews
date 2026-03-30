-- AlterTable
ALTER TABLE "Article" ADD COLUMN "flaggedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "LearnedKeyword" (
    "id" TEXT NOT NULL,
    "keyword" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'en',
    "hits" INTEGER NOT NULL DEFAULT 1,
    "active" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "LearnedKeyword_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LearnedKeyword_keyword_key" ON "LearnedKeyword"("keyword");

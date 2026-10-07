-- CreateTable
CREATE TABLE "JevEvaluation" (
    "id" TEXT NOT NULL,
    "articleId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "questionSet" TEXT NOT NULL,
    "answers" JSONB NOT NULL,
    "positiveP" DOUBLE PRECISION NOT NULL,
    "upliftingP" DOUBLE PRECISION NOT NULL,
    "upliftScore" DOUBLE PRECISION NOT NULL,
    "topCategory" TEXT NOT NULL,
    "topCategoryP" DOUBLE PRECISION NOT NULL,
    "inputTokens" INTEGER NOT NULL,
    "latencyMs" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JevEvaluation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "JevEvaluation_articleId_questionSet_key" ON "JevEvaluation"("articleId", "questionSet");

-- AddForeignKey
ALTER TABLE "JevEvaluation" ADD CONSTRAINT "JevEvaluation_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "Article"("id") ON DELETE CASCADE ON UPDATE CASCADE;

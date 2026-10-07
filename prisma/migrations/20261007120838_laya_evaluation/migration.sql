-- CreateTable
CREATE TABLE "LayaEvaluation" (
    "id" TEXT NOT NULL,
    "articleId" TEXT NOT NULL,
    "checkpoint" TEXT NOT NULL,
    "experimental" BOOLEAN NOT NULL DEFAULT false,
    "keepP" DOUBLE PRECISION NOT NULL,
    "reason" TEXT NOT NULL,
    "reasonP" DOUBLE PRECISION NOT NULL,
    "answers" JSONB NOT NULL,
    "latencyMs" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LayaEvaluation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LayaEvaluation_checkpoint_createdAt_idx" ON "LayaEvaluation"("checkpoint", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "LayaEvaluation_articleId_checkpoint_key" ON "LayaEvaluation"("articleId", "checkpoint");

-- AddForeignKey
ALTER TABLE "LayaEvaluation" ADD CONSTRAINT "LayaEvaluation_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "Article"("id") ON DELETE CASCADE ON UPDATE CASCADE;

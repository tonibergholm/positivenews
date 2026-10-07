-- CreateTable
CREATE TABLE "LabelEvent" (
    "id" TEXT NOT NULL,
    "articleId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "verdict" TEXT NOT NULL,
    "category" TEXT,
    "actor" TEXT,
    "reason" TEXT,
    "pass" INTEGER,
    "eligible" BOOLEAN NOT NULL DEFAULT true,
    "bucket" TEXT,
    "retractsId" TEXT,
    "prevState" JSONB,
    "dedupeKey" TEXT,
    "backfilled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LabelEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LabelEvent_dedupeKey_key" ON "LabelEvent"("dedupeKey");

-- CreateIndex
CREATE INDEX "LabelEvent_articleId_createdAt_idx" ON "LabelEvent"("articleId", "createdAt");

-- CreateIndex
CREATE INDEX "LabelEvent_source_createdAt_idx" ON "LabelEvent"("source", "createdAt");

-- CreateIndex
CREATE INDEX "Article_createdAt_idx" ON "Article"("createdAt");

-- AddForeignKey
ALTER TABLE "LabelEvent" ADD CONSTRAINT "LabelEvent_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "Article"("id") ON DELETE CASCADE ON UPDATE CASCADE;

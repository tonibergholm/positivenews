-- Add curatedAt column to track LLM curation status
ALTER TABLE "Article" ADD COLUMN "curatedAt" TIMESTAMP(3);

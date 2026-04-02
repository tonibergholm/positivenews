-- Scope learned keywords by language so identical tokens in different languages
-- don't share hit counts or activation state.
DROP INDEX "LearnedKeyword_keyword_key";

CREATE UNIQUE INDEX "LearnedKeyword_keyword_language_key"
ON "LearnedKeyword"("keyword", "language");

/**
 * Extract significant keywords from an article title for learning.
 * Filters out stop words and short tokens.
 */

const STOP_WORDS_EN = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all", "can", "her",
  "was", "one", "our", "out", "has", "have", "had", "its", "that", "this",
  "with", "will", "from", "they", "been", "said", "each", "which", "their",
  "than", "other", "into", "more", "some", "them", "then", "what", "when",
  "were", "would", "there", "about", "could", "after", "also", "just",
  "how", "new", "who", "may", "most", "over", "very",
]);

const STOP_WORDS_FI = new Set([
  "oli", "olla", "kun", "nyt", "tai", "sen", "hän", "myös", "yli", "mutta",
  "niin", "että", "vain", "joka", "sekä", "tämä", "tässä", "sitä", "siitä",
  "ovat", "voi", "tuli", "oli", "ovat", "eikä", "itse", "kuin", "mutta",
  "koko", "mikä", "miten", "jossa", "eivät", "onko", "vielä", "missä",
  "enää", "tulee", "sitten", "tämän", "hänen", "näin", "hyvin", "paljon",
  "uusi", "suuri", "kaikki", "vuoden", "vuotta",
]);

export function extractKeywords(title: string, language: string): string[] {
  const stopWords = language === "fi" ? STOP_WORDS_FI : STOP_WORDS_EN;

  const tokens = title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 4 && !stopWords.has(t));

  // Deduplicate
  return [...new Set(tokens)];
}

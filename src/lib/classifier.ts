/**
 * Positive-news classifier.
 *
 * Uses keyword matching with Finnish stem awareness. Small local LLMs
 * (1-3 B) proved unreliable at nuanced sentiment classification,
 * especially for Finnish text, so we use a deterministic approach.
 *
 * The keyword lists target clearly negative content (violence, war,
 * disasters, crime). Articles without strong negative signals pass.
 */

// Negative stems / keywords — we check if any token STARTS WITH these.
// Using stems handles Finnish inflection (e.g. "murha" matches
// "murhasta", "murhan", "murhattiin").
const NEGATIVE_STEMS_FI = [
  "murha",    // murder
  "surma",    // killing
  "puukot",   // stabbing
  "ampum",    // shooting
  "kuol",     // death/died
  "kuolem",   // death (noun forms)
  "tappo",    // manslaughter
  "tappa",    // to kill
  "tapett",   // killed
  "terrori",  // terrorism
  "hyökkä",   // attack
  "pommi",    // bomb
  "räjähd",   // explosion
  "tulipalo", // fire
  "palo",     // fire (compound: tehdaspalo, metsäpalo)
  "onnettom", // accident
  "kolari",   // collision/crash
  "turma",    // fatal accident
  "uhri",     // victim
  "pahoinpi", // assault
  "raisk",    // rape
  "ryöst",    // robbery
  "vanki",    // prisoner
  "kidna",    // kidnapping
  "maanjäri", // earthquake
  "tsunami",
  "hurrikaa", // hurricane
  "bensa",    // skip — too common
];

const NEGATIVE_WORDS_EN = [
  "shooting",
  "murdered",
  "murder",
  "killed",
  "killing",
  "dead",
  "death",
  "deaths",
  "massacre",
  "bombing",
  "bomber",
  "terrorist",
  "terrorism",
  "attack",
  "stabbed",
  "stabbing",
  "crash",
  "crashed",
  "earthquake",
  "tsunami",
  "hurricane",
  "flood",
  "wildfire",
  "explosion",
  "war",
  "assault",
  "robbery",
  "kidnap",
  "rape",
  "victim",
  "casualties",
  "fatalities",
  "devastat",
  "carnage",
];

// Positive override stems — if these appear alongside negatives, lean positive.
// E.g. "läpimurto" (breakthrough) contains "murto" but is positive.
const POSITIVE_OVERRIDES_FI = [
  "läpimur",    // breakthrough
  "selviyty",   // survived/surviving (positive framing)
  "pelast",     // rescued/saved
  "toipu",      // recovered
  "paranne",    // improvement/cure
  "edisty",     // progress
  "voitt",      // win/victory
  "ennätys",    // record (achievement)
  "löytö",      // discovery
  "keksint",    // invention
];

const POSITIVE_OVERRIDES_EN = [
  "breakthrough",
  "surviv",
  "rescu",
  "recover",
  "cure",
  "saved",
  "progress",
  "discover",
  "solution",
  "victory",
  "record-break",
];

// Minimum negative keyword hits to classify as negative
const THRESHOLD = 1;

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2);
}

function stemMatch(tokens: string[], stems: string[], useIncludes: boolean): number {
  let hits = 0;
  for (const token of tokens) {
    for (const stem of stems) {
      if (useIncludes ? token.includes(stem) : token.startsWith(stem)) {
        hits++;
        break;
      }
    }
  }
  return hits;
}

export function classifyPositive(
  title: string,
  summary?: string | null,
  language = "en"
): boolean {
  const text = summary
    ? `${title} ${summary.slice(0, 300)}`
    : title;

  const tokens = tokenize(text);

  const negativeStems = language === "fi" ? NEGATIVE_STEMS_FI : NEGATIVE_WORDS_EN;
  const positiveStems = language === "fi" ? POSITIVE_OVERRIDES_FI : POSITIVE_OVERRIDES_EN;

  const isFinnish = language === "fi";
  const negHits = stemMatch(tokens, negativeStems, isFinnish);
  const posHits = stemMatch(tokens, positiveStems, isFinnish);

  // If positive signals present alongside negative, lean positive
  if (posHits > 0 && negHits <= posHits) return true;

  return negHits < THRESHOLD;
}

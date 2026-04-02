/**
 * Positive-news classifier.
 *
 * Uses keyword matching with Finnish stem awareness plus learned
 * keywords from user feedback. Learned keywords are cached in memory
 * and refreshed every 5 minutes.
 */

import { prisma } from "./prisma";

// ── Built-in negative stems ─────────────────────────────────────────

const NEGATIVE_STEMS_FI = [
  // Violence & crime
  "murha", "surma", "puukot", "ampum", "tappo", "tappa", "tapett",
  "pahoinpi", "raisk", "ryöst", "kidna", "vanki",
  // Death
  "kuol", "kuolem",
  // War & terror
  "terrori", "hyökkä", "pommi", "räjähd", "sota",
  // Disasters
  "tulipalo", "palo", "onnettom", "kolari", "turma",
  "maanjäri", "tsunami", "hurrikaa",
  // Victims
  "uhri",
  // Irrelevant: sports scores, roster moves & lawsuits
  "ottelu", "liiga", "valioliig", "veikkausliig",
  "sarjataul", "playoff", "siirtyy", "lähtee",
  "sopimus", "jatkosopim", "haastett", "oikeuteen",
  "murskasi", "nhl",
  // Irrelevant: car/product reviews
  "koeajo", "pikatesti", "autotesti",
  // Drones & military
  "drooni", "droone", "hävittäj", "ilmatil",
  // Geopolitics & threats
  "valtaamis", "pakottee", "uhkaa", "trump",
  // Cost complaints & insurance
  "kallistum", "hinnannous", "kallistui", "vakuutus",
  "vesivahin",
  // Health alarms
  "rokottam",
  // Filler content
  "ristikko", "miniristikko", "visailu",
  // Administrative disputes & politics
  "kantelee", "oikeuskansleri", "virusinfekt",
  "peruuntu",
  // Business clickbait
  "epäonnistu",
  // Layoffs
  "irtisano", "yt-neuvottel",
  // Court/sentencing/crime
  "tuomio", "tuomits", "tuomittu", "syyte", "syrjin",
  "esitutkint", "esitutkinn", "tietovuod",
  // Arrest (vangittiin conjugation escapes "vanki" due to consonant gradation)
  "vangitt",
  // Animal attacks
  "puri",
  // Labor disputes
  "työriid", "lakko",
  // Inflation & economy
  "inflaatio", "suhdanne",
  // Debt & payment defaults
  "maksuhäiriö", "velkaantu", "maksuvaikeuk",
  // Bullying
  "kiusaami",
  // Outsourcing fluff
  "ulkoistam",
  // Suspicious activity
  "epäilyttäv",
  // Military spending
  "ilmapuolustus",
  // Crisis/doom sentiment
  "kriis",
  // Constitutional/privacy politics
  "perustuslai", "perusoikeu",
  // Sports investigations
  "tutkinnan",
  // Danger/hazard
  "hengenvaar",
];

const NEGATIVE_WORDS_EN = [
  // Violence & crime
  "shooting", "murdered", "murder", "killed", "killing",
  "massacre", "bombing", "bomber", "stabbed", "stabbing",
  "assault", "robbery", "kidnap", "rape", "carnage",
  // Death & suffering
  "dead", "death", "deaths", "victim", "casualties", "fatalities",
  // War & terror
  "terrorist", "terrorism", "attack", "war",
  // Disasters
  "crash", "crashed", "earthquake", "tsunami", "hurricane",
  "flood", "wildfire", "explosion",
  // Irrelevant: sports scores
  "scores", "standings", "playoff", "halftime",
  "relegation", "matchday", "crushed", "thrashed",
  "fatigue", "sportsball",
  // Irrelevant: reviews & sales
  "test-drive", "sale",
  // Product marketing
  "ugly",
  // Wildlife crime / environmental loss
  "poaching",
  // Drones & military
  "drone", "drones",
  // Geopolitics
  "trump", "sanctions", "invasion",
  // Business clickbait / CEO puff
  "fail", "fails", "failing",
  // Data breaches / investigations
  "investigation",
  // Inflation
  "inflation",
  // Discrimination
  "discrimination",
];

const NEGATIVE_PREFIXES_EN = [
  "devastat",
  "invade",
];

const NEGATIVE_PHRASES_EN = [
  "blowing out",
  "data breach",
  "deal of the day",
  "fighter jet",
  "hands on review",
  "hate crime",
  "here is what they said",
  "illegal trade",
  "illegal wildlife",
  "interviewed the ceos",
  "wants to fix",
];

// ── Positive override stems ─────────────────────────────────────────

const POSITIVE_OVERRIDES_FI = [
  "läpimur", "selviyty", "pelast", "toipu", "paranne",
  "edisty", "voitt", "ennätys", "löytö", "keksint",
];

const POSITIVE_OVERRIDES_EN = [
  "breakthrough", "surviv", "rescu", "recover", "cure",
  "saved", "progress", "discover", "solution", "victory",
  "record-break",
];

// ── Learned keywords cache ──────────────────────────────────────────

interface LearnedCache {
  fi: string[];
  en: string[];
  loadedAt: number;
}

let learnedCache: LearnedCache = { fi: [], en: [], loadedAt: 0 };
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export async function refreshLearnedKeywords(): Promise<void> {
  try {
    const keywords = await prisma.learnedKeyword.findMany({
      where: { active: true },
      select: { keyword: true, language: true },
    });
    learnedCache = {
      fi: keywords.filter((k) => k.language === "fi").map((k) => k.keyword),
      en: keywords.filter((k) => k.language === "en").map((k) => k.keyword),
      loadedAt: Date.now(),
    };
  } catch {
    // DB unavailable — keep stale cache
  }
}

async function getLearnedKeywords(language: string): Promise<string[]> {
  if (Date.now() - learnedCache.loadedAt > CACHE_TTL) {
    await refreshLearnedKeywords();
  }
  return language === "fi" ? learnedCache.fi : learnedCache.en;
}

// ── Tokenizer & matcher ─────────────────────────────────────────────

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2);
}

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
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

function exactMatch(tokens: string[], words: string[]): number {
  const tokenSet = new Set(tokens);
  let hits = 0;

  for (const word of words) {
    if (tokenSet.has(word)) hits++;
  }

  return hits;
}

function phraseMatch(text: string, phrases: string[]): number {
  let hits = 0;

  for (const phrase of phrases) {
    if (text.includes(phrase)) hits++;
  }

  return hits;
}

function negativeHitsEnglish(tokens: string[], text: string, learned: string[]): number {
  return (
    exactMatch(tokens, NEGATIVE_WORDS_EN) +
    stemMatch(tokens, NEGATIVE_PREFIXES_EN, false) +
    phraseMatch(text, NEGATIVE_PHRASES_EN) +
    exactMatch(tokens, learned)
  );
}

// ── Public API ──────────────────────────────────────────────────────

const THRESHOLD = 1;

export async function classifyPositive(
  title: string,
  summary?: string | null,
  language = "en"
): Promise<boolean> {
  const text = summary
    ? `${title} ${summary.slice(0, 300)}`
    : title;

  const tokens = tokenize(text);
  const normalizedText = normalizeText(text);
  const isFinnish = language === "fi";

  const posStemsList = isFinnish ? POSITIVE_OVERRIDES_FI : POSITIVE_OVERRIDES_EN;
  const learned = await getLearnedKeywords(language);

  const negHits = isFinnish
    ? stemMatch(tokens, [...NEGATIVE_STEMS_FI, ...learned], true)
    : negativeHitsEnglish(tokens, normalizedText, learned);
  const posHits = stemMatch(tokens, posStemsList, isFinnish);

  // Positive overrides negative when both present
  if (posHits > 0 && negHits <= posHits) return true;

  return negHits < THRESHOLD;
}

/**
 * Synchronous version for the backfill script (no learned keywords).
 */
export function classifyPositiveSync(
  title: string,
  summary?: string | null,
  language = "en"
): boolean {
  const text = summary
    ? `${title} ${summary.slice(0, 300)}`
    : title;

  const tokens = tokenize(text);
  const normalizedText = normalizeText(text);
  const isFinnish = language === "fi";

  const negHits = isFinnish
    ? stemMatch(tokens, NEGATIVE_STEMS_FI, true)
    : negativeHitsEnglish(tokens, normalizedText, []);
  const posHits = stemMatch(tokens, isFinnish ? POSITIVE_OVERRIDES_FI : POSITIVE_OVERRIDES_EN, isFinnish);

  if (posHits > 0 && negHits <= posHits) return true;
  return negHits < THRESHOLD;
}

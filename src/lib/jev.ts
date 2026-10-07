/**
 * TypeSafe Jev evaluation for positive-news filtering (shadow mode).
 *
 * One request per article asks two Nouls that mirror the Ollama passes,
 * one Noul per rejection category, and an uplift Score. Verdicts are
 * derived in code from stored probabilities, so thresholds can change
 * without calling Jev again.
 */

import { noul, score, TypeSafeClient, type Questions, type RequestOptions } from "@typesafe-ai/sdk";

export const JEV_DEFAULT_MODEL = "jev-1.13.0";
/** Bump whenever a question, criterion, or the state format changes. */
export const QUESTION_SET = "v1";

const SUMMARY_CHARS = 300;

export interface JevArticle {
  title: string;
  summary?: string | null;
}

export function buildState(article: JevArticle): Record<string, string> {
  const summary = article.summary?.trim().slice(0, SUMMARY_CHARS);
  return summary ? { title: article.title, summary } : { title: article.title };
}

// ── Questions ───────────────────────────────────────────────────────

interface CategoryDef {
  label: string;
  instructions: string;
  yes: string;
  no: string;
}

/** Rejection categories, adapted from the Ollama curator rules. Order breaks ties. */
export const CATEGORIES: Record<string, CategoryDef> = {
  cat_war: {
    label: "war / military / geopolitics",
    instructions: "Is the article mainly about war, armed conflict, military activity, or geopolitical threats between countries?",
    yes: "Wars, invasions, attacks, missiles, drones, fighter jets, air-space violations, defence exercises, sanctions, territorial disputes, or threats between states or leaders",
    no: "Peace agreements reached, humanitarian help, or a topic with no military or geopolitical conflict",
  },
  cat_crime: {
    label: "crime / police / courts",
    instructions: "Is the article mainly about a crime, a police matter, or a court case?",
    yes: "Violent or other crime, arrests, police investigations, charges, trials, verdicts, sentences, or discrimination cases",
    no: "Crime is absent or only mentioned in passing",
  },
  cat_politics: {
    label: "political conflict",
    instructions: "Is the article mainly about political conflict or a dispute involving government or officials?",
    yes: "Political bickering, government disputes, administrative or legal complaints, governance criticism, constitutional or privacy-law debates, conflicts of interest, cronyism",
    no: "An agreed policy that helps people, or no political conflict",
  },
  cat_disaster: {
    label: "disaster / accident / death",
    instructions: "Is the article mainly about a disaster, an accident, or someone dying or being hurt?",
    yes: "Fires, crashes, natural disasters, accidents, water damage, deaths, injuries, animal attacks on people, or victims, even if the story mentions a silver lining",
    no: "Nobody is harmed and no disaster or accident is described",
  },
  cat_sports: {
    label: "routine or negative sports",
    instructions: "Is the article mainly routine or negative sports news rather than a sporting achievement?",
    yes: "Match results and scores, league standings, transfers, roster moves, contract extensions, coaching changes, retirements, doping, sports lawsuits or misconduct probes",
    no: "A genuine sporting triumph such as winning a title, breaking a record, or overcoming adversity, or not about sport",
  },
  cat_shopping: {
    label: "shopping / product reviews",
    instructions: "Is the article mainly about shopping, deals, or reviewing consumer products?",
    yes: "Sales, discounts, deal of the day, best-price roundups, product reviews, test drives, hands-on reviews, best-of lists",
    no: "Not about buying or rating products",
  },
  cat_filler: {
    label: "puzzles / quizzes / filler",
    instructions: "Is the article a puzzle, quiz, game, horoscope, or other filler that is not news?",
    yes: "Crosswords, quizzes, games, horoscopes, or clickbait listicles with no real substance",
    no: "A real news story",
  },
  cat_business_puff: {
    label: "business clickbait / CEO puff",
    instructions: "Is the article business clickbait, a puff piece about executives, or a routine corporate deal?",
    yes: "Entrepreneurship clickbait such as 'dare to start' or 'why companies fail', CEO interview roundups, what-leaders-said pieces, generic deals or contracts between companies",
    no: "Business news that directly creates jobs, clean energy, or accessibility for people, or not about business",
  },
  cat_costs: {
    label: "rising costs / economy worries",
    instructions: "Is the article mainly about rising prices, inflation, or money worries?",
    yes: "Price increases, inflation, cost of living, affordability complaints, insurance disputes, debt or payment defaults, economic downturns",
    no: "Prices and the economy are not a concern in the story",
  },
  cat_layoffs: {
    label: "layoffs / labour disputes",
    instructions: "Is the article mainly about job losses or a labour dispute?",
    yes: "Layoffs, firings, job cuts, restructuring, change negotiations (yt-neuvottelut), strikes, unresolved union conflicts",
    no: "Jobs are created or saved, a dispute was resolved, or work is not the topic",
  },
  cat_health_scare: {
    label: "health scare",
    instructions: "Is the article mainly about a disease outbreak, a worrying health trend, or someone falling ill?",
    yes: "Disease outbreaks, anti-vaccination trends, declining health statistics, infections, or illness of politicians or public figures",
    no: "Health breakthroughs, practical wellness advice, or not about health",
  },
  cat_breach: {
    label: "data breach / investigation",
    instructions: "Is the article mainly about a data breach, a leak, or an investigation into wrongdoing?",
    yes: "Data breaches, leaked personal data, hacking, misconduct probes, or investigations",
    no: "No breach, leak, or investigation",
  },
  cat_env_loss: {
    label: "harm to nature or animals",
    instructions: "Is the article mainly about harm to nature or animals?",
    yes: "Environmental loss or alarm, pollution, species decline, poaching, illegal wildlife trade, hunting or culling of wild animals such as wolf hunting",
    no: "Nature recovering, conservation success, rewilding, or not about nature",
  },
  cat_marketing: {
    label: "marketing as news",
    instructions: "Is the article marketing dressed up as news?",
    yes: "Product launches, brand collaborations, celebrity collections, promotional copy, or 'your X is ugly and this company wants to fix it'",
    no: "Independent reporting that is not written to sell a product",
  },
  cat_gossip: {
    label: "gossip / scandal / rage-bait",
    instructions: "Is the article mainly celebrity gossip, a scandal, or rage-bait?",
    yes: "Celebrity gossip, scandals, or outrage-provoking or alarmist framing",
    no: "No gossip, scandal, or outrage",
  },
  cat_opinion: {
    label: "opinion on societal problems",
    instructions: "Is the article an opinion piece, column, or editorial about a problem in society?",
    yes: "Opinion columns, editorials, commentary, or reader letters arguing about societal problems",
    no: "News reporting, or an opinion piece celebrating something good",
  },
  cat_failure: {
    label: "failure / cancellation",
    instructions: "Is the article mainly about something failing, going wrong, or being cancelled?",
    yes: "Errors, corrections, outages, failures, cancelled events, dangerous roads, infrastructure failures, platform spam or abuse, things getting worse",
    no: "Things working or improving",
  },
};

export const QUESTIONS: Questions = {
  positive: noul(
    "Is this article positive news that would leave a reader feeling hopeful, inspired, or calm?",
    {
      true: "Solutions journalism, scientific or medical breakthroughs, kindness or heroism, environmental recovery, genuine cultural or sporting achievements, community successes, practical wellness advice",
      false: "Conflict, crime, disaster, political conflict, scandal, alarm, routine sports or business news, shopping, filler, or anything distressing even with a silver lining",
    },
  ),
  uplifting: noul(
    "Is this article genuinely uplifting rather than marketing, routine business news, or a puff piece?",
    {
      true: "Real human achievement, community success, scientific progress, help for people, environmental wins, acts of kindness, or business news that directly creates jobs, clean energy, or accessibility",
      false: "Product launches, brand collaborations, corporate deals, thought-leader puff pieces, or stories about problems, failures, or things getting worse",
    },
  ),
  uplift: score("How uplifting would a typical reader find this article?", [
    "Distressing or negative",
    "Neutral or routine",
    "Mildly positive",
    "Clearly uplifting and inspiring",
  ]),
  ...Object.fromEntries(
    Object.entries(CATEGORIES).map(([key, c]) => [key, noul(c.instructions, { true: c.yes, false: c.no })]),
  ),
};

// ── Answers → summary ───────────────────────────────────────────────

export interface JevSummary {
  positiveP: number;
  upliftingP: number;
  upliftScore: number;
  topCategory: string;
  topCategoryP: number;
}

type RawAnswer = { type?: unknown; noul?: unknown; score?: unknown };

const RANGES = { noul: [0, 1], score: [0, 3] } as const;

function numberField(answers: Record<string, unknown>, key: string, type: "noul" | "score"): number {
  const answer = answers[key] as RawAnswer | undefined;
  const value = answer?.[type];
  if (!answer || answer.type !== type || typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Jev answer "${key}" is missing or not a valid ${type}`);
  }
  const [min, max] = RANGES[type];
  if (value < min || value > max) {
    throw new Error(`Jev answer "${key}" ${type} ${value} is outside [${min}, ${max}]`);
  }
  return value;
}

export function summarizeAnswers(answers: Record<string, unknown>): JevSummary {
  let topCategory = "";
  let topCategoryP = -1;
  for (const key of Object.keys(CATEGORIES)) {
    const p = numberField(answers, key, "noul");
    if (p > topCategoryP) {
      topCategory = key;
      topCategoryP = p;
    }
  }

  return {
    positiveP: numberField(answers, "positive", "noul"),
    upliftingP: numberField(answers, "uplifting", "noul"),
    upliftScore: numberField(answers, "uplift", "score"),
    topCategory,
    topCategoryP,
  };
}

// ── Verdict ─────────────────────────────────────────────────────────

export interface JevThresholds {
  positiveMin: number;
  upliftingMin: number;
  categoryMax: number;
}

export const DEFAULT_THRESHOLDS: JevThresholds = {
  positiveMin: 0.5,
  upliftingMin: 0.5,
  categoryMax: 0.6,
};

export interface JevVerdict {
  keep: boolean;
  reason: string | null;
  topCategory: string | null;
}

export function deriveVerdict(
  s: Pick<JevSummary, "positiveP" | "upliftingP" | "topCategory" | "topCategoryP">,
  t: JevThresholds = DEFAULT_THRESHOLDS,
): JevVerdict {
  if (s.topCategoryP > t.categoryMax) {
    const label = CATEGORIES[s.topCategory]?.label ?? s.topCategory;
    return { keep: false, reason: `jev: ${label}`, topCategory: s.topCategory };
  }
  if (s.positiveP < t.positiveMin) return { keep: false, reason: "jev: not positive", topCategory: null };
  if (s.upliftingP < t.upliftingMin) return { keep: false, reason: "jev: not uplifting", topCategory: null };
  return { keep: true, reason: null, topCategory: null };
}

// ── API ─────────────────────────────────────────────────────────────

export interface JevEvaluationData extends JevSummary {
  model: string;
  answers: Record<string, unknown>;
  inputTokens: number;
  latencyMs: number;
}

let client: TypeSafeClient | null = null;

export function isJevConfigured(): boolean {
  return Boolean(process.env.TYPESAFE_API_KEY);
}

function getClient(): TypeSafeClient {
  // The SDK reads TYPESAFE_API_KEY and TYPESAFE_BASE_URL from the environment.
  client ??= new TypeSafeClient({
    defaultModel: process.env.TYPESAFE_DEFAULT_MODEL ?? JEV_DEFAULT_MODEL,
    timeout: 30_000,
  });
  return client;
}

export async function evaluateArticle(article: JevArticle, options?: RequestOptions): Promise<JevEvaluationData> {
  const started = Date.now();
  const res = await getClient().systemOne({ state: buildState(article), questions: QUESTIONS }, options);
  const answers = res.answers as Record<string, unknown>;

  return {
    ...summarizeAnswers(answers),
    model: res.model,
    answers,
    inputTokens: res.usage.input_tokens,
    latencyMs: Date.now() - started,
  };
}

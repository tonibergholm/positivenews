/**
 * Two-tier LLM curation via local Ollama (gemma3:4b).
 *
 * Pass 1: Is this article positive news?
 * Pass 2: For positives — is it genuinely uplifting or just marketing fluff?
 */

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";
const MODEL = process.env.OLLAMA_MODEL ?? "gemma3:4b";

interface ArticleInput {
  id: string;
  title: string;
  summary?: string | null;
  language: string;
}

interface Pass1Result {
  id: string;
  positive: boolean;
  reason: string;
}

interface Pass2Result {
  id: string;
  keep: boolean;
  reason: string;
}

export interface CurationResult {
  id: string;
  isPositive: boolean;
  reason: string;
  pass: 1 | 2;
}

// ── Prompts ──────────────────────────────────────────────────────────

function buildPass1Prompt(articles: ArticleInput[]): string {
  const items = articles
    .map((a, i) => {
      const lang = a.language === "fi" ? "FI" : "EN";
      const summary = a.summary ? ` — ${a.summary.slice(0, 150)}` : "";
      return `${i + 1}. id:${a.id} [${lang}] "${a.title}"${summary}`;
    })
    .join("\n");

  return `You are a STRICT Positive News curator. Your job is to ONLY let through news that makes a reader feel inspired, hopeful, or calm. When in doubt, REJECT.

INCLUDE (positive = true) — ONLY these:
- Solutions journalism: people or organizations actively solving real problems
- Scientific breakthroughs: medicine, space, green energy, technology that benefits humanity
- Acts of kindness: heroism, community support, altruism
- Environmental recovery: wildlife rebounding, reforestation, climate goals met
- Cultural/sports triumphs: uplifting ACHIEVEMENTS (winning, records, overcoming adversity) — NOT roster moves, transfers, or retirements
- Finnish specifics: "sisu" stories, community successes, innovations, nature conservation
- Practical wellness: health tips, well-being advice that helps people

EXCLUDE (positive = false) — be aggressive here:
- ANY mention of war, military threats, geopolitics, territorial disputes, sanctions, or drones/missiles
- ANY mention of Trump, Putin, or other politicians in conflict/threat context
- ANY military activity: fighter jets, air space violations, defense exercises
- Violent crime, political bickering, government disputes, legal complaints
- Rage-bait, scandals, celebrity gossip
- Alarmist headlines (even if story is neutral)
- Tragic accidents, water damage, insurance disputes (even with a silver lining)
- Opinion pieces, columns, editorials about societal problems
- Error reports, corrections, failures
- Health ALARM stories: declining vaccination rates, disease outbreaks, pandemic fears
- Sports roster moves, transfers, coaching changes, retirements, lawsuits (NOT triumphs)
- Sports scores, doping, league standings, match results ("crushed", "thrashed")
- Rising costs, price complaints, inflation stories ("X now costs more", "kallistui")
- Crossword puzzles, quizzes, games, entertainment filler — NOT news
- Administrative/bureaucratic disputes (e.g. regions filing complaints to chancellor)
- Generic product news, consumer reviews, Amazon sales, shopping deals
- Product/shopping sales and promotions ("spring sale", "blowing out", "deal of the day")
- Cancelled visits, illness of politicians or public figures
- Entrepreneurship clickbait ("why you should start a business", "how companies fail")
- Wildlife CRIME or illegal trade stories (poaching, smuggling) — these are negative, not environmental wins

Return ONLY this JSON: {"results": [{"id": "...", "positive": true/false, "reason": "brief reason"}]}

Articles:
${items}`;
}

function buildPass2Prompt(articles: ArticleInput[]): string {
  const items = articles
    .map((a, i) => {
      const summary = a.summary ? ` — ${a.summary.slice(0, 150)}` : "";
      return `${i + 1}. id:${a.id} "${a.title}"${summary}`;
    })
    .join("\n");

  return `You are the FINAL quality gate for a Positive News feed. These articles already passed an initial check. Apply the STRICTEST filter. When in doubt, REJECT.

Ask yourself: "Would this make someone smile, feel hopeful, or learn something good?" If not, reject it.

KEEP ONLY articles that are:
- Genuinely uplifting: real human achievement, community success, scientific progress
- Helpful to people: practical wellness, health breakthroughs, solutions to real problems
- Something to be proud of: innovation that helps humanity, environmental wins, acts of kindness
- Good business news ONLY IF it directly creates jobs, clean energy, or accessibility for people

REJECT everything else, including:
- Marketing disguised as news (product launches, brand collaborations, celebrity collections)
- Generic business deals, contracts, or corporate transactions
- Business thought-leader puff pieces ("insights from CEO X", "future of business")
- Entrepreneurship clickbait ("dare to start", "how companies fail/succeed in X")
- CEO interview roundups, "here's what they said" puff pieces
- Layoffs, firings, job cuts, restructuring
- Labor disputes, strikes, union conflicts without resolution
- Court verdicts, criminal convictions, sentencing, discrimination lawsuits
- Police investigations, data breaches, leaked personal data
- Animal attacks, bites, maulings
- Inflation reports, economic downturns, cost-of-living alarm
- Constitutional/privacy law debates, governance criticism
- Sports misconduct investigations, doping probes
- Dangerous roads, safety hazards, infrastructure failures
- Tech platform problems (spam, abuse, outages)
- Conflict of interest stories, cronyism
- Environmental LOSS, alarm, or wildlife CRIME stories (illegal trade, poaching)
- Stories about errors, failures, corrections, or things getting worse
- Consumer product reviews, upgrades, or "best of" roundups
- Shopping sales and promotions ("spring sale", Amazon deals, "best price")
- Clickbait listicles with no real substance
- Crossword puzzles, quizzes, games, horoscopes — not news
- Sports personnel changes, lawsuits, match results — only genuine TRIUMPHS count
- Rising costs, price increases, affordability complaints, insurance disputes
- Political threats, sanctions, military activity, drone incidents
- Administrative disputes, legal complaints, bureaucratic problems
- Health scares: anti-vaccination trends, disease outbreaks, declining health stats
- Cancelled events, illness/health of politicians
- Layoffs, firings, job cuts, restructuring — people losing their jobs is not positive
- Labor disputes, strikes without resolution
- Court verdicts, criminal convictions, sentencing, discrimination cases
- Police investigations, data breaches, security incidents
- Animal attacks on people
- Inflation, economic alarm, cost-of-living stories
- Constitutional/privacy debates, governance criticism
- Sports investigations, misconduct probes
- Infrastructure dangers, safety hazards
- Tech platform spam, abuse, outages
- Conflict of interest, cronyism, appointments of insiders
- "Your X is ugly / broken, this company wants to fix it" — product marketing
- CEO interview compilations, "what leaders said" roundups
- Filler content that is not actually news (puzzles, opinion polls, Q&A columns)

Return ONLY this JSON: {"results": [{"id": "...", "keep": true/false, "reason": "brief reason"}]}

Articles:
${items}`;
}

// ── Ollama API ───────────────────────────────────────────────────────

async function callOllama<T>(prompt: string): Promise<T | null> {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        prompt,
        format: "json",
        stream: false,
        options: { temperature: 0.1, num_predict: 2048 },
      }),
    });

    if (!res.ok) {
      console.error(`[llm-curator] Ollama HTTP ${res.status}`);
      return null;
    }

    const data = await res.json();
    const parsed = JSON.parse(data.response);
    return parsed as T;
  } catch (err) {
    console.error(`[llm-curator] Ollama error:`, err);
    return null;
  }
}

// ── Public API ───────────────────────────────────────────────────────

const BATCH_SIZE = 10;

export async function curateArticles(
  articles: ArticleInput[]
): Promise<CurationResult[]> {
  if (articles.length === 0) return [];

  const results: CurationResult[] = [];

  // Process in batches to avoid overwhelming the model
  for (let i = 0; i < articles.length; i += BATCH_SIZE) {
    const batch = articles.slice(i, i + BATCH_SIZE);

    // ── Pass 1: positive/negative classification ──
    console.log(
      `[llm-curator] Pass 1: classifying batch ${i / BATCH_SIZE + 1} (${batch.length} articles)…`
    );

    const pass1 = await callOllama<{ results: Pass1Result[] }>(
      buildPass1Prompt(batch)
    );

    if (!pass1?.results) {
      // LLM failed — mark all as positive (fail-open)
      console.warn(`[llm-curator] Pass 1 failed, keeping all articles in batch`);
      for (const a of batch) {
        results.push({ id: a.id, isPositive: true, reason: "LLM unavailable", pass: 1 });
      }
      continue;
    }

    // Map pass1 results by id
    const pass1Map = new Map(pass1.results.map((r) => [r.id, r]));

    // Collect rejected and accepted
    const positiveArticles: ArticleInput[] = [];

    for (const a of batch) {
      const r = pass1Map.get(a.id);
      if (!r || r.positive) {
        positiveArticles.push(a);
      } else {
        results.push({ id: a.id, isPositive: false, reason: r.reason, pass: 1 });
      }
    }

    if (positiveArticles.length === 0) continue;

    // ── Pass 2: strict quality filter ──
    console.log(
      `[llm-curator] Pass 2: quality-checking ${positiveArticles.length} positives…`
    );

    const pass2 = await callOllama<{ results: Pass2Result[] }>(
      buildPass2Prompt(positiveArticles)
    );

    if (!pass2?.results) {
      // LLM failed — keep all (fail-open)
      console.warn(`[llm-curator] Pass 2 failed, keeping all positives`);
      for (const a of positiveArticles) {
        results.push({ id: a.id, isPositive: true, reason: "LLM pass 2 unavailable", pass: 2 });
      }
      continue;
    }

    const pass2Map = new Map(pass2.results.map((r) => [r.id, r]));

    for (const a of positiveArticles) {
      const r = pass2Map.get(a.id);
      if (!r || r.keep) {
        results.push({ id: a.id, isPositive: true, reason: r?.reason ?? "passed both checks", pass: 2 });
      } else {
        results.push({ id: a.id, isPositive: false, reason: r.reason, pass: 2 });
      }
    }
  }

  return results;
}

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

  return `You are a Positive News curator specializing in constructive journalism. Analyze these articles and return JSON.

INCLUDE (positive = true):
- Solutions journalism: people or organizations solving real problems
- Scientific breakthroughs: medicine, space, green energy, technology that benefits humanity
- Acts of kindness: heroism, community support, altruism
- Environmental recovery: wildlife rebounding, reforestation, climate goals met
- Cultural/sports triumphs: uplifting achievements focusing on the human spirit
- Finnish specifics: "sisu" stories, community successes, innovations, nature conservation
- Practical wellness: health tips, well-being advice

EXCLUDE (positive = false):
- War, violent crime, political bickering
- Rage-bait, scandals, celebrity gossip
- Alarmist headlines (even if story is neutral)
- Tragic accidents (even with a silver lining)
- Toxic positivity that dismisses real suffering
- Opinion pieces and columns about societal problems
- Error reports, corrections, failures
- Sports scores, doping, league standings

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

  return `You are a strict Positive News quality filter. These articles already passed an initial positivity check. Apply a STRICTER filter.

KEEP articles that are:
- Genuinely uplifting: real human achievement, community success, scientific progress
- Helpful to people: practical wellness, health breakthroughs, solutions to real problems
- Something to be proud of: innovation that helps humanity, environmental wins, acts of kindness
- Good business news IF it directly benefits people (jobs, clean energy, accessibility)

REJECT articles that are:
- Marketing disguised as news (product launches, brand collaborations, celebrity collections)
- Generic business deals with no clear human benefit
- Business thought-leader puff pieces ("insights from CEO X")
- Environmental LOSS stories (losing ecosystems is NOT positive)
- Stories about errors, failures, or corrections
- Consumer product reviews or upgrades
- Clickbait listicles with no real substance
- Generic "tips" articles that are just content filler

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

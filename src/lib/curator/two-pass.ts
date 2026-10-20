import { buildPass1Prompt, buildPass2Prompt } from "./prompts";
import type { ArticleInput, CurationResult } from "./types";

function verdicts(value: unknown, field: string): Map<string, { keep: boolean; reason: string }> {
  if (!value || typeof value !== "object" || !("results" in value) || !Array.isArray(value.results)) throw new Error("Invalid curator results");
  const results = new Map<string, { keep: boolean; reason: string }>();
  const duplicates = new Set<string>();
  for (const row of value.results) {
    if (!row || typeof row.id !== "string") continue;
    if (results.has(row.id)) duplicates.add(row.id);
    if (typeof row[field] === "boolean" && typeof row.reason === "string") results.set(row.id, { keep: row[field], reason: row.reason });
  }
  for (const id of duplicates) results.delete(id);
  return results;
}

export async function twoPass(
  articles: ArticleInput[],
  call: (prompt: string) => Promise<unknown>,
  source: "openai" | "ollama",
  model: string,
  deadline = Infinity,
): Promise<CurationResult[]> {
  const results: CurationResult[] = [];
  for (let i = 0; i < articles.length; i += 10) {
    if (Date.now() >= deadline) break;
    const batch = articles.slice(i, i + 10);
    try {
      const first = verdicts(await call(buildPass1Prompt(batch)), "positive");
      const positives: ArticleInput[] = [];
      for (const article of batch) {
        const r = first.get(article.id);
        if (!r) continue;
        if (r.keep) positives.push(article);
        else results.push({ id: article.id, isPositive: false, reason: r.reason, pass: 1, outcome: "judged_reject", source, model });
      }
      if (!positives.length) continue;
      if (Date.now() >= deadline) break;
      const second = verdicts(await call(buildPass2Prompt(positives)), "keep");
      for (const article of positives) {
        const r = second.get(article.id);
        if (r) results.push({ id: article.id, isPositive: r.keep, reason: r.reason, pass: 2, outcome: r.keep ? "judged_keep" : "judged_reject", source, model });
      }
    } catch (err) {
      console.error(`[curator] ${source} batch failed; undecided articles need fallback or retry`, err);
    }
  }
  return results;
}

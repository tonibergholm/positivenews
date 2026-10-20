import { curatorConfig, type Provider } from "./config";
import { curateJev } from "./jev";
import { curateOpenAI } from "./openai";
import { curateOllama } from "./ollama";
import type { ArticleInput, CurationResult } from "./types";

async function run(provider: Provider, articles: ArticleInput[]): Promise<CurationResult[]> {
  if (!articles.length || provider === "none") return [];
  try {
    if (provider === "jev") return await curateJev(articles);
    if (provider === "openai") return await curateOpenAI(articles);
    return await curateOllama(articles);
  } catch (err) {
    console.error(`[curator] ${provider} failed; trying fallback or leaving articles uncurated`, err);
    return [];
  }
}

export async function curateArticles(articles: ArticleInput[]): Promise<CurationResult[]> {
  const { primary, fallback } = curatorConfig();
  if (primary === "none") return [];
  const results = await run(primary, articles);
  const decided = new Set(results.map((r) => r.id));
  const pending = articles.filter((a) => !decided.has(a.id));
  if (pending.length && fallback !== "none" && fallback !== primary) results.push(...await run(fallback, pending));
  const skipped = articles.length - results.length;
  if (skipped) console.warn(`[curator] Skipping ${skipped} articles without a decision; curatedAt stays null`);
  return results;
}

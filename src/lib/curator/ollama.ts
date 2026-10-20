import { budgetMs, requestTimeoutMs } from "./config";
import { twoPass } from "./two-pass";
import type { ArticleInput } from "./types";

export async function curateOllama(articles: ArticleInput[], deadline = Date.now() + budgetMs()) {
  const base = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
  const model = process.env.OLLAMA_MODEL?.trim() || "gemma3:4b";
  return twoPass(articles, async (prompt) => {
    const response = await fetch(`${base.replace(/\/+$/, "")}/api/generate`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt, format: "json", stream: false, options: { temperature: 0.1, num_predict: 2048 } }),
      signal: AbortSignal.timeout(requestTimeoutMs(deadline)),
    });
    if (!response.ok) throw new Error(`Ollama HTTP ${response.status}`);
    const data = await response.json();
    return JSON.parse(data.response);
  }, "ollama", model, deadline);
}

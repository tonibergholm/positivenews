import { timeoutMs } from "./config";
import { twoPass } from "./two-pass";
import type { ArticleInput } from "./types";

export async function curateOllama(articles: ArticleInput[]) {
  const base = process.env.OLLAMA_URL;
  if (!base) throw new Error("OLLAMA_URL is required");
  const model = process.env.OLLAMA_MODEL ?? "llama3.2:1b";
  return twoPass(articles, async (prompt) => {
    const response = await fetch(`${base.replace(/\/+$/, "")}/api/generate`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt, format: "json", stream: false, options: { temperature: 0.1, num_predict: 2048 } }),
      signal: AbortSignal.timeout(timeoutMs()),
    });
    if (!response.ok) throw new Error(`Ollama HTTP ${response.status}`);
    const data = await response.json();
    return JSON.parse(data.response);
  }, "ollama", model);
}

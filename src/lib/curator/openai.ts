import { timeoutMs } from "./config";
import { twoPass } from "./two-pass";
import type { ArticleInput } from "./types";

export async function curateOpenAI(articles: ArticleInput[]) {
  const key = process.env.CURATOR_OPENAI_API_KEY;
  if (!key) throw new Error("CURATOR_OPENAI_API_KEY is required");
  const base = (process.env.CURATOR_OPENAI_BASE_URL ?? "https://api.mistral.ai/v1").replace(/\/+$/, "");
  const model = process.env.CURATOR_OPENAI_MODEL ?? "ministral-8b-2512";
  return twoPass(articles, async (prompt) => {
    const response = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], response_format: { type: "json_object" }, temperature: 0.1 }),
      signal: AbortSignal.timeout(timeoutMs()),
    });
    if (!response.ok) throw new Error(`OpenAI-compatible HTTP ${response.status}`);
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new Error("Missing completion content");
    return JSON.parse(content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
  }, "openai", model);
}

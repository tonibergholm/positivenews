const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "qwen2.5:0.5b";

const PROMPT_TEMPLATE = (text: string) =>
  `You are a content filter for a positive news aggregator. Your job is to decide if a news article is uplifting, constructive, or beneficial — meaning it reports progress, solutions, achievements, breakthroughs, or good outcomes for people or the planet.

Reject articles that are primarily about: violence, crime, accidents, disasters, wars, political conflict, economic crises, fear, or suffering.

Article: "${text}"

Reply with only YES or NO.`;

export async function classifyPositive(
  title: string,
  summary?: string | null
): Promise<boolean> {
  const text = summary
    ? `${title} — ${summary.slice(0, 250)}`
    : title;

  try {
    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt: PROMPT_TEMPLATE(text),
        stream: false,
        options: { temperature: 0.0, num_predict: 5 },
      }),
      signal: AbortSignal.timeout(20_000),
    });

    if (!res.ok) return true;
    const data = (await res.json()) as { response?: string };
    const answer = (data.response ?? "").trim().toUpperCase();
    return !answer.startsWith("NO");
  } catch {
    // Ollama unavailable — accept article to avoid data loss
    return true;
  }
}

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "llama3.2:1b";

function buildPrompt(text: string, language: string): string {
  const langNote =
    language !== "en"
      ? `Note: The article may be in a language other than English (language code: ${language}). Evaluate based on the topic and context even if you don't fully understand every word.\n\n`
      : "";

  return `You are a content filter for a positive news aggregator. Decide if a news article is uplifting, constructive, or beneficial — reporting progress, solutions, achievements, breakthroughs, or good outcomes for people or the planet.

${langNote}Reject articles that are primarily about: violence, crime, accidents, disasters, wars, political conflict, economic crises, corruption, fear, or suffering.

Article: "${text}"

Reply with only YES or NO.`;
}

export async function classifyPositive(
  title: string,
  summary?: string | null,
  language = "en"
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
        prompt: buildPrompt(text, language),
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

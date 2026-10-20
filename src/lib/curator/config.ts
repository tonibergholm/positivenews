export type Provider = "jev" | "openai" | "ollama" | "none";

export function curatorConfig(): { primary: Provider; fallback: Exclude<Provider, "jev"> } {
  const primary = process.env.CURATOR_PROVIDER ?? (process.env.TYPESAFE_API_KEY ? "jev" : process.env.OLLAMA_URL ? "ollama" : "none");
  const fallback = process.env.CURATOR_FALLBACK ?? "none";
  if (!["jev", "openai", "ollama", "none"].includes(primary)) throw new Error("Invalid CURATOR_PROVIDER");
  if (!["openai", "ollama", "none"].includes(fallback)) throw new Error("Invalid CURATOR_FALLBACK");
  return { primary: primary as Provider, fallback: fallback as Exclude<Provider, "jev"> };
}

export function timeoutMs(): number {
  const value = Number(process.env.CURATOR_TIMEOUT_MS ?? 30000);
  if (!Number.isFinite(value) || value <= 0) throw new Error("Invalid CURATOR_TIMEOUT_MS");
  return value;
}

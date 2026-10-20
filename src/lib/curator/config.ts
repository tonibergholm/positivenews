export type Provider = "jev" | "openai" | "ollama" | "none";

export function curatorConfig(): { primary: Provider; fallback: Exclude<Provider, "jev"> } {
  const primary = process.env.CURATOR_PROVIDER || "ollama";
  const fallback = process.env.CURATOR_FALLBACK || "none";
  if (!["jev", "openai", "ollama", "none"].includes(primary)) throw new Error("Invalid CURATOR_PROVIDER");
  if (!["openai", "ollama", "none"].includes(fallback)) throw new Error("Invalid CURATOR_FALLBACK");
  return { primary: primary as Provider, fallback: fallback as Exclude<Provider, "jev"> };
}

function durationMs(name: string, defaultValue: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return defaultValue;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid ${name}`);
  return value;
}

export function timeoutMs(): number {
  return durationMs("CURATOR_TIMEOUT_MS", 30000);
}

export function budgetMs(): number {
  return durationMs("CURATOR_BUDGET_MS", 120000);
}

export function requestTimeoutMs(deadline: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("Curator budget exhausted");
  return Math.min(timeoutMs(), remaining);
}

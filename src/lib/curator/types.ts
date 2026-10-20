export interface ArticleInput {
  id: string;
  title: string;
  summary?: string | null;
  language: string;
}

export interface CurationResult {
  id: string;
  isPositive: boolean;
  reason: string;
  pass: 1 | 2;
  outcome: "judged_keep" | "judged_reject";
  source: "jev" | "openai" | "ollama";
  model: string;
}

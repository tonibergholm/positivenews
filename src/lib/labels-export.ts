import { buildState } from "./jev";
import { resolveLabel, type LabelEventLike } from "./labels";

export interface ExportArticle {
  id: string;
  title: string;
  summary: string | null;
  language: string;
  createdAt: Date;
  events: LabelEventLike[];
  jev: { model: string; questionSet: string; answers: unknown } | null;
}

export interface ExportRow {
  articleId: string;
  state: Record<string, string>;
  language: string;
  createdAt: string;
  label: "keep" | "reject";
  category: string | null;
  tier: string;
  weight: number;
  bucket: string | null;
  split: "train" | "test";
  jev: ExportArticle["jev"];
}

export function toExportRow(a: ExportArticle): ExportRow | null {
  const label = resolveLabel(a.id, a.events);
  if (!label) return null;
  return {
    articleId: a.id,
    state: buildState({ title: a.title, summary: a.summary }),
    language: a.language,
    createdAt: a.createdAt.toISOString(),
    label: label.label,
    category: label.category,
    tier: label.tier,
    weight: label.weight,
    bucket: label.bucket,
    split: label.split,
    jev: a.jev,
  };
}

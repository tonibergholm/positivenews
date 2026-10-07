// app/admin/jev/page.tsx
import { DEFAULT_THRESHOLDS, QUESTION_SET } from "@/src/lib/jev";
import { buildReport } from "@/src/lib/jev-report";
import { loadReportRows } from "@/src/lib/jev-report-data";
import { loadScoreRows } from "@/src/lib/scoreboard-data";
import { scoreSources } from "@/src/lib/scoreboard";
import { JevReportView, type JevFilters } from "./JevReportView";

export const dynamic = "force-dynamic";

const DIRECTIONS = ["jev_keeps", "jev_rejects"] as const;
const LANGUAGES = ["fi", "en"] as const;
const GROUPS = ["keyword", "ollama_reject", "ollama_keep"] as const;

type SearchParams = Record<string, string | string[] | undefined>;

function pick<T extends string>(value: string | string[] | undefined, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

export default async function JevPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const filters: JevFilters = {
    direction: pick(params.direction, DIRECTIONS),
    lang: pick(params.lang, LANGUAGES),
    group: pick(params.group, GROUPS),
  };

  const rows = await loadReportRows();
  const report = buildReport(rows, DEFAULT_THRESHOLDS);
  const { rows: scoreRows, laya } = await loadScoreRows();
  const scores = scoreSources(scoreRows);

  return (
    <div className="max-w-6xl">
      <div className="mb-8">
        <h1 className="text-xl font-semibold text-foreground mb-1">Jev shadow comparison</h1>
        <p className="text-sm text-muted-foreground">
          TypeSafe Jev evaluated next to the Ollama curator. Jev does not affect the live feed.
        </p>
      </div>

      {report.evaluated === 0 ? (
        <p className="text-sm text-muted-foreground">
          No Jev evaluations yet. Set <code className="font-mono">TYPESAFE_API_KEY</code> and run{" "}
          <code className="font-mono">pnpm jev:backfill</code>, or wait for the next pipeline run.
        </p>
      ) : (
        <JevReportView
          report={report}
          scores={scores}
          laya={laya}
          filters={filters}
          questionSet={QUESTION_SET}
          thresholds={DEFAULT_THRESHOLDS}
        />
      )}
    </div>
  );
}

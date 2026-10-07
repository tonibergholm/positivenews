// app/admin/jev/JevReportView.tsx
import Link from "next/link";
import { CATEGORIES, type JevThresholds } from "@/src/lib/jev";
import type { ScoreTable, Slice } from "@/src/lib/scoreboard";
import type { Agreement, Disagreement, JevReport } from "@/src/lib/jev-report";

export interface JevFilters {
  direction?: "jev_keeps" | "jev_rejects";
  lang?: "fi" | "en";
  group?: "keyword" | "ollama_reject" | "ollama_keep";
}

const TABLE_ROWS = 300;

const GROUP_LABELS: Record<Disagreement["group"], string> = {
  keyword: "Keyword reject",
  ollama_reject: "Ollama reject",
  ollama_keep: "Ollama keep",
};

const pct = (rate: number | null) => (rate === null ? "—" : `${Math.round(rate * 100)}%`);
const prob = (p: number) => p.toFixed(2);

function StatTile({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-2xl font-semibold text-foreground tabular-nums mt-1">{value}</div>
      <div className="text-xs text-muted-foreground tabular-nums mt-0.5">{detail}</div>
    </div>
  );
}

function Matrix({ a }: { a: Agreement }) {
  const cell = "px-4 py-2.5 text-right tabular-nums";
  return (
    <div className="rounded-lg border border-border overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-secondary/60 border-b border-border text-xs text-muted-foreground">
            <th className="text-left px-4 py-2.5 font-medium">Ollama ↓ / Jev →</th>
            <th className="text-right px-4 py-2.5 font-medium">Keep</th>
            <th className="text-right px-4 py-2.5 font-medium">Reject</th>
          </tr>
        </thead>
        <tbody className="text-xs">
          <tr className="border-b border-border/60">
            <td className="px-4 py-2.5 text-muted-foreground">Keep</td>
            <td className={cell}>{a.keepKeep}</td>
            <td className={cell}>{a.keepReject}</td>
          </tr>
          <tr>
            <td className="px-4 py-2.5 text-muted-foreground">Reject</td>
            <td className={cell}>{a.rejectKeep}</td>
            <td className={cell}>{a.rejectReject}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

const SLICE_KEYS: Slice[] = ["all", "fi", "en"];

function Triple({ cells }: { cells: string[] }) {
  return (
    <td className="px-4 py-2.5 text-right tabular-nums whitespace-nowrap">{cells.join(" / ")}</td>
  );
}

function ScoreTableView({ title, table }: { title: string; table: ScoreTable }) {
  const rows: { name: string; n: string[]; agreement: string[]; precision: string[]; hidden: string[] }[] = [
    {
      name: "Jev",
      n: SLICE_KEYS.map((s) => String(table.jev[s].n)),
      agreement: SLICE_KEYS.map((s) => pct(table.jev[s].agreement)),
      precision: SLICE_KEYS.map((s) => pct(table.jev[s].rejectPrecision)),
      hidden: SLICE_KEYS.map((s) => String(table.jev[s].wronglyHidden)),
    },
    {
      name: "Ollama",
      n: SLICE_KEYS.map((s) => String(table.ollama[s].n)),
      agreement: SLICE_KEYS.map((s) => pct(table.ollama[s].agreement)),
      precision: SLICE_KEYS.map((s) => pct(table.ollama[s].rejectPrecision)),
      hidden: SLICE_KEYS.map((s) => String(table.ollama[s].wronglyHidden)),
    },
    {
      name: "Keyword filter",
      n: SLICE_KEYS.map((s) => String(table.keyword[s].n)),
      agreement: SLICE_KEYS.map(() => "—"),
      precision: SLICE_KEYS.map((s) => pct(table.keyword[s].rejectPrecision)),
      hidden: SLICE_KEYS.map(() => "—"),
    },
    {
      name: "Reader flags",
      n: SLICE_KEYS.map((s) => String(table.flags[s].n)),
      agreement: SLICE_KEYS.map(() => "—"),
      precision: SLICE_KEYS.map((s) => pct(table.flags[s].rejectPrecision)),
      hidden: SLICE_KEYS.map(() => "—"),
    },
  ];
  return (
    <div>
      <h3 className="text-sm font-medium text-foreground mb-2">{title}</h3>
      <div className="rounded-lg border border-border overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-secondary/60 border-b border-border text-xs text-muted-foreground">
              <th className="text-left px-4 py-2.5 font-medium">Source</th>
              <th className="text-right px-4 py-2.5 font-medium">n (all / FI / EN)</th>
              <th className="text-right px-4 py-2.5 font-medium">Agreement</th>
              <th className="text-right px-4 py-2.5 font-medium">Reject precision</th>
              <th className="text-right px-4 py-2.5 font-medium">Wrongly hidden</th>
            </tr>
          </thead>
          <tbody className="text-xs">
            {rows.map((r) => (
              <tr key={r.name} className="border-b border-border/60 last:border-0">
                <td className="px-4 py-2.5 text-muted-foreground">{r.name}</td>
                <Triple cells={r.n} />
                <Triple cells={r.agreement} />
                <Triple cells={r.precision} />
                <Triple cells={r.hidden} />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function FilterLink({ filters, patch, label }: { filters: JevFilters; patch: Partial<JevFilters>; label: string }) {
  const next = { ...filters, ...patch };
  const active = (Object.keys(patch) as (keyof JevFilters)[]).every((k) => filters[k] === patch[k]);
  const query = Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined)) as Record<string, string>;
  return (
    <Link
      href={{ pathname: "/admin/jev", query }}
      className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
        active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-secondary hover:text-foreground"
      }`}
    >
      {label}
    </Link>
  );
}

function Filters({ filters }: { filters: JevFilters }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 mb-3">
      <div className="flex items-center gap-1">
        <FilterLink filters={filters} patch={{ direction: undefined }} label="All" />
        <FilterLink filters={filters} patch={{ direction: "jev_keeps" }} label="Jev keeps" />
        <FilterLink filters={filters} patch={{ direction: "jev_rejects" }} label="Jev rejects" />
      </div>
      <div className="flex items-center gap-1">
        <FilterLink filters={filters} patch={{ lang: undefined }} label="All languages" />
        <FilterLink filters={filters} patch={{ lang: "fi" }} label="FI" />
        <FilterLink filters={filters} patch={{ lang: "en" }} label="EN" />
      </div>
      <div className="flex items-center gap-1">
        <FilterLink filters={filters} patch={{ group: undefined }} label="All groups" />
        <FilterLink filters={filters} patch={{ group: "ollama_keep" }} label="Ollama keep" />
        <FilterLink filters={filters} patch={{ group: "ollama_reject" }} label="Ollama reject" />
        <FilterLink filters={filters} patch={{ group: "keyword" }} label="Keyword reject" />
      </div>
    </div>
  );
}

function DisagreementTable({ rows }: { rows: Disagreement[] }) {
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">No disagreements match these filters.</p>;
  }
  return (
    <div className="rounded-lg border border-border overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-secondary/60 border-b border-border text-xs text-muted-foreground">
            <th className="text-left px-4 py-2.5 font-medium">Title</th>
            <th className="text-left px-4 py-2.5 font-medium hidden md:table-cell">Baseline</th>
            <th className="text-left px-4 py-2.5 font-medium">Jev</th>
            <th className="text-right px-4 py-2.5 font-medium hidden sm:table-cell">Pos / Upl</th>
            <th className="text-left px-4 py-2.5 font-medium hidden lg:table-cell">Top category</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ row, group, verdict, direction }, i) => (
            <tr
              key={row.articleId}
              className={`border-b border-border/60 last:border-0 ${i % 2 === 0 ? "" : "bg-background/50"}`}
            >
              <td className="px-4 py-2.5">
                <span className="line-clamp-2 text-xs text-foreground">{row.title}</span>
                <span className="text-[11px] text-muted-foreground">
                  {row.sourceName} · {row.language.toUpperCase()}
                  {row.flaggedAt ? " · reader-flagged" : ""}
                </span>
              </td>
              <td className="px-4 py-2.5 text-xs text-muted-foreground hidden md:table-cell">
                <div>{GROUP_LABELS[group]}</div>
                {row.rejectionReason && <div className="font-mono text-[11px]">{row.rejectionReason}</div>}
              </td>
              <td className="px-4 py-2.5 text-xs whitespace-nowrap">
                <span className={direction === "jev_keeps" ? "text-[#3d8b5e]" : "text-destructive"}>
                  {direction === "jev_keeps" ? "Keep" : "Reject"}
                </span>
                {verdict.reason && (
                  <div className="font-mono text-[11px] text-muted-foreground">{verdict.reason}</div>
                )}
              </td>
              <td className="px-4 py-2.5 text-xs text-right tabular-nums hidden sm:table-cell whitespace-nowrap">
                {prob(row.positiveP)} / {prob(row.upliftingP)}
              </td>
              <td className="px-4 py-2.5 text-xs text-muted-foreground hidden lg:table-cell">
                {CATEGORIES[row.topCategory]?.label ?? row.topCategory}{" "}
                <span className="tabular-nums">{prob(row.topCategoryP)}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function JevReportView({
  report,
  scores,
  filters,
  questionSet,
  thresholds,
}: {
  report: JevReport;
  scores: { cohort: ScoreTable; targeted: ScoreTable };
  filters: JevFilters;
  questionSet: string;
  thresholds: JevThresholds;
}) {
  const { agreement, flagged, keyword } = report;
  const filtered = report.disagreements.filter(
    (d) =>
      (!filters.direction || d.direction === filters.direction) &&
      (!filters.lang || d.row.language === filters.lang) &&
      (!filters.group || d.group === filters.group),
  );

  return (
    <div className="space-y-8">
      <p className="text-xs text-muted-foreground tabular-nums">
        {report.evaluated} evaluations · model {report.models.join(", ")} · question set {questionSet} ·
        thresholds positive ≥ {thresholds.positiveMin}, uplifting ≥ {thresholds.upliftingMin}, category ≤{" "}
        {thresholds.categoryMax} · {report.groups.pending} pending curation (excluded) · {report.groups.admin} admin-decided (excluded) · Ollama fail-open keeps (during Ollama outages) count as keeps
      </p>

      <section>
        <h2 className="text-lg font-medium text-foreground mb-3">Against your decisions</h2>
        {scores.cohort.labels.all + scores.targeted.labels.all === 0 ? (
          <p className="text-sm text-muted-foreground">
            No reviewed articles yet — start at{" "}
            <Link href="/admin/review" className="text-primary hover:underline">
              Review
            </Link>
            .
          </p>
        ) : (
          <>
            <p className="text-xs text-muted-foreground mb-3">
              {scores.cohort.labels.all} cohort labels · {scores.targeted.labels.all} targeted — rates firm up as labels
              accumulate (about 4 cohort reviews a day).
            </p>
            <div className="space-y-4">
              <ScoreTableView title="Random cohort (unbiased)" table={scores.cohort} />
              <ScoreTableView title="Targeted reviews" table={scores.targeted} />
            </div>
          </>
        )}
      </section>

      <section>
        <h2 className="text-lg font-medium text-foreground mb-3">Agreement with Ollama</h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">
          <StatTile label="All" value={pct(agreement.all.rate)} detail={`${agreement.all.agree} of ${agreement.all.total}`} />
          <StatTile label="Finnish" value={pct(agreement.fi.rate)} detail={`${agreement.fi.agree} of ${agreement.fi.total}`} />
          <StatTile label="English" value={pct(agreement.en.rate)} detail={`${agreement.en.agree} of ${agreement.en.total}`} />
        </div>
        <Matrix a={agreement.all} />
      </section>

      <section className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <StatTile
          label="Reader-flagged articles Jev would reject"
          value={pct(flagged.rate)}
          detail={`${flagged.jevRejects} of ${flagged.total} (Ollama kept all of them)`}
        />
        <div>
          <StatTile
            label="Keyword-rejected articles Jev would keep"
            value={pct(keyword.rate)}
            detail={`${keyword.jevKeeps} of ${keyword.total}`}
          />
          <Link
            href={{ pathname: "/admin/jev", query: { group: "keyword", direction: "jev_keeps" } }}
            className="mt-2 inline-block text-xs text-primary hover:underline"
          >
            Show these articles
          </Link>
        </div>
      </section>

      <section>
        <h2 className="text-lg font-medium text-foreground mb-3">
          Disagreements{" "}
          <span className="text-sm text-muted-foreground tabular-nums">
            ({Math.min(filtered.length, TABLE_ROWS)} of {filtered.length})
          </span>
        </h2>
        <p className="text-xs text-muted-foreground mb-3">Newest articles first (by ingest time).</p>
        <Filters filters={filters} />
        <DisagreementTable rows={filtered.slice(0, TABLE_ROWS)} />
      </section>
    </div>
  );
}

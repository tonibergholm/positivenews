// components/news/StatsView.tsx
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

const CATEGORY_COLORS: Record<string, string> = {
  Science:
    "bg-sky-100 text-sky-700 border-sky-200 dark:bg-sky-900/30 dark:text-sky-300 dark:border-sky-800",
  Environment:
    "bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300 dark:border-emerald-800",
  Society:
    "bg-violet-100 text-violet-700 border-violet-200 dark:bg-violet-900/30 dark:text-violet-300 dark:border-violet-800",
  Health:
    "bg-rose-100 text-rose-700 border-rose-200 dark:bg-rose-900/30 dark:text-rose-300 dark:border-rose-800",
  Innovation:
    "bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-800",
};

interface StatsPayload {
  pipeline: { running: boolean };
  articles: {
    total: number;
    positive: number;
    last24h: number;
    rejectionRate: number;
    oldest: string | null;
    newest: string | null;
  };
  byCategory: Record<string, number>;
  bySources: Array<{ name: string; count: number; rejectionRate: number; lastArticle: string | null }>;
}

function formatShortDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatLastArticle(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function Skeleton() {
  return (
    <div className="animate-pulse space-y-6">
      <div className="space-y-2">
        <div className="h-8 w-24 rounded bg-secondary" />
        <div className="h-2 w-full rounded-full bg-secondary" />
        <div className="h-4 w-56 rounded bg-secondary" />
      </div>
      <div className="flex flex-wrap gap-2">
        {[1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="h-6 w-20 rounded-full bg-secondary" />
        ))}
      </div>
      <div className="space-y-2">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-9 w-full rounded bg-secondary" />
        ))}
      </div>
    </div>
  );
}

export function StatsView() {
  const [stats, setStats] = useState<StatsPayload | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [secondsAgo, setSecondsAgo] = useState(0);

  useEffect(() => {
    const es = new EventSource("/news/api/stats/stream");
    es.onmessage = (e: MessageEvent) => {
      try {
        setStats(JSON.parse(e.data) as StatsPayload);
        setLastUpdated(Date.now());
        setSecondsAgo(0);
      } catch {
        // malformed event — ignore
      }
    };
    return () => es.close();
  }, []);

  useEffect(() => {
    if (lastUpdated === null) return;
    const id = setInterval(() => {
      setSecondsAgo(Math.floor((Date.now() - lastUpdated) / 1000));
    }, 1_000);
    return () => clearInterval(id);
  }, [lastUpdated]);

  if (!stats) {
    return (
      <div className="max-w-3xl mx-auto py-8 px-0">
        <div className="mb-8">
          <h1 className="font-heading text-[22px] sm:text-[28px] font-semibold text-foreground mb-2">
            Pipeline Stats
          </h1>
        </div>
        <Skeleton />
      </div>
    );
  }

  const updatedText =
    secondsAgo <= 2 ? "updated just now" : `updated ${secondsAgo}s ago`;

  const acceptancePct = Math.round((1 - stats.articles.rejectionRate) * 100);
  const rejectionPct = Math.round(stats.articles.rejectionRate * 100);
  const sortedCategories = Object.entries(stats.byCategory).sort(
    ([, a], [, b]) => b - a
  );

  return (
    <div className="max-w-3xl mx-auto py-8 px-0">
      {/* Page header */}
      <div className="mb-8">
        <h1 className="font-heading text-[22px] sm:text-[28px] font-semibold text-foreground mb-2">
          Pipeline Stats
        </h1>
        <p className="text-sm text-muted-foreground flex items-center gap-2">
          <span
            className={`inline-block size-2 rounded-full shrink-0 ${
              stats.pipeline.running
                ? "bg-amber-500 animate-pulse"
                : "bg-emerald-600"
            }`}
          />
          {stats.pipeline.running ? "Pipeline running" : "Pipeline idle"}
          <span className="text-muted-foreground/50">·</span>
          {updatedText}
        </p>
      </div>

      {/* Articles */}
      <div className="mb-6">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-widest mb-3">
          Articles
        </p>
        <div className="flex items-baseline gap-3 flex-wrap mb-3">
          <span className="font-heading text-[28px] font-bold text-primary leading-none tabular-nums">
            {stats.articles.total.toLocaleString()}
          </span>
          <span className="text-sm text-muted-foreground">
            total &nbsp;·&nbsp;{" "}
            <span className="text-emerald-600 font-medium">
              {stats.articles.positive.toLocaleString()} positive
            </span>{" "}
            &nbsp;·&nbsp; {stats.articles.last24h.toLocaleString()} in last 24h
          </span>
        </div>
        <div className="h-2 rounded-full bg-secondary overflow-hidden mb-1.5">
          <div
            className="h-full rounded-full bg-emerald-600 transition-[width] duration-500"
            style={{ width: `${acceptancePct}%` }}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          {acceptancePct}% acceptance rate &nbsp;·&nbsp; {rejectionPct}% rejected by
          pipeline
        </p>
        {(stats.articles.oldest ?? stats.articles.newest) && (
          <p className="text-xs text-muted-foreground mt-1">
            Archive: {formatShortDate(stats.articles.oldest)} –{" "}
            {formatShortDate(stats.articles.newest)}
          </p>
        )}
      </div>

      <div className="border-t border-border/60 mb-6" />

      {/* By Category */}
      <div className="mb-6">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-widest mb-3">
          By Category
        </p>
        <div className="flex flex-wrap gap-2">
          {sortedCategories.map(([cat, count]) => {
            const colorClass =
              CATEGORY_COLORS[cat] ??
              "bg-gray-100 text-gray-600 border-gray-200";
            return (
              <span
                key={cat}
                className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${colorClass}`}
              >
                {cat}
                <strong className="tabular-nums font-semibold">
                  {count.toLocaleString()}
                </strong>
              </span>
            );
          })}
        </div>
      </div>

      <div className="border-t border-border/60 mb-6" />

      {/* By Source */}
      <div className="mb-6">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-widest mb-3">
          By Source
        </p>
        <div className="rounded-lg border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-secondary/60 border-b border-border text-xs text-muted-foreground">
                <th className="text-left px-4 py-2.5 font-medium">Source</th>
                <th className="text-right px-4 py-2.5 font-medium">Articles</th>
                <th className="text-right px-4 py-2.5 font-medium hidden sm:table-cell">Rejected</th>
                <th className="text-right px-4 py-2.5 font-medium hidden sm:table-cell">
                  Last article
                </th>
              </tr>
            </thead>
            <tbody>
              {stats.bySources.map((src, i) => (
                <tr
                  key={src.name}
                  className={`border-b border-border/60 last:border-0 transition-colors hover:bg-secondary/40 ${
                    i % 2 === 0 ? "" : "bg-background/50"
                  }`}
                >
                  <td className="px-4 py-3 font-medium text-foreground">
                    {src.name}
                  </td>
                  <td className="px-4 py-3 text-right text-muted-foreground tabular-nums">
                    {src.count.toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-right text-xs tabular-nums hidden sm:table-cell">
                    <span className={src.rejectionRate >= 70 ? "text-rose-600 dark:text-rose-400" : "text-muted-foreground"}>
                      {src.rejectionRate}%
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right text-xs text-muted-foreground tabular-nums whitespace-nowrap hidden sm:table-cell">
                    <time dateTime={src.lastArticle ?? undefined}>
                      {formatLastArticle(src.lastArticle)}
                    </time>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Footer */}
      <div className="mt-2 text-xs text-muted-foreground border-t border-border/60 pt-6">
        Stats refresh automatically while this page is open.{" "}
        <Link href="/" className="text-primary hover:underline">
          Back to feed &rarr;
        </Link>
      </div>
    </div>
  );
}

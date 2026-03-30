import type { Metadata } from "next";
import Link from "next/link";
import { prisma } from "@/src/lib/prisma";
import { FEED_SOURCES } from "@/src/config/sources";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "News Sources — PositiveNews",
  description: "All news sources aggregated by PositiveNews, with last ingestion timestamps.",
};

const CATEGORY_COLORS: Record<string, string> = {
  Science:     "bg-sky-100 text-sky-700 border-sky-200 dark:bg-sky-900/30 dark:text-sky-300 dark:border-sky-800",
  Environment: "bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300 dark:border-emerald-800",
  Society:     "bg-violet-100 text-violet-700 border-violet-200 dark:bg-violet-900/30 dark:text-violet-300 dark:border-violet-800",
  Health:      "bg-rose-100 text-rose-700 border-rose-200 dark:bg-rose-900/30 dark:text-rose-300 dark:border-rose-800",
  Innovation:  "bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-800",
};

const LANG_LABELS: Record<string, string> = {
  en: "English",
  fi: "Finnish",
};

function siteUrl(feedUrl: string): string {
  try {
    return new URL(feedUrl).origin;
  } catch {
    return feedUrl;
  }
}

function formatDate(date: Date): string {
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

export default async function SourcesPage() {
  // Build a lookup of feed URL → trusted flag from config
  const trustedByUrl = new Map<string, boolean>(
    FEED_SOURCES.map((s) => [s.url, s.trusted ?? false])
  );

  const sources = await prisma.source.findMany({
    where: { isActive: true },
    include: {
      _count: { select: { articles: true } },
      articles: {
        orderBy: { publishedAt: "desc" },
        take: 1,
        select: { publishedAt: true },
      },
    },
    orderBy: [{ language: "asc" }, { category: "asc" }, { name: "asc" }],
  });

  // Group by language
  const byLanguage = sources.reduce<Record<string, typeof sources>>(
    (acc, src) => {
      const lang = src.language ?? "en";
      if (!acc[lang]) acc[lang] = [];
      acc[lang].push(src);
      return acc;
    },
    {}
  );

  const languageOrder = ["en", "fi"];
  const sortedLanguages = [
    ...languageOrder.filter((l) => byLanguage[l]),
    ...Object.keys(byLanguage).filter((l) => !languageOrder.includes(l)),
  ];

  const totalArticles = sources.reduce((sum, s) => sum + s._count.articles, 0);

  return (
    <div className="max-w-3xl mx-auto py-8 px-0">
      {/* Page header */}
      <div className="mb-8">
        <h1 className="font-heading text-[22px] sm:text-[28px] font-semibold text-foreground mb-2">
          News Sources
        </h1>
        <p className="text-sm text-muted-foreground">
          PositiveNews aggregates from{" "}
          <span className="font-medium text-foreground">{sources.length} sources</span>{" "}
          across{" "}
          <span className="font-medium text-foreground">{sortedLanguages.length} languages</span>,
          with{" "}
          <span className="font-medium text-foreground">
            {totalArticles.toLocaleString()} articles
          </span>{" "}
          in the archive. Sources are checked regularly for new content.
        </p>
      </div>

      {/* Sources by language */}
      {sortedLanguages.map((lang) => {
        const langSources = byLanguage[lang];
        return (
          <section key={lang} className="mb-10">
            <h2 className="text-base font-semibold text-foreground mb-3 flex items-center gap-2">
              {LANG_LABELS[lang] ?? lang.toUpperCase()}
              <span className="text-xs font-normal text-muted-foreground">
                ({langSources.length})
              </span>
            </h2>

            <div className="rounded-lg border border-border overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-secondary/60 border-b border-border text-xs text-muted-foreground">
                    <th className="text-left px-4 py-2.5 font-medium">Source</th>
                    <th className="text-left px-4 py-2.5 font-medium hidden sm:table-cell">Category</th>
                    <th className="text-right px-4 py-2.5 font-medium hidden md:table-cell">Articles</th>
                    <th className="text-right px-4 py-2.5 font-medium">Last ingested</th>
                  </tr>
                </thead>
                <tbody>
                  {langSources.map((src, i) => {
                    const latestAt = src.articles[0]?.publishedAt ?? null;
                    const trusted = trustedByUrl.get(src.url) ?? false;
                    const catClass =
                      CATEGORY_COLORS[src.category] ??
                      "bg-gray-100 text-gray-600 border-gray-200";
                    const homepage = siteUrl(src.url);

                    return (
                      <tr
                        key={src.id}
                        className={`border-b border-border/60 last:border-0 transition-colors hover:bg-secondary/40 ${
                          i % 2 === 0 ? "" : "bg-background/50"
                        }`}
                      >
                        {/* Name */}
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2 flex-wrap">
                            <a
                              href={homepage}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="font-medium text-foreground hover:text-primary transition-colors"
                            >
                              {src.name}
                            </a>
                            {trusted && (
                              <span
                                title="Curated positive-news outlet"
                                className="inline-flex items-center gap-0.5 rounded-full border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-700"
                              >
                                <svg
                                  xmlns="http://www.w3.org/2000/svg"
                                  viewBox="0 0 16 16"
                                  fill="currentColor"
                                  className="size-2.5"
                                >
                                  <path
                                    fillRule="evenodd"
                                    d="M8 1.75a.75.75 0 0 1 .692.462l1.41 3.393 3.664.293a.75.75 0 0 1 .428 1.317l-2.791 2.39.853 3.575a.75.75 0 0 1-1.12.814L8 11.812l-3.135 1.982a.75.75 0 0 1-1.12-.814l.852-3.574-2.79-2.39a.75.75 0 0 1 .427-1.318l3.663-.293L7.308 2.212A.75.75 0 0 1 8 1.75Z"
                                    clipRule="evenodd"
                                  />
                                </svg>
                                Curated
                              </span>
                            )}
                            {/* Category on mobile */}
                            <span
                              className={`sm:hidden inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${catClass}`}
                            >
                              {src.category}
                            </span>
                          </div>
                        </td>

                        {/* Category — hidden on mobile (shown inline above) */}
                        <td className="px-4 py-3 hidden sm:table-cell">
                          <span
                            className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${catClass}`}
                          >
                            {src.category}
                          </span>
                        </td>

                        {/* Article count */}
                        <td className="px-4 py-3 text-right text-muted-foreground tabular-nums hidden md:table-cell">
                          {src._count.articles.toLocaleString()}
                        </td>

                        {/* Last ingested */}
                        <td className="px-4 py-3 text-right text-xs text-muted-foreground tabular-nums whitespace-nowrap">
                          {latestAt ? (
                            <time
                              dateTime={latestAt.toISOString()}
                              title={formatDate(latestAt)}
                            >
                              {formatDate(latestAt)}
                            </time>
                          ) : (
                            <span className="text-muted-foreground/50">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}

      {/* Legend */}
      <div className="mt-2 text-xs text-muted-foreground border-t border-border/60 pt-6">
        <p>
          <span className="inline-flex items-center gap-1 font-medium text-amber-700 dark:text-amber-300">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 16 16"
              fill="currentColor"
              className="size-3"
            >
              <path
                fillRule="evenodd"
                d="M8 1.75a.75.75 0 0 1 .692.462l1.41 3.393 3.664.293a.75.75 0 0 1 .428 1.317l-2.791 2.39.853 3.575a.75.75 0 0 1-1.12.814L8 11.812l-3.135 1.982a.75.75 0 0 1-1.12-.814l.852-3.574-2.79-2.39a.75.75 0 0 1 .427-1.318l3.663-.293L7.308 2.212A.75.75 0 0 1 8 1.75Z"
                clipRule="evenodd"
              />
            </svg>
            Curated
          </span>{" "}
          sources are dedicated positive-news outlets — all their content is published as-is.
          Other sources are filtered by our positivity classifier before appearing in the feed.
        </p>
        <p className="mt-2">
          &ldquo;Last ingested&rdquo; reflects the publication date of the most recent article
          we have from that source.{" "}
          <Link href="/" className="text-primary hover:underline">
            Back to the feed &rarr;
          </Link>
        </p>
      </div>
    </div>
  );
}

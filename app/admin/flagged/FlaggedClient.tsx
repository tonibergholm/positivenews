"use client";

import { useTransition } from "react";
import { extractKeywords } from "@/src/lib/keywords";
import { unflagArticle } from "./actions";

interface FlaggedArticle {
  id: string;
  title: string;
  flaggedAt: Date | null;
  source: { name: string; language: string };
}

function formatDate(date: Date): string {
  return new Date(date).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function UnflagButton({ id }: { id: string }) {
  const [isPending, startTransition] = useTransition();
  return (
    <button
      onClick={() => startTransition(() => unflagArticle(id))}
      disabled={isPending}
      className="rounded border border-emerald-200 bg-white px-2.5 py-1 text-xs font-medium text-emerald-600 hover:bg-emerald-50 dark:bg-transparent dark:border-emerald-800 dark:text-emerald-400 disabled:opacity-50 transition-colors whitespace-nowrap"
    >
      {isPending ? "…" : "Unflag"}
    </button>
  );
}

export function FlaggedTable({ articles }: { articles: FlaggedArticle[] }) {
  return (
    <div className="rounded-lg border border-border overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-secondary/60 border-b border-border text-xs text-muted-foreground">
            <th className="text-left px-4 py-2.5 font-medium">Title</th>
            <th className="text-left px-4 py-2.5 font-medium hidden sm:table-cell">Source</th>
            <th className="text-left px-4 py-2.5 font-medium hidden md:table-cell">Keywords extracted</th>
            <th className="text-right px-4 py-2.5 font-medium hidden sm:table-cell">Flagged</th>
            <th className="text-right px-4 py-2.5 font-medium"></th>
          </tr>
        </thead>
        <tbody>
          {articles.map((a, i) => {
            const keywords = extractKeywords(a.title, a.source.language ?? "en");
            return (
              <tr
                key={a.id}
                className={`border-b border-border/60 last:border-0 ${
                  i % 2 === 0 ? "" : "bg-background/50"
                }`}
              >
                <td className="px-4 py-2.5 text-foreground">
                  <span className="line-clamp-2 text-xs">{a.title}</span>
                </td>
                <td className="px-4 py-2.5 text-xs text-muted-foreground hidden sm:table-cell whitespace-nowrap">
                  {a.source.name}
                </td>
                <td className="px-4 py-2.5 hidden md:table-cell">
                  <div className="flex flex-wrap gap-1">
                    {keywords.slice(0, 5).map((kw) => (
                      <span
                        key={kw}
                        className="bg-secondary text-muted-foreground rounded px-1.5 py-0.5 text-[10px] font-mono"
                      >
                        {kw}
                      </span>
                    ))}
                  </div>
                </td>
                <td className="px-4 py-2.5 text-xs text-muted-foreground text-right hidden sm:table-cell whitespace-nowrap">
                  {a.flaggedAt ? formatDate(a.flaggedAt) : "—"}
                </td>
                <td className="px-4 py-2.5 text-right">
                  <UnflagButton id={a.id} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

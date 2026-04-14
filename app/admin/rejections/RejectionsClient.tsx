"use client";

import { useTransition } from "react";
import { unrejectArticle } from "./actions";

interface Rejection {
  id: string;
  title: string;
  rejectionReason: string | null;
  rejectionPass: number | null;
  createdAt: Date;
  source: { name: string };
}

const PASS_LABELS: Record<number, string> = {
  0: "Keyword",
  1: "LLM-1",
  2: "LLM-2",
};

const PASS_COLORS: Record<number, string> = {
  0: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
  1: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
  2: "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300",
};

function formatDate(date: Date): string {
  return new Date(date).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function UnrejectButton({ id }: { id: string }) {
  const [isPending, startTransition] = useTransition();
  return (
    <button
      onClick={() => startTransition(() => unrejectArticle(id))}
      disabled={isPending}
      className="rounded border border-emerald-200 bg-white px-2.5 py-1 text-xs font-medium text-emerald-600 hover:bg-emerald-50 dark:bg-transparent dark:border-emerald-800 dark:text-emerald-400 disabled:opacity-50 transition-colors whitespace-nowrap"
    >
      {isPending ? "…" : "Un-reject"}
    </button>
  );
}

export function RejectionsTable({ rejections }: { rejections: Rejection[] }) {
  return (
    <div className="rounded-lg border border-border overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-secondary/60 border-b border-border text-xs text-muted-foreground">
            <th className="text-left px-4 py-2.5 font-medium">Title</th>
            <th className="text-left px-4 py-2.5 font-medium hidden sm:table-cell">Source</th>
            <th className="text-left px-4 py-2.5 font-medium hidden md:table-cell">Pass</th>
            <th className="text-left px-4 py-2.5 font-medium hidden lg:table-cell">Reason</th>
            <th className="text-right px-4 py-2.5 font-medium hidden sm:table-cell">Date</th>
            <th className="text-right px-4 py-2.5 font-medium"></th>
          </tr>
        </thead>
        <tbody>
          {rejections.map((a, i) => {
            const pass = a.rejectionPass ?? 0;
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
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                      PASS_COLORS[pass] ?? PASS_COLORS[0]
                    }`}
                  >
                    {PASS_LABELS[pass] ?? `Pass ${pass}`}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-xs text-muted-foreground hidden lg:table-cell">
                  <span className="font-mono">{a.rejectionReason}</span>
                </td>
                <td className="px-4 py-2.5 text-xs text-muted-foreground text-right hidden sm:table-cell whitespace-nowrap">
                  {formatDate(a.createdAt)}
                </td>
                <td className="px-4 py-2.5 text-right">
                  <UnrejectButton id={a.id} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

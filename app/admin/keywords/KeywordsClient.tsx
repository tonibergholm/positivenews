// app/admin/keywords/KeywordsClient.tsx
"use client";

import { useState, useTransition } from "react";
import { activateKeyword, deactivateKeyword, deleteKeyword, addKeyword } from "./actions";

interface Keyword {
  id: string;
  keyword: string;
  language: string;
  hits: number;
  uniqueIps: number;
  lastHitAt: Date | null;
  active: boolean;
}

function timeAgo(date: Date | null): string {
  if (!date) return "—";
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function MutationButton({
  action,
  label,
  variant,
}: {
  action: () => Promise<unknown>;
  label: string;
  variant: "primary" | "danger" | "ghost";
}) {
  const [isPending, startTransition] = useTransition();

  const styles = {
    primary:
      "bg-emerald-600 text-white border-transparent hover:bg-emerald-700",
    danger:
      "bg-white text-rose-600 border-rose-200 hover:bg-rose-50 dark:bg-transparent dark:text-rose-400 dark:border-rose-800",
    ghost:
      "bg-white text-muted-foreground border-border hover:bg-secondary dark:bg-transparent",
  };

  return (
    <button
      onClick={() => startTransition(action)}
      disabled={isPending}
      className={`rounded border px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50 ${styles[variant]}`}
    >
      {isPending ? "…" : label}
    </button>
  );
}

export function PendingTable({ keywords }: { keywords: Keyword[] }) {
  if (keywords.length === 0) return null;
  return (
    <div className="rounded-lg border border-border overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-secondary/60 border-b border-border text-xs text-muted-foreground">
            <th className="text-left px-4 py-2.5 font-medium">Keyword</th>
            <th className="text-left px-4 py-2.5 font-medium">Lang</th>
            <th className="text-right px-4 py-2.5 font-medium">Hits</th>
            <th className="text-right px-4 py-2.5 font-medium hidden sm:table-cell">IPs</th>
            <th className="text-right px-4 py-2.5 font-medium">Actions</th>
          </tr>
        </thead>
        <tbody>
          {keywords.map((kw, i) => (
            <tr
              key={kw.id}
              className={`border-b border-border/60 last:border-0 ${i % 2 === 0 ? "" : "bg-background/50"}`}
            >
              <td className="px-4 py-3 font-mono text-xs font-medium">{kw.keyword}</td>
              <td className="px-4 py-3 text-xs text-muted-foreground">{kw.language}</td>
              <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">{kw.hits}</td>
              <td className="px-4 py-3 text-right tabular-nums text-muted-foreground hidden sm:table-cell">{kw.uniqueIps}</td>
              <td className="px-4 py-3">
                <div className="flex items-center justify-end gap-2">
                  <MutationButton
                    action={() => activateKeyword(kw.id)}
                    label="Activate"
                    variant="primary"
                  />
                  <MutationButton
                    action={() => deleteKeyword(kw.id)}
                    label="Dismiss"
                    variant="ghost"
                  />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ActiveTable({ keywords }: { keywords: Keyword[] }) {
  return (
    <div className="rounded-lg border border-border overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-secondary/60 border-b border-border text-xs text-muted-foreground">
            <th className="text-left px-4 py-2.5 font-medium">Keyword</th>
            <th className="text-left px-4 py-2.5 font-medium">Lang</th>
            <th className="text-right px-4 py-2.5 font-medium">Hits</th>
            <th className="text-right px-4 py-2.5 font-medium hidden sm:table-cell">Last hit</th>
            <th className="text-right px-4 py-2.5 font-medium"></th>
          </tr>
        </thead>
        <tbody>
          {keywords.map((kw, i) => (
            <tr
              key={kw.id}
              className={`border-b border-border/60 last:border-0 ${i % 2 === 0 ? "" : "bg-background/50"}`}
            >
              <td className="px-4 py-3 font-mono text-xs font-medium">{kw.keyword}</td>
              <td className="px-4 py-3 text-xs text-muted-foreground">{kw.language}</td>
              <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">{kw.hits}</td>
              <td className="px-4 py-3 text-right text-xs text-muted-foreground hidden sm:table-cell">{timeAgo(kw.lastHitAt)}</td>
              <td className="px-4 py-3 text-right">
                <MutationButton
                  action={() => deactivateKeyword(kw.id)}
                  label="Deactivate"
                  variant="danger"
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function StaleTable({ keywords }: { keywords: Keyword[] }) {
  if (keywords.length === 0) return null;
  return (
    <div className="rounded-lg border border-border overflow-hidden opacity-70">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-secondary/60 border-b border-border text-xs text-muted-foreground">
            <th className="text-left px-4 py-2.5 font-medium">Keyword</th>
            <th className="text-left px-4 py-2.5 font-medium">Lang</th>
            <th className="text-right px-4 py-2.5 font-medium hidden sm:table-cell">Last hit</th>
            <th className="text-right px-4 py-2.5 font-medium"></th>
          </tr>
        </thead>
        <tbody>
          {keywords.map((kw, i) => (
            <tr
              key={kw.id}
              className={`border-b border-border/60 last:border-0 ${i % 2 === 0 ? "" : "bg-background/50"}`}
            >
              <td className="px-4 py-3 font-mono text-xs font-medium text-muted-foreground">{kw.keyword}</td>
              <td className="px-4 py-3 text-xs text-muted-foreground">{kw.language}</td>
              <td className="px-4 py-3 text-right text-xs text-muted-foreground hidden sm:table-cell">{timeAgo(kw.lastHitAt)}</td>
              <td className="px-4 py-3 text-right">
                <MutationButton
                  action={() => activateKeyword(kw.id)}
                  label="Re-activate"
                  variant="ghost"
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AddKeywordForm() {
  const [keyword, setKeyword] = useState("");
  const [language, setLanguage] = useState("en");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await addKeyword(keyword, language);
      if (result?.error) {
        setError(result.error);
      } else {
        setKeyword("");
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex items-center gap-2 mb-6">
      <input
        type="text"
        value={keyword}
        onChange={(e) => setKeyword(e.target.value)}
        placeholder="Add keyword…"
        className="flex-1 rounded border border-border bg-background px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        disabled={isPending}
      />
      <select
        value={language}
        onChange={(e) => setLanguage(e.target.value)}
        className="rounded border border-border bg-background px-2 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        disabled={isPending}
      >
        <option value="en">EN</option>
        <option value="fi">FI</option>
      </select>
      <button
        type="submit"
        disabled={isPending || !keyword.trim()}
        className="rounded border border-transparent bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50 transition-colors"
      >
        {isPending ? "…" : "Add"}
      </button>
      {error && <span className="text-xs text-rose-500">{error}</span>}
    </form>
  );
}

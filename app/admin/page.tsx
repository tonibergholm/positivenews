// app/admin/page.tsx
import { prisma } from "@/src/lib/prisma";
import Link from "next/link";

function timeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

async function getDashboardData() {
  const minHits = parseInt(process.env.KEYWORD_MIN_HITS ?? "5", 10);
  const minIps = parseInt(process.env.KEYWORD_MIN_IPS ?? "2", 10);
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [pendingCount, staleCount, flaggedToday, recentFlagged] = await Promise.all([
    prisma.learnedKeyword.count({
      where: { active: false, hits: { gte: minHits }, uniqueIps: { gte: minIps } },
    }),
    prisma.learnedKeyword.count({
      where: { active: false, lastHitAt: { lt: thirtyDaysAgo } },
    }),
    prisma.article.count({
      where: { flaggedAt: { gte: yesterday } },
    }),
    prisma.article.findMany({
      where: { flaggedAt: { not: null } },
      orderBy: { flaggedAt: "desc" },
      take: 10,
      select: {
        id: true,
        title: true,
        flaggedAt: true,
        source: { select: { name: true } },
      },
    }),
  ]);

  return { pendingCount, staleCount, flaggedToday, recentFlagged };
}

export default async function AdminDashboard() {
  const { pendingCount, staleCount, flaggedToday, recentFlagged } =
    await getDashboardData();

  return (
    <div className="max-w-3xl">
      <div className="mb-8">
        <h1 className="text-xl font-semibold text-foreground mb-1">Dashboard</h1>
        <p className="text-sm text-muted-foreground">Pipeline health at a glance.</p>
      </div>

      <div className="grid grid-cols-3 gap-4 mb-8">
        <Link
          href="/admin/keywords"
          className="rounded-lg border border-border p-4 hover:bg-secondary/40 transition-colors"
        >
          <div className="text-2xl font-bold text-foreground tabular-nums">
            {pendingCount}
          </div>
          <div className="text-xs text-muted-foreground mt-1">Pending keywords</div>
        </Link>
        <div className="rounded-lg border border-border p-4">
          <div className="text-2xl font-bold text-foreground tabular-nums">
            {staleCount}
          </div>
          <div className="text-xs text-muted-foreground mt-1">Stale keywords</div>
        </div>
        <div className="rounded-lg border border-border p-4">
          <div className="text-2xl font-bold text-foreground tabular-nums">
            {flaggedToday}
          </div>
          <div className="text-xs text-muted-foreground mt-1">Flagged today</div>
        </div>
      </div>

      <div>
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-widest mb-3">
          Recent user flags
        </p>
        {recentFlagged.length === 0 ? (
          <p className="text-sm text-muted-foreground">No flagged articles yet.</p>
        ) : (
          <div className="space-y-2">
            {recentFlagged.map((a) => (
              <div
                key={a.id}
                className="flex items-start justify-between gap-4 text-sm py-2 border-b border-border/60 last:border-0"
              >
                <div className="min-w-0">
                  <p className="text-foreground truncate">{a.title}</p>
                  <p className="text-xs text-muted-foreground">{a.source.name}</p>
                </div>
                <span className="text-xs text-muted-foreground whitespace-nowrap shrink-0">
                  {timeAgo(a.flaggedAt!)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

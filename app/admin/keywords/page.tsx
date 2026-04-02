// app/admin/keywords/page.tsx
import { prisma } from "@/src/lib/prisma";
import { PendingTable, ActiveTable, StaleTable } from "./KeywordsClient";

export const dynamic = "force-dynamic";

async function getKeywordData() {
  const minHits = parseInt(process.env.KEYWORD_MIN_HITS ?? "5", 10);
  const minIps = parseInt(process.env.KEYWORD_MIN_IPS ?? "2", 10);
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [pending, active, stale] = await Promise.all([
    prisma.learnedKeyword.findMany({
      where: { active: false, hits: { gte: minHits }, uniqueIps: { gte: minIps } },
      orderBy: { hits: "desc" },
    }),
    prisma.learnedKeyword.findMany({
      where: { active: true },
      orderBy: { hits: "desc" },
    }),
    prisma.learnedKeyword.findMany({
      where: { active: false, lastHitAt: { lt: thirtyDaysAgo } },
      orderBy: { lastHitAt: "asc" },
    }),
  ]);

  return { pending, active, stale };
}

export default async function KeywordsPage() {
  const { pending, active, stale } = await getKeywordData();

  return (
    <div className="max-w-3xl">
      <div className="mb-8">
        <h1 className="text-xl font-semibold text-foreground mb-1">Keywords</h1>
        <p className="text-sm text-muted-foreground">
          Learned from user flags. Activate to add to filter, deactivate to remove.
        </p>
      </div>

      {pending.length > 0 && (
        <div className="mb-8">
          <div className="flex items-center gap-2 mb-3">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">
              Pending activation
            </p>
            <span className="bg-amber-100 text-amber-800 border border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-800 rounded-full px-2 py-0.5 text-[10px] font-semibold">
              {pending.length}
            </span>
          </div>
          <PendingTable keywords={pending} />
          <p className="text-xs text-muted-foreground mt-2">
            Auto-activates after {process.env.KEYWORD_AUTO_ACTIVATE_DAYS ?? "7"} days if not reviewed.
          </p>
        </div>
      )}

      <div className="mb-8">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-widest mb-3">
          Active ({active.length})
        </p>
        {active.length === 0 ? (
          <p className="text-sm text-muted-foreground">No active learned keywords yet.</p>
        ) : (
          <ActiveTable keywords={active} />
        )}
      </div>

      {stale.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-widest mb-3">
            Stale / deactivated ({stale.length})
          </p>
          <StaleTable keywords={stale} />
        </div>
      )}
    </div>
  );
}

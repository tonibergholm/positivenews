// app/admin/flagged/page.tsx
import Link from "next/link";
import { prisma } from "@/src/lib/prisma";
import { currentAdminAuthority } from "@/src/lib/labels";
import { FlaggedTable } from "./FlaggedClient";

export const dynamic = "force-dynamic";

const DISPLAY_LIMIT = 300;

async function getFlaggedArticles() {
  return prisma.article.findMany({
    where: { OR: [{ flaggedAt: { not: null } }, { labelEvents: { some: { source: "reader_flag" } } }] },
    orderBy: [{ flaggedAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
    select: {
      id: true,
      title: true,
      flaggedAt: true,
      source: { select: { name: true, language: true } },
      labelEvents: {
        where: { source: { in: ["admin", "reader_flag"] } },
        select: { id: true, source: true, verdict: true, category: true, eligible: true, bucket: true, retractsId: true, createdAt: true },
      },
    },
  });
}

export default async function FlaggedPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const showResolved = params.resolved === "1";
  const rows = await getFlaggedArticles();
  const visible = showResolved
    ? rows
    : rows.filter((r) => {
        const authority = currentAdminAuthority(r.labelEvents.filter((e) => e.source === "admin"));
        if (!authority) return true;
        const flagTimes = r.labelEvents.filter((e) => e.source === "reader_flag").map((e) => e.createdAt.getTime());
        const newestFlag = flagTimes.length ? Math.max(...flagTimes) : (r.flaggedAt?.getTime() ?? null);
        return newestFlag !== null && authority.createdAt.getTime() < newestFlag;
      });
  const truncated = visible.length > DISPLAY_LIMIT;
  // Newest flag first, so re-opened flags (whose flaggedAt is old or null) aren't cut by the cap.
  const withNewest = visible.map((r) => {
    const times = r.labelEvents.filter((e) => e.source === "reader_flag").map((e) => e.createdAt.getTime());
    if (r.flaggedAt) times.push(r.flaggedAt.getTime());
    return { r, newest: times.length ? Math.max(...times) : 0 };
  });
  withNewest.sort((a, b) => b.newest - a.newest);
  const flagged = withNewest.slice(0, DISPLAY_LIMIT).map(({ r, newest }) => {
    return { id: r.id, title: r.title, flaggedAt: newest ? new Date(newest) : null, source: r.source };
  });

  return (
    <div className="max-w-4xl">
      <div className="mb-8">
        <h1 className="text-xl font-semibold text-foreground mb-1">Flagged</h1>
        <p className="text-sm text-muted-foreground">
          Articles users flagged as &quot;not positive news.&quot; These are LLM false positives — use them to spot patterns and update rejection rules.
        </p>
        {truncated && <p className="text-xs text-muted-foreground mt-1">Showing the latest {DISPLAY_LIMIT} flagged articles.</p>}
        <Link
          href={showResolved ? "/admin/flagged" : { pathname: "/admin/flagged", query: { resolved: "1" } }}
          className="inline-block mt-2 text-xs text-primary hover:underline"
        >
          {showResolved ? "Show unresolved only" : "Show all"}
        </Link>
      </div>

      {flagged.length === 0 ? (
        <p className="text-sm text-muted-foreground">{showResolved ? "No flagged articles yet." : "No unresolved flagged articles."}</p>
      ) : (
        <FlaggedTable articles={flagged} />
      )}
    </div>
  );
}

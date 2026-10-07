// app/admin/flagged/page.tsx
import Link from "next/link";
import { prisma } from "@/src/lib/prisma";
import { currentAdminAuthority } from "@/src/lib/labels";
import { FlaggedTable } from "./FlaggedClient";

export const dynamic = "force-dynamic";

async function getFlaggedArticles() {
  return prisma.article.findMany({
    where: { flaggedAt: { not: null } },
    orderBy: { flaggedAt: "desc" },
    take: 300,
    select: {
      id: true,
      title: true,
      flaggedAt: true,
      source: { select: { name: true, language: true } },
      labelEvents: {
        where: { source: "admin" },
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
        const authority = currentAdminAuthority(r.labelEvents);
        return !authority || (r.flaggedAt !== null && authority.createdAt < r.flaggedAt);
      });
  const flagged = visible.map((r) => ({ id: r.id, title: r.title, flaggedAt: r.flaggedAt, source: r.source }));

  return (
    <div className="max-w-4xl">
      <div className="mb-8">
        <h1 className="text-xl font-semibold text-foreground mb-1">Flagged</h1>
        <p className="text-sm text-muted-foreground">
          Articles users flagged as &quot;not positive news.&quot; These are LLM false positives — use them to spot patterns and update rejection rules.
        </p>
        <Link
          href={showResolved ? "/admin/flagged" : { pathname: "/admin/flagged", query: { resolved: "1" } }}
          className="inline-block mt-2 text-xs text-primary hover:underline"
        >
          {showResolved ? "Show unresolved only" : "Show resolved"}
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

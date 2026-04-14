// app/admin/flagged/page.tsx
import { prisma } from "@/src/lib/prisma";
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
    },
  });
}

export default async function FlaggedPage() {
  const flagged = await getFlaggedArticles();

  return (
    <div className="max-w-4xl">
      <div className="mb-8">
        <h1 className="text-xl font-semibold text-foreground mb-1">Flagged</h1>
        <p className="text-sm text-muted-foreground">
          Articles users flagged as &quot;not positive news.&quot; These are LLM false positives — use them to spot patterns and update rejection rules.
        </p>
      </div>

      {flagged.length === 0 ? (
        <p className="text-sm text-muted-foreground">No flagged articles yet.</p>
      ) : (
        <FlaggedTable articles={flagged} />
      )}
    </div>
  );
}

// app/admin/flagged/page.tsx
import { prisma } from "@/src/lib/prisma";
import { extractKeywords } from "@/src/lib/keywords";

export const dynamic = "force-dynamic";

function formatDate(date: Date): string {
  return new Date(date).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

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
        <div className="rounded-lg border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-secondary/60 border-b border-border text-xs text-muted-foreground">
                <th className="text-left px-4 py-2.5 font-medium">Title</th>
                <th className="text-left px-4 py-2.5 font-medium hidden sm:table-cell">Source</th>
                <th className="text-left px-4 py-2.5 font-medium hidden md:table-cell">Keywords extracted</th>
                <th className="text-right px-4 py-2.5 font-medium hidden sm:table-cell">Flagged</th>
              </tr>
            </thead>
            <tbody>
              {flagged.map((a, i) => {
                const keywords = extractKeywords(a.title, a.source.language ?? "en");
                return (
                  <tr
                    key={a.id}
                    className={`border-b border-border/60 last:border-0 ${i % 2 === 0 ? "" : "bg-background/50"}`}
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
                      {formatDate(a.flaggedAt!)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

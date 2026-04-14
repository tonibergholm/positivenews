// app/admin/rejections/page.tsx
import { prisma } from "@/src/lib/prisma";
import { RejectionsTable } from "./RejectionsClient";

export const dynamic = "force-dynamic";

async function getRejections() {
  return prisma.article.findMany({
    where: {
      isPositive: false,
      rejectionReason: { not: null },
    },
    orderBy: { createdAt: "desc" },
    take: 300,
    select: {
      id: true,
      title: true,
      rejectionReason: true,
      rejectionPass: true,
      createdAt: true,
      source: { select: { name: true } },
    },
  });
}

export default async function RejectionsPage() {
  const rejections = await getRejections();

  return (
    <div className="max-w-4xl">
      <div className="mb-8">
        <h1 className="text-xl font-semibold text-foreground mb-1">Rejections</h1>
        <p className="text-sm text-muted-foreground">
          Last 300 rejected articles with reason. Useful for spotting false positives.
        </p>
      </div>

      {rejections.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No rejections with reasons yet. Run the pipeline to populate this.
        </p>
      ) : (
        <RejectionsTable rejections={rejections} />
      )}
    </div>
  );
}

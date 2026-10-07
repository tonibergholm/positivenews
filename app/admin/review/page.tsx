// app/admin/review/page.tsx
import Link from "next/link";
import { loadNextCard } from "@/src/lib/review-queue-data";
import { DAILY_TARGET } from "@/src/lib/review-queue";
import { CATEGORIES } from "@/src/lib/jev";
import { ReviewCardView } from "./ReviewCard";
import { UndoLast } from "./UndoLast";

export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

export default async function ReviewPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const skip = new Set((one(params.skip) ?? "").split(",").filter(Boolean).slice(0, 200));
  const more = one(params.more) === "1";
  const { card, doneToday } = await loadNextCard({ exclude: skip, focus: one(params.focus) ?? null });
  const done = doneToday >= DAILY_TARGET && !more;
  const categories = Object.entries(CATEGORIES).map(([key, c]) => ({ key, label: c.label }));

  return (
    <div className="max-w-xl mx-auto">
      <div className="flex items-baseline justify-between mb-4">
        <h1 className="text-xl font-semibold text-foreground">Review</h1>
        <span className="text-sm text-muted-foreground tabular-nums">{doneToday} / {DAILY_TARGET} today</span>
      </div>

      {done ? (
        <div className="rounded-lg border border-border bg-card p-6 text-center">
          <p className="text-foreground font-medium">Done for today.</p>
          <p className="text-sm text-muted-foreground mt-1">Thanks — these decisions train and test the filter.</p>
          <Link href={{ pathname: "/admin/review", query: { more: "1" } }} className="inline-block mt-4 text-sm text-primary hover:underline">
            Keep going
          </Link>
          <UndoLast />
        </div>
      ) : card ? (
        <ReviewCardView key={`${card.articleId}:${one(params.t) ?? ""}`} card={card} categories={categories} skip={[...skip]} more={more} />
      ) : (
        <div>
          <p className="text-sm text-muted-foreground">Nothing to review right now.</p>
          <UndoLast />
        </div>
      )}

      <p className="text-xs text-muted-foreground mt-6">
        Decisions are final and update the feed immediately; readers with the feed already open see the change on their next load.
      </p>
    </div>
  );
}

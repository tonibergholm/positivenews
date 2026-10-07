"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { ReviewCard } from "@/src/lib/review-queue-data";
import { decideAction, undoAction, type Reveal } from "./actions";

interface Props {
  card: ReviewCard;
  categories: { key: string; label: string }[];
  skip: string[];
  more: boolean;
}

const LAST_KEY = "review:last"; // sessionStorage: { eventId, articleId }
const REVEAL_MS = 1500;
const LAST_EVENT = "review:last-changed";

function subscribeLast(cb: () => void) {
  window.addEventListener(LAST_EVENT, cb);
  return () => window.removeEventListener(LAST_EVENT, cb);
}
function setLast(value: string | null) {
  if (value === null) sessionStorage.removeItem(LAST_KEY);
  else sessionStorage.setItem(LAST_KEY, value);
  window.dispatchEvent(new Event(LAST_EVENT));
}

export function ReviewCardView({ card, categories, skip, more }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [picking, setPicking] = useState(false);
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canUndo = useSyncExternalStore(subscribeLast, () => sessionStorage.getItem(LAST_KEY) !== null, () => false);
  const busy = useRef(false);

  const go = useCallback(
    (extra: { skip?: string[]; focus?: string }) => {
      const query = new URLSearchParams();
      const s = extra.skip ?? skip;
      if (s.length) query.set("skip", s.join(","));
      if (more) query.set("more", "1");
      if (extra.focus) query.set("focus", extra.focus);
      const qs = query.toString();
      router.replace(qs ? `/admin/review?${qs}` : "/admin/review");
      router.refresh();
    },
    [router, skip, more],
  );

  const decide = useCallback(
    (verdict: "keep" | "reject", category: string | null) => {
      if (busy.current) return;
      busy.current = true;
      setError(null);
      startTransition(async () => {
        const r = await decideAction(card.articleId, verdict, category, card.bucket);
        if (!r.ok) {
          setError(r.error);
          busy.current = false;
          return;
        }
        setLast(JSON.stringify({ eventId: r.eventId, articleId: card.articleId }));
        setReveal(r.reveal);
        setTimeout(() => go({}), REVEAL_MS);
      });
    },
    [card, go],
  );

  const undo = useCallback(() => {
    const raw = sessionStorage.getItem(LAST_KEY);
    if (!raw || busy.current) return;
    const last = JSON.parse(raw) as { eventId: string; articleId: string };
    busy.current = true;
    startTransition(async () => {
      const r = await undoAction(last.eventId);
      setLast(null);
      if (!r.ok) {
        setError(r.error);
        busy.current = false;
        return;
      }
      go({ focus: last.articleId });
    });
  }, [go]);

  const skipCard = useCallback(() => go({ skip: [...skip, card.articleId] }), [go, skip, card.articleId]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey || reveal) return;
      if (picking) {
        if (e.key === "n" || e.key === "0") decide("reject", null);
        const n = Number(e.key);
        if (n >= 1 && n <= 9 && categories[n - 1]) decide("reject", categories[n - 1].key);
        if (e.key === "Escape") setPicking(false);
        return;
      }
      if (e.key === "k") decide("keep", null);
      else if (e.key === "r") setPicking(true);
      else if (e.key === "s") skipCard();
      else if (e.key === "u") undo();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [picking, reveal, categories, decide, skipCard, undo]);

  return (
    <article className="rounded-lg border border-border bg-card overflow-hidden">
      {card.imageUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={card.imageUrl} alt="" className="w-full h-48 object-cover" />
      )}
      <div className="p-4">
        <div className="text-xs text-muted-foreground mb-1">
          {card.sourceName} · {card.language.toUpperCase()}
        </div>
        <h2 className="font-heading text-lg leading-snug text-foreground">{card.title}</h2>
        {card.summary && <p className="text-sm text-muted-foreground mt-2 line-clamp-6">{card.summary}</p>}
        <a href={card.url} target="_blank" rel="noreferrer" className="inline-block mt-2 text-xs text-primary hover:underline">
          Open original ↗
        </a>
      </div>

      {reveal ? (
        <div className="border-t border-border bg-secondary/60 px-4 py-3 text-xs text-muted-foreground tabular-nums" role="status">
          Ollama: {reveal.ollama ?? "—"} · Keyword: {reveal.keyword ? "reject" : "—"} · Jev:{" "}
          {reveal.jev ? `${reveal.jev.keep ? "keep" : "reject"} (pos ${reveal.jev.positiveP.toFixed(2)}, upl ${reveal.jev.upliftingP.toFixed(2)}, ${reveal.jev.topCategory})` : "—"}
        </div>
      ) : picking ? (
        <div className="border-t border-border p-3">
          <div className="text-xs text-muted-foreground mb-2">Why reject? (optional)</div>
          <div className="flex flex-wrap gap-1.5">
            {categories.map((c, i) => (
              <button
                key={c.key}
                onClick={() => decide("reject", c.key)}
                disabled={pending}
                className="rounded-full bg-secondary px-2.5 py-1 text-xs text-foreground hover:bg-accent disabled:opacity-50"
              >
                {i < 9 ? <span className="text-muted-foreground mr-1">{i + 1}</span> : null}
                {c.label}
              </button>
            ))}
            <button
              onClick={() => decide("reject", null)}
              disabled={pending}
              className="rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground hover:bg-secondary disabled:opacity-50"
            >
              No category
            </button>
          </div>
        </div>
      ) : (
        <div className="border-t border-border grid grid-cols-3 gap-2 p-3">
          <button
            onClick={() => decide("keep", null)}
            disabled={pending}
            className="rounded-md bg-[#3d8b5e] py-3 text-sm font-semibold text-white disabled:opacity-50"
          >
            Keep
          </button>
          <button
            onClick={() => setPicking(true)}
            disabled={pending}
            className="rounded-md bg-destructive py-3 text-sm font-semibold text-white disabled:opacity-50"
          >
            Reject
          </button>
          <button
            onClick={skipCard}
            disabled={pending}
            className="rounded-md border border-border py-3 text-sm text-muted-foreground disabled:opacity-50"
          >
            Skip
          </button>
        </div>
      )}

      <div className="flex items-center justify-between px-4 pb-3 text-xs text-muted-foreground">
        <span className="hidden sm:inline">Keys: k keep · r reject (1–9, n) · s skip · u undo</span>
        <button onClick={undo} disabled={!canUndo || pending} className="hover:text-foreground disabled:opacity-40">
          Undo last
        </button>
      </div>
      {error && <p className="px-4 pb-3 text-xs text-destructive" role="alert">{error}</p>}
    </article>
  );
}

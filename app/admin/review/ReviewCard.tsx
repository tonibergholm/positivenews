"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { ReviewCard } from "@/src/lib/review-queue-data";
import { decideAction, undoAction, type Reveal } from "./actions";
import { hasRawLast, readLast, setLast, subscribeLast } from "./last-decision";

interface Props {
  card: ReviewCard;
  categories: { key: string; label: string }[];
  skip: string[];
  more: boolean;
  redecide: boolean;
}

const REVEAL_MS = 1500;
const TRANSIENT = "Network error — try again";

export function ReviewCardView({ card, categories, skip, more, redecide }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [picking, setPicking] = useState(false);
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canUndo = useSyncExternalStore(subscribeLast, () => readLast() !== null, () => false);
  const busy = useRef(false);
  const undoing = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  const firstChip = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
  }, []);

  useEffect(() => {
    if (picking) firstChip.current?.focus();
  }, [picking]);

  const go = useCallback(
    (extra: { skip?: string[]; focus?: string }) => {
      const query = new URLSearchParams();
      const s = extra.skip ?? skip;
      if (s.length) query.set("skip", s.join(","));
      if (more) query.set("more", "1");
      if (extra.focus) query.set("focus", extra.focus);
      query.set("t", String(Date.now())); // nonce: remount the card even if the same article comes back
      const qs = query.toString();
      router.replace(qs ? `/admin/review?${qs}` : "/admin/review");
      router.refresh();
    },
    [router, skip, more],
  );

  const skipCard = useCallback(() => go({ skip: [...skip, card.articleId] }), [go, skip, card.articleId]);

  const armTimer = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      go({});
    }, REVEAL_MS);
  }, [go]);

  const decide = useCallback(
    (verdict: "keep" | "reject", category: string | null) => {
      if (busy.current) return;
      busy.current = true;
      setError(null);
      startTransition(async () => {
        try {
          const r = await decideAction(card.articleId, verdict, category, card.bucket, redecide);
          if (!r.ok) {
            if (r.error === "Article not found" || r.error === "Already decided elsewhere") {
              // The article is gone (e.g. cleaned up) or another tab decided it; move on to the next card.
              busy.current = false;
              setTimeout(skipCard, 0); // outside the transition, like undo
              return;
            }
            setError(r.error);
            busy.current = false;
            return;
          }
          setLast({ eventId: r.eventId, articleId: card.articleId });
          if (!mounted.current) return;
          setReveal(r.reveal);
          armTimer();
        } catch {
          setError(TRANSIENT);
          busy.current = false;
        }
      });
    },
    [card, redecide, armTimer, skipCard],
  );

  const undo = useCallback(() => {
    // Allowed while busy only during the reveal (decision already saved).
    if (busy.current && !reveal) return;
    if (undoing.current) return; // one undo at a time
    const last = readLast();
    if (!last) {
      if (hasRawLast()) setLast(null);
      return;
    }
    const wasReveal = busy.current;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    busy.current = true;
    undoing.current = true;
    setError(null);
    startTransition(async () => {
      try {
        const r = await undoAction(last.eventId);
        if (!r.ok) {
          if (r.error === "Decision changed elsewhere" || r.error === "Decision not found") setLast(null);
          setError(r.error);
          busy.current = wasReveal;
          if (wasReveal && mounted.current) armTimer();
          return;
        }
        setLast(null);
        if (mounted.current) {
          setReveal(null);
          setPicking(false);
          setError(null);
        }
        busy.current = false;
        if (timer.current) clearTimeout(timer.current);
        timer.current = null;
        // Navigate outside this transition. Called inside it, router.replace + refresh
        // fetched the new page but never committed it, leaving `pending` stuck true.
        setTimeout(() => go({ focus: last.articleId }), 0);
      } catch {
        setError(TRANSIENT);
        busy.current = wasReveal;
        if (wasReveal && mounted.current) armTimer();
      } finally {
        undoing.current = false;
      }
    });
  }, [go, reveal, armTimer]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.repeat) return;
      if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey) return;
      if (busy.current) {
        if (reveal && e.key === "u") undo();
        return;
      }
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

      <div
        role="status"
        aria-live="polite"
        className={reveal ? "border-t border-border bg-secondary/60 px-4 py-3 text-xs text-muted-foreground tabular-nums" : "sr-only"}
      >
        {reveal && (
          <>
            Ollama: {reveal.ollama ?? "—"} · Keyword: {reveal.keyword ? "reject" : "—"} · Jev:{" "}
            {reveal.jev ? `${reveal.jev.keep ? "keep" : "reject"} (pos ${reveal.jev.positiveP.toFixed(2)}, upl ${reveal.jev.upliftingP.toFixed(2)}, ${reveal.jev.topCategory})` : "—"}
          </>
        )}
      </div>
      {reveal ? null : picking ? (
        <div className="border-t border-border p-3">
          <div className="text-xs text-muted-foreground mb-2">Why reject? (optional)</div>
          <div className="flex flex-wrap gap-1.5">
            {categories.map((c, i) => (
              <button
                key={c.key}
                ref={i === 0 ? firstChip : undefined}
                onClick={() => decide("reject", c.key)}
                disabled={pending}
                className="rounded-full bg-secondary px-3 py-2 min-h-10 text-xs text-foreground hover:bg-accent disabled:opacity-50"
              >
                {i < 9 ? <span className="text-muted-foreground mr-1">{i + 1}</span> : null}
                {c.label}
              </button>
            ))}
            <button
              onClick={() => decide("reject", null)}
              disabled={pending}
              className="rounded-full border border-border px-3 py-2 min-h-10 text-xs text-muted-foreground hover:bg-secondary disabled:opacity-50"
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
        <button onClick={undo} disabled={!canUndo || pending} className="min-h-10 px-3 hover:text-foreground disabled:opacity-40">
          Undo last
        </button>
      </div>
      {error && <p className="px-4 pb-3 text-xs text-destructive" role="alert">{error}</p>}
    </article>
  );
}

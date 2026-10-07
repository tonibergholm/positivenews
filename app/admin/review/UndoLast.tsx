"use client";

import { useRef, useState, useSyncExternalStore, useTransition } from "react";
import { useRouter } from "next/navigation";
import { undoAction } from "./actions";
import { hasRawLast, readLast, setLast, subscribeLast } from "./last-decision";

const TRANSIENT = "Network error — try again";

// Undo for the states with no card on screen ("Done for today", "Nothing to review").
export function UndoLast() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const canUndo = useSyncExternalStore(subscribeLast, () => readLast() !== null, () => false);
  const undoing = useRef(false);

  if (!canUndo) return null;

  function undo() {
    if (undoing.current) return;
    const last = readLast();
    if (!last) {
      if (hasRawLast()) setLast(null);
      return;
    }
    undoing.current = true;
    setError(null);
    startTransition(async () => {
      try {
        const r = await undoAction(last.eventId);
        if (!r.ok) {
          if (r.error === "Decision changed elsewhere" || r.error === "Decision not found") setLast(null);
          setError(r.error);
          return;
        }
        setLast(null);
        // Navigate outside the transition (see ReviewCard): inside it the refresh never commits.
        setTimeout(() => {
          router.replace(`/admin/review?focus=${encodeURIComponent(last.articleId)}&t=${Date.now()}`);
          router.refresh();
        }, 0);
      } catch {
        setError(TRANSIENT);
      } finally {
        undoing.current = false;
      }
    });
  }

  return (
    <div className="mt-3 text-center">
      <button onClick={undo} disabled={pending} className="min-h-10 px-3 text-xs text-muted-foreground hover:text-foreground disabled:opacity-40">
        Undo last
      </button>
      {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
    </div>
  );
}

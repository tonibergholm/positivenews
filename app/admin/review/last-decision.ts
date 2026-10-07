"use client";

// sessionStorage record of the last admin decision, shared by the review card and the empty states.
// Client-safe only: no server imports.

const LAST_KEY = "review:last"; // sessionStorage: { eventId, articleId }
const LAST_EVENT = "review:last-changed";

export interface LastDecision {
  eventId: string;
  articleId: string;
}

export function subscribeLast(cb: () => void) {
  window.addEventListener(LAST_EVENT, cb);
  return () => window.removeEventListener(LAST_EVENT, cb);
}

export function setLast(value: LastDecision | null) {
  if (value === null) sessionStorage.removeItem(LAST_KEY);
  else sessionStorage.setItem(LAST_KEY, JSON.stringify(value));
  window.dispatchEvent(new Event(LAST_EVENT));
}

export function readLast(): LastDecision | null {
  const raw = sessionStorage.getItem(LAST_KEY);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { eventId?: unknown; articleId?: unknown };
    if (typeof v?.eventId === "string" && typeof v?.articleId === "string") return { eventId: v.eventId, articleId: v.articleId };
  } catch {
    // bad JSON: treat as no last decision
  }
  return null;
}

/** True when sessionStorage holds something under the key, valid or not. */
export function hasRawLast(): boolean {
  return sessionStorage.getItem(LAST_KEY) !== null;
}

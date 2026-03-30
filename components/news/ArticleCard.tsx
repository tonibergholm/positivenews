"use client";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { timeAgo } from "@/src/lib/timeAgo";
import { ArticleWithSource } from "@/src/lib/types";
import { useState } from "react";

const CATEGORY_COLORS: Record<string, string> = {
  Science:     "bg-sky-100 text-sky-700 border-sky-200",
  Environment: "bg-emerald-100 text-emerald-700 border-emerald-200",
  Society:     "bg-violet-100 text-violet-700 border-violet-200",
  Health:      "bg-rose-100 text-rose-700 border-rose-200",
  Innovation:  "bg-amber-100 text-amber-700 border-amber-200",
};

const CATEGORY_PLACEHOLDERS: Record<string, string> = {
  Science:     "/news/placeholder-science.svg",
  Environment: "/news/placeholder-environment.svg",
  Society:     "/news/placeholder-society.svg",
  Health:      "/news/placeholder-health.svg",
  Innovation:  "/news/placeholder-innovation.svg",
};

interface ArticleCardProps {
  article: ArticleWithSource;
  onFlagged?: (id: string) => void;
}

export function ArticleCard({ article, onFlagged }: ArticleCardProps) {
  const badgeClass =
    CATEGORY_COLORS[article.category] ??
    "bg-gray-100 text-gray-700 border-gray-200";

  const placeholder =
    CATEGORY_PLACEHOLDERS[article.category] ?? "/news/placeholder-innovation.svg";

  const [imageSrc, setImageSrc] = useState(article.imageUrl ?? placeholder);
  const [flagging, setFlagging] = useState(false);
  const [hidden, setHidden] = useState(false);

  async function handleFlag(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (flagging) return;

    setFlagging(true);
    try {
      await fetch(`/news/api/articles/${article.id}/flag`, { method: "POST" });
      setHidden(true);
      onFlagged?.(article.id);
    } catch {
      // silently fail
    } finally {
      setFlagging(false);
    }
  }

  if (hidden) return null;

  return (
    <a
      href={article.url}
      target="_blank"
      rel="noopener noreferrer"
      className="group block h-full"
    >
      <Card className="relative h-full overflow-hidden transition-all duration-200 group-hover:shadow-md group-hover:-translate-y-0.5 border-border/60">
        <div className="relative h-44 w-full overflow-hidden bg-muted">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={imageSrc}
            alt=""
            className="absolute inset-0 h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
            onError={() => setImageSrc(placeholder)}
            loading="lazy"
          />

          {/* Flag button */}
          <button
            onClick={handleFlag}
            disabled={flagging}
            title="Not positive news"
            className="absolute top-2 right-2 z-10 flex items-center justify-center size-7 rounded-full bg-black/40 text-white/80 opacity-0 group-hover:opacity-100 hover:bg-black/60 hover:text-white transition-all backdrop-blur-sm"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 20 20"
              fill="currentColor"
              className="size-3.5"
            >
              <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
            </svg>
          </button>
        </div>

        <CardContent className="flex flex-col gap-2 p-4">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge
              variant="outline"
              className={`text-xs font-medium px-2 py-0.5 ${badgeClass}`}
            >
              {article.category}
            </Badge>
          </div>

          <h2 className="text-sm font-semibold leading-snug line-clamp-3 text-foreground group-hover:text-primary transition-colors">
            {article.title}
          </h2>

          {article.summary && (
            <p className="text-xs text-muted-foreground line-clamp-2 leading-relaxed">
              {article.summary}
            </p>
          )}

          <div className="mt-auto flex items-center justify-between pt-2 text-xs text-muted-foreground">
            <span className="font-medium truncate max-w-[60%]">
              {article.source.name}
            </span>
            <span>{timeAgo(article.publishedAt)}</span>
          </div>
        </CardContent>
      </Card>
    </a>
  );
}

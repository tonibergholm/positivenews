"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArticleCard } from "./ArticleCard";
import { ArticleCardSkeleton } from "./ArticleCardSkeleton";
import { CategoryFilter } from "./CategoryFilter";
import { CATEGORIES, type Category } from "@/src/config/sources";
import { ArticleWithSource } from "@/src/lib/types";

const SKELETONS = Array.from({ length: 12 }, (_, i) => i);

export function ArticleGrid() {
  const [category, setCategory] = useState<Category>("All");
  const [articles, setArticles] = useState<ArticleWithSource[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const fetchArticles = useCallback(
    async (cat: Category, p: number, replace: boolean) => {
      const params = new URLSearchParams({ page: String(p) });
      if (cat !== "All") params.set("category", cat);

      const res = await fetch(`/news/api/articles?${params}`);
      if (!res.ok) return;
      const data = await res.json();

      setArticles((prev) =>
        replace ? data.articles : [...prev, ...data.articles]
      );
      setTotalPages(data.pagination.totalPages);
    },
    []
  );

  // Initial load / category change
  useEffect(() => {
    setLoading(true);
    setPage(1);
    fetchArticles(category, 1, true).finally(() => setLoading(false));
  }, [category, fetchArticles]);

  // Infinite scroll observer
  useEffect(() => {
    if (!bottomRef.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && !loadingMore && page < totalPages) {
          const next = page + 1;
          setPage(next);
          setLoadingMore(true);
          fetchArticles(category, next, false).finally(() =>
            setLoadingMore(false)
          );
        }
      },
      { threshold: 0.1 }
    );
    observer.observe(bottomRef.current);
    return () => observer.disconnect();
  }, [bottomRef, category, fetchArticles, loadingMore, page, totalPages]);

  return (
    <div className="space-y-6">
      <CategoryFilter
        categories={CATEGORIES}
        active={category}
        onChange={(cat) => setCategory(cat as Category)}
      />

      {loading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {SKELETONS.map((i) => (
            <ArticleCardSkeleton key={i} />
          ))}
        </div>
      ) : articles.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <div className="text-5xl mb-4">🌱</div>
          <p className="text-lg font-medium text-muted-foreground">
            No articles yet for this category.
          </p>
          <p className="text-sm text-muted-foreground mt-1">
            Try triggering an ingest or check back soon.
          </p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {articles.map((article) => (
              <ArticleCard
                key={article.id}
                article={article}
                onFlagged={(id) =>
                  setArticles((prev) => prev.filter((a) => a.id !== id))
                }
              />
            ))}
          </div>

          {loadingMore && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {[0, 1, 2, 3].map((i) => (
                <ArticleCardSkeleton key={i} />
              ))}
            </div>
          )}

          <div ref={bottomRef} className="h-4" />
        </>
      )}
    </div>
  );
}

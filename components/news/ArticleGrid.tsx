"use client";

import { useEffect, useRef, useState } from "react";
import { ArticleCard } from "./ArticleCard";
import { ArticleCardSkeleton } from "./ArticleCardSkeleton";
import { CategoryFilter } from "./CategoryFilter";
import { CATEGORIES, type Category } from "@/src/config/sources";
import { ArticleWithSource, ArticlesResponse } from "@/src/lib/types";

const SKELETONS = Array.from({ length: 12 }, (_, i) => i);

export function ArticleGrid() {
  const [category, setCategory] = useState<Category>("All");
  const [articles, setArticles] = useState<ArticleWithSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const requestIdRef = useRef(0);
  const loadingMoreRef = useRef(false);
  const pageRef = useRef(1);
  const totalPagesRef = useRef(1);

  async function fetchArticles(cat: Category, p: number, replace: boolean) {
    const params = new URLSearchParams({ page: String(p) });
    if (cat !== "All") params.set("category", cat);

    const requestId = ++requestIdRef.current;
    const res = await fetch(`/news/api/articles?${params}`);
    if (!res.ok) throw new Error(`Failed to fetch articles: ${res.status}`);

    const data: ArticlesResponse = await res.json();

    if (requestId !== requestIdRef.current) return;

    setArticles((prev) => (replace ? data.articles : [...prev, ...data.articles]));
    totalPagesRef.current = data.pagination.totalPages;
    pageRef.current = p;
  }

  // Initial load / category change
  useEffect(() => {
    async function loadFirstPage() {
      loadingMoreRef.current = false;
      pageRef.current = 1;
      totalPagesRef.current = 1;
      setLoading(true);
      setArticles([]);

      try {
        await fetchArticles(category, 1, true);
      } catch {
        setArticles([]);
      } finally {
        setLoading(false);
      }
    }

    void loadFirstPage();
  }, [category]);

  // Infinite scroll observer
  useEffect(() => {
    if (!bottomRef.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries[0].isIntersecting) return;
        if (loading || loadingMoreRef.current) return;
        if (pageRef.current >= totalPagesRef.current) return;

        const next = pageRef.current + 1;
        loadingMoreRef.current = true;
        setLoadingMore(true);
        fetchArticles(category, next, false)
          .catch(() => {})
          .finally(() => {
            loadingMoreRef.current = false;
            setLoadingMore(false);
          });
      },
      { threshold: 0.1 }
    );
    observer.observe(bottomRef.current);
    return () => observer.disconnect();
  }, [bottomRef, category, loading]);

  return (
    <div className="space-y-6">
      <CategoryFilter
        categories={CATEGORIES}
        active={category}
        onChange={(cat) => setCategory(cat as Category)}
      />

      {loading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 sm:gap-4">
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
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 sm:gap-4">
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
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 sm:gap-4">
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

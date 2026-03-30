import { ArticleGrid } from "@/components/news/ArticleGrid";

export default function HomePage() {
  return (
    <div className="space-y-2">
      <div className="mb-6">
        <h1 className="font-heading text-2xl font-semibold tracking-tight text-foreground">
          Today&apos;s Good News
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Constructive, solutions-focused journalism from around the world.
        </p>
      </div>
      <ArticleGrid />
    </div>
  );
}

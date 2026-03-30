import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { timeAgo } from "@/src/lib/timeAgo";
import { ArticleWithSource } from "@/src/lib/types";
import Image from "next/image";

const CATEGORY_COLORS: Record<string, string> = {
  Science:     "bg-sky-100 text-sky-700 border-sky-200",
  Environment: "bg-emerald-100 text-emerald-700 border-emerald-200",
  Society:     "bg-violet-100 text-violet-700 border-violet-200",
  Health:      "bg-rose-100 text-rose-700 border-rose-200",
  Innovation:  "bg-amber-100 text-amber-700 border-amber-200",
};

const CATEGORY_PLACEHOLDERS: Record<string, string> = {
  Science:     "/placeholder-science.svg",
  Environment: "/placeholder-environment.svg",
  Society:     "/placeholder-society.svg",
  Health:      "/placeholder-health.svg",
  Innovation:  "/placeholder-innovation.svg",
};

interface ArticleCardProps {
  article: ArticleWithSource;
}

export function ArticleCard({ article }: ArticleCardProps) {
  const badgeClass =
    CATEGORY_COLORS[article.category] ??
    "bg-gray-100 text-gray-700 border-gray-200";

  const imageSrc =
    article.imageUrl ??
    CATEGORY_PLACEHOLDERS[article.category] ??
    "/placeholder-innovation.svg";

  return (
    <a
      href={article.url}
      target="_blank"
      rel="noopener noreferrer"
      className="group block h-full"
    >
      <Card className="h-full overflow-hidden transition-all duration-200 group-hover:shadow-md group-hover:-translate-y-0.5 border-border/60">
        <div className="relative h-44 w-full overflow-hidden bg-muted">
          <Image
            src={imageSrc}
            alt=""
            fill
            className="object-cover transition-transform duration-300 group-hover:scale-105"
            sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
            unoptimized
          />
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

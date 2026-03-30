export interface ArticleWithSource {
  id: string;
  title: string;
  url: string;
  summary: string | null;
  imageUrl: string | null;
  publishedAt: string; // ISO string from JSON
  category: string;
  isPositive: boolean;
  createdAt: string;
  source: {
    name: string;
    category: string;
  };
}

export interface ArticlesResponse {
  articles: ArticleWithSource[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
}

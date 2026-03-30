export type Category =
  | "All"
  | "Science"
  | "Environment"
  | "Society"
  | "Health"
  | "Innovation";

export interface FeedSource {
  name: string;
  url: string;
  category: Exclude<Category, "All">;
  language: string;
}

export const FEED_SOURCES: FeedSource[] = [
  // Global wellbeing / uplifting news
  {
    name: "Good News Network",
    url: "https://www.goodnewsnetwork.org/feed/",
    category: "Society",
    language: "en",
  },
  {
    name: "Positive News",
    url: "https://www.positive.news/feed/",
    category: "Society",
    language: "en",
  },
  {
    name: "Reasons to be Cheerful",
    url: "https://reasonstobecheerful.world/feed/",
    category: "Society",
    language: "en",
  },
  {
    name: "Upworthy",
    url: "https://www.upworthy.com/rss",
    category: "Society",
    language: "en",
  },
  // Science & health breakthroughs
  {
    name: "Science Daily – Health",
    url: "https://www.sciencedaily.com/rss/health_medicine.xml",
    category: "Health",
    language: "en",
  },
  {
    name: "Science Daily – Science",
    url: "https://www.sciencedaily.com/rss/top/science.xml",
    category: "Science",
    language: "en",
  },
  {
    name: "WebMD Health News",
    url: "https://rssfeeds.webmd.com/rss/rss.aspx?RSSSource=RSS_PUBLIC",
    category: "Health",
    language: "en",
  },
  {
    name: "New Scientist – Health",
    url: "https://www.newscientist.com/subject/health/feed/",
    category: "Health",
    language: "en",
  },
  {
    name: "Popular Science",
    url: "https://www.popsci.com/feed/",
    category: "Science",
    language: "en",
  },
  // Environmental wins
  {
    name: "Positive.news – Environment",
    url: "https://www.positive.news/environment/feed/",
    category: "Environment",
    language: "en",
  },
  {
    name: "EcoWatch",
    url: "https://www.ecowatch.com/feeds/latest.rss",
    category: "Environment",
    language: "en",
  },
  {
    name: "Mongabay – Conservation",
    url: "https://news.mongabay.com/feed/",
    category: "Environment",
    language: "en",
  },
  // Social innovation & human progress
  {
    name: "Fast Company – Innovation",
    url: "https://www.fastcompany.com/latest/rss",
    category: "Innovation",
    language: "en",
  },
  {
    name: "The Optimist Daily",
    url: "https://www.optimistdaily.com/feed/",
    category: "Society",
    language: "en",
  },
  {
    name: "YES! Magazine",
    url: "https://www.yesmagazine.org/rss/",
    category: "Society",
    language: "en",
  },
  {
    name: "Springwise",
    url: "https://www.springwise.com/feed/",
    category: "Innovation",
    language: "en",
  },
  {
    name: "The Guardian – Environment",
    url: "https://www.theguardian.com/environment/rss",
    category: "Environment",
    language: "en",
  },
  {
    name: "Wired – Science",
    url: "https://www.wired.com/feed/category/science/latest/rss",
    category: "Science",
    language: "en",
  },
];

export const CATEGORIES: Category[] = [
  "All",
  "Science",
  "Environment",
  "Society",
  "Health",
  "Innovation",
];

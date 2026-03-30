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
  /** true = curated positive-news outlet; skip LLM classification */
  trusted?: boolean;
}

export const FEED_SOURCES: FeedSource[] = [
  // Global wellbeing / uplifting news — curated sources, always positive
  {
    name: "Good News Network",
    url: "https://www.goodnewsnetwork.org/feed/",
    category: "Society",
    language: "en",
    trusted: true,
  },
  {
    name: "Positive News",
    url: "https://www.positive.news/feed/",
    category: "Society",
    language: "en",
    trusted: true,
  },
  {
    name: "Reasons to be Cheerful",
    url: "https://reasonstobecheerful.world/feed/",
    category: "Society",
    language: "en",
    trusted: true,
  },
  {
    name: "Upworthy",
    url: "https://www.upworthy.com/rss",
    category: "Society",
    language: "en",
    trusted: true,
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
    trusted: true,
  },
  {
    name: "YES! Magazine",
    url: "https://www.yesmagazine.org/rss/",
    category: "Society",
    language: "en",
    trusted: true,
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
  // Finnish sources
  {
    name: "Yle Uutiset",
    url: "https://feeds.yle.fi/uutiset/v1/recent.rss?publisherIds=YLE_UUTISET",
    category: "Society",
    language: "fi",
  },
  {
    name: "Yle Kotimaa",
    url: "https://feeds.yle.fi/uutiset/v1/recent.rss?publisherIds=YLE_UUTISET&concepts=18-34837",
    category: "Society",
    language: "fi",
  },
  {
    name: "Yle Kulttuuri",
    url: "https://feeds.yle.fi/uutiset/v1/recent.rss?publisherIds=YLE_UUTISET&concepts=18-35128",
    category: "Society",
    language: "fi",
  },
  {
    name: "Yle Ulkomaat",
    url: "https://feeds.yle.fi/uutiset/v1/recent.rss?publisherIds=YLE_UUTISET&concepts=18-34953",
    category: "Society",
    language: "fi",
  },
  {
    name: "Helsingin Sanomat",
    url: "https://www.hs.fi/rss/tuoreimmat.xml",
    category: "Society",
    language: "fi",
  },
  {
    name: "Ilta-Sanomat – Tiede",
    url: "https://www.is.fi/rss/tiede.xml",
    category: "Science",
    language: "fi",
  },
  {
    name: "Ilta-Sanomat – Terveys",
    url: "https://www.is.fi/rss/terveys.xml",
    category: "Health",
    language: "fi",
  },
  {
    name: "Tekniikka&Talous",
    url: "https://www.tekniikkatalous.fi/api/feed/v2/rss/tt",
    category: "Innovation",
    language: "fi",
  },
  {
    name: "Tivi",
    url: "https://www.tivi.fi/api/feed/v2/rss/tv",
    category: "Innovation",
    language: "fi",
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

"use client";

import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

const CATEGORY_EMOJI: Record<string, string> = {
  All:         "✨",
  Science:     "🔬",
  Environment: "🌿",
  Society:     "🤝",
  Health:      "💚",
  Innovation:  "💡",
};

interface CategoryFilterProps {
  categories: string[];
  active: string;
  onChange: (category: string) => void;
}

export function CategoryFilter({
  categories,
  active,
  onChange,
}: CategoryFilterProps) {
  return (
    <Tabs value={active} onValueChange={onChange}>
      <TabsList className="h-auto flex flex-wrap gap-1 bg-muted/60 p-1">
        {categories.map((cat) => (
          <TabsTrigger
            key={cat}
            value={cat}
            className="text-sm data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
          >
            {CATEGORY_EMOJI[cat]} {cat}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}

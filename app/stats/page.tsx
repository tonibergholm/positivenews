import type { Metadata } from "next";
import { StatsView } from "@/components/news/StatsView";

export const metadata: Metadata = {
  title: "Pipeline Stats — PositiveNews",
  description: "Live operational metrics for the PositiveNews pipeline.",
};

export default function StatsPage() {
  return <StatsView />;
}

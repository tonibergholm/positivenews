import type { ArticleInput } from "./types";

// ── Shared rejection rules (used in both Pass 1 and Pass 2) ──────────

const SHARED_REJECTION_RULES = [
  "Sports roster moves, transfers, coaching changes, retirements, lawsuits — only genuine triumphs count",
  "Sports scores, doping, league standings, match results",
  "Shopping sales and promotions (spring sale, Amazon deals, deal of the day, best price)",
  "Consumer product reviews, upgrades, or best-of roundups",
  "Crossword puzzles, quizzes, games, horoscopes — not news",
  "Entrepreneurship clickbait (dare to start, how companies fail, why you should start a business)",
  "CEO interview roundups and what-leaders-said puff pieces",
  "Rising costs, price increases, inflation, affordability complaints",
  "Political threats, sanctions, military activity (fighter jets, drones, air space violations, defense exercises)",
  "Administrative/bureaucratic disputes and legal complaints",
  "Health scares: anti-vaccination trends, disease outbreaks, declining health stats",
  "Cancelled events, illness of politicians or public figures",
  "Layoffs, firings, job cuts, restructuring",
  "Court verdicts, criminal convictions, sentencing, discrimination cases",
  "Police investigations, data breaches, leaked personal data",
  "Animal attacks on people",
  "Constitutional/privacy law debates, governance criticism",
  "Sports investigations and misconduct probes",
  "Conflict of interest stories, cronyism, insider appointments",
  "Environmental LOSS, alarm, or wildlife CRIME stories (illegal trade, poaching)",
  "Clickbait listicles with no real substance",
].map((r) => `- ${r}`).join("\n");

// ── Prompts ──────────────────────────────────────────────────────────

export function buildPass1Prompt(articles: ArticleInput[]): string {
  const items = articles
    .map((a, i) => {
      const lang = a.language === "fi" ? "FI" : "EN";
      const summary = a.summary ? ` — ${a.summary.slice(0, 150)}` : "";
      return `${i + 1}. id:${a.id} [${lang}] "${a.title}"${summary}`;
    })
    .join("\n");

  return `You are a STRICT Positive News curator. Your job is to ONLY let through news that makes a reader feel inspired, hopeful, or calm. When in doubt, REJECT.

INCLUDE (positive = true) — ONLY these:
- Solutions journalism: people or organizations actively solving real problems
- Scientific breakthroughs: medicine, space, green energy, technology that benefits humanity
- Acts of kindness: heroism, community support, altruism
- Environmental recovery: wildlife rebounding, reforestation, climate goals met
- Cultural/sports triumphs: uplifting ACHIEVEMENTS (winning, records, overcoming adversity) — NOT roster moves, transfers, or retirements
- Finnish specifics: "sisu" stories, community successes, innovations, nature conservation
- Practical wellness: health tips, well-being advice that helps people

EXCLUDE (positive = false) — be aggressive here:
- ANY mention of war, military threats, geopolitics, territorial disputes, sanctions, or drones/missiles
- ANY mention of Trump, Putin, or other politicians in conflict/threat context
- Violent crime, political bickering, government disputes, legal complaints
- Rage-bait, scandals, celebrity gossip
- Alarmist headlines (even if story is neutral)
- Tragic accidents, water damage, insurance disputes (even with a silver lining)
- Opinion pieces, columns, editorials about societal problems
- Error reports, corrections, failures
${SHARED_REJECTION_RULES}
- Generic product news, consumer reviews, Amazon sales, shopping deals

Return ONLY this JSON: {"results": [{"id": "...", "positive": true/false, "reason": "brief reason"}]}

Articles:
${items}`;
}

export function buildPass2Prompt(articles: ArticleInput[]): string {
  const items = articles
    .map((a, i) => {
      const summary = a.summary ? ` — ${a.summary.slice(0, 150)}` : "";
      return `${i + 1}. id:${a.id} "${a.title}"${summary}`;
    })
    .join("\n");

  return `You are the FINAL quality gate for a Positive News feed. These articles already passed an initial check. Apply the STRICTEST filter. When in doubt, REJECT.

Ask yourself: "Would this make someone smile, feel hopeful, or learn something good?" If not, reject it.

KEEP ONLY articles that are:
- Genuinely uplifting: real human achievement, community success, scientific progress
- Helpful to people: practical wellness, health breakthroughs, solutions to real problems
- Something to be proud of: innovation that helps humanity, environmental wins, acts of kindness
- Good business news ONLY IF it directly creates jobs, clean energy, or accessibility for people

REJECT everything else, including:
- Marketing disguised as news (product launches, brand collaborations, celebrity collections)
- Generic business deals, contracts, or corporate transactions
- Business thought-leader puff pieces ("insights from CEO X", "future of business")
- Labor disputes, strikes, union conflicts without resolution
- Dangerous roads, safety hazards, infrastructure failures
- Tech platform problems (spam, abuse, outages)
- Stories about errors, failures, corrections, or things getting worse
${SHARED_REJECTION_RULES}
- "Your X is ugly / broken, this company wants to fix it" — product marketing

Return ONLY this JSON: {"results": [{"id": "...", "keep": true/false, "reason": "brief reason"}]}

Articles:
${items}`;
}

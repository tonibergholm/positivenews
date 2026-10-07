/**
 * Sends fixed FI/EN headlines to Jev and prints each verdict. Stores nothing.
 * Use it to eyeball behaviour after changing the question set.
 *
 * Usage: pnpm jev:smoke
 */
import "./load-env";
import { deriveVerdict, evaluateArticle, isJevConfigured, type JevArticle } from "../src/lib/jev";

const FIXTURES: Array<JevArticle & { lang: "en" | "fi"; expectKeep: boolean }> = [
  { lang: "en", expectKeep: true, title: "Scientists restore sight to blind patients with gene therapy" },
  { lang: "en", expectKeep: true, title: "Volunteers plant one million trees to revive drought-hit forest" },
  { lang: "en", expectKeep: true, title: "Teenager breaks world record to win first Olympic gold for her country" },
  { lang: "en", expectKeep: false, title: "Three killed as fighter jets clash over disputed border" },
  { lang: "en", expectKeep: false, title: "Manchester United complete £60m transfer of striker" },
  { lang: "en", expectKeep: false, title: "Amazon spring sale: best deals on headphones today" },
  { lang: "en", expectKeep: false, title: "Opinion: Our cities are failing the people who live in them" },
  { lang: "fi", expectKeep: true, title: "Suomalaistutkijat kehittivät uuden menetelmän muovin kierrättämiseen" },
  { lang: "fi", expectKeep: true, title: "Kyläyhdistys kunnosti vanhan koulun nuorten kohtaamispaikaksi" },
  { lang: "fi", expectKeep: false, title: "Susijahti alkaa – Lappiin myönnettiin kaatolupia 20 sudelle" },
  { lang: "fi", expectKeep: false, title: "Kolari valtatiellä: kaksi kuoli" },
  { lang: "fi", expectKeep: false, title: "Kolumni: Hyvinvointivaltio murenee käsiin" },
];

async function main() {
  if (!isJevConfigured()) {
    console.error("TYPESAFE_API_KEY is not set (.env.local or .env)");
    process.exit(1);
  }

  let mismatches = 0;
  for (const f of FIXTURES) {
    const r = await evaluateArticle(f);
    const v = deriveVerdict(r);
    const ok = v.keep === f.expectKeep;
    if (!ok) mismatches++;
    console.log(
      `${ok ? "ok  " : "MISS"} [${f.lang}] ${v.keep ? "keep  " : "reject"} ` +
        `pos=${r.positiveP.toFixed(2)} upl=${r.upliftingP.toFixed(2)} ` +
        `top=${r.topCategory}:${r.topCategoryP.toFixed(2)} ${r.latencyMs}ms  ${f.title}`,
    );
  }
  console.log(`\n${FIXTURES.length - mismatches}/${FIXTURES.length} matched expectations (model ${process.env.TYPESAFE_DEFAULT_MODEL ?? "jev-1.13.0"})`);
}

main().catch((err) => {
  console.error("Smoke run failed:", err);
  process.exit(1);
});

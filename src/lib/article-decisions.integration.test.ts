import { describe, expect, it, beforeAll, afterAll } from "vitest";

// Opt-in only: this suite writes and deletes rows. Never point DATABASE_URL at production.
const hasDb = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("article-decisions (integration)", () => {
  // Imported lazily so the suite never touches prisma without a database.
  let prisma: typeof import("./prisma").prisma;
  let d: typeof import("./article-decisions");
  let sourceId: string;
  const created: string[] = [];

  beforeAll(async () => {
    ({ prisma } = await import("./prisma"));
    d = await import("./article-decisions");
    const s = await prisma.source.upsert({
      where: { url: "https://test.invalid/feed" },
      update: {},
      create: { name: "Test", url: "https://test.invalid/feed", category: "Society", language: "en" },
    });
    sourceId = s.id;
  });

  afterAll(async () => {
    await prisma.article.deleteMany({ where: { id: { in: created } } });
    await prisma.$disconnect();
  });

  async function article(): Promise<string> {
    const a = await prisma.article.create({
      data: { title: "T", url: `https://test.invalid/${Date.now()}-${Math.random()}`, publishedAt: new Date(), sourceId, category: "Society" },
    });
    created.push(a.id);
    return a.id;
  }

  it("an admin keep survives a concurrent Ollama reject, in either order", async () => {
    for (let i = 0; i < 5; i++) {
      const id = await article();
      await Promise.all([
        d.recordAdminDecision(id, "keep", { bucket: "leak", actor: "admin@test" }),
        d.recordOllamaResult(id, { outcome: "judged_reject", reason: "war", pass: 1 }, "gemma3:4b"),
      ]);
      const a = await prisma.article.findUniqueOrThrow({ where: { id } });
      expect(a.isPositive).toBe(true);
      expect(a.rejectionPass).toBeNull();
      const events = await prisma.labelEvent.findMany({ where: { articleId: id } });
      expect(events.map((e) => e.source).sort()).toEqual(["admin", "ollama"]);
    }
  });

  it("undo restores the previous state; a stale undo is refused", async () => {
    const id = await article();
    const first = await d.recordAdminDecision(id, "reject", { category: "cat_war", bucket: "leak", actor: "a" });
    expect(first.status).toBe("ok");
    let a = await prisma.article.findUniqueOrThrow({ where: { id } });
    expect(a).toMatchObject({ isPositive: false, rejectionPass: 3, rejectionReason: "admin: war / military / geopolitics" });

    const second = await d.recordAdminDecision(id, "keep", { bucket: "manual", actor: "a" });
    if (first.status !== "ok" || second.status !== "ok") throw new Error("setup");
    expect(await d.retractAdminDecision(first.eventId, "a")).toBe("stale");

    expect(await d.retractAdminDecision(second.eventId, "a")).toBe("ok");
    a = await prisma.article.findUniqueOrThrow({ where: { id } });
    expect(a).toMatchObject({ isPositive: false, rejectionPass: 3 });
  });

  it("reader flags: one vote per actor, hide once, no hide after an admin keep", async () => {
    const id = await article();
    let hides = 0;
    const onHide = async () => { hides++; };
    expect(await d.recordReaderFlag(id, "h1", onHide)).toBe("hidden");
    expect(await d.recordReaderFlag(id, "h1", onHide)).toBe("duplicate");
    expect(await d.recordReaderFlag(id, "h2", onHide)).toBe("recorded");
    expect(hides).toBe(1);

    const kept = await article();
    await d.recordAdminDecision(kept, "keep", { bucket: "manual", actor: "a" });
    expect(await d.recordReaderFlag(kept, "h3", onHide)).toBe("recorded");
    expect((await prisma.article.findUniqueOrThrow({ where: { id: kept } })).isPositive).toBe(true);
  });

  it("ineligible Ollama outcomes are recorded as keeps with eligible=false", async () => {
    const id = await article();
    expect(await d.recordOllamaResult(id, { outcome: "missing_result", reason: "missing result", pass: 2 }, "m")).toBe("applied");
    const e = await prisma.labelEvent.findFirstOrThrow({ where: { articleId: id } });
    expect(e).toMatchObject({ source: "ollama", verdict: "keep", eligible: false });
    expect((await prisma.article.findUniqueOrThrow({ where: { id } })).curatedAt).not.toBeNull();
  });
});

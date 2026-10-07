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

  // Holds the article row lock, queues two writers behind it in a known order, then releases.
  async function queuedBehindLock(id: string, first: () => Promise<unknown>, second: () => Promise<unknown>) {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const holding = new Promise<void>((r) => (locked = r));
    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Article" WHERE id = ${id} FOR UPDATE`;
        locked();
        await gate;
      },
      { timeout: 20_000 },
    );
    await holding;
    const a = first();
    await new Promise((r) => setTimeout(r, 100));
    const b = second();
    await new Promise((r) => setTimeout(r, 100));
    release();
    await holder;
    return Promise.all([a, b]);
  }

  it("Ollama queued behind the lock before an admin keep: the keep lands last and wins", async () => {
    const id = await article();
    const [ollama] = await queuedBehindLock(
      id,
      () => d.recordOllamaResult(id, { outcome: "judged_reject", reason: "war", pass: 1 }, "gemma3:4b"),
      () => d.recordAdminDecision(id, "keep", { bucket: "manual", actor: "admin@test" }),
    );
    expect(ollama).toBe("applied");
    const a = await prisma.article.findUniqueOrThrow({ where: { id } });
    expect(a.isPositive).toBe(true);
    expect(a.rejectionPass).toBeNull();
  });

  it("admin keep queued behind the lock before Ollama: authority is checked inside the lock", async () => {
    const id = await article();
    const [, ollama] = await queuedBehindLock(
      id,
      () => d.recordAdminDecision(id, "keep", { bucket: "manual", actor: "admin@test" }),
      () => d.recordOllamaResult(id, { outcome: "judged_reject", reason: "war", pass: 1 }, "gemma3:4b"),
    );
    expect(ollama).toBe("recorded_only");
    const a = await prisma.article.findUniqueOrThrow({ where: { id } });
    expect(a.isPositive).toBe(true);
    expect(a.rejectionPass).toBeNull();
  });

  it("requireUndecided: the second decision is refused, a redecide is allowed", async () => {
    const id = await article();
    const first = await d.recordAdminDecision(id, "keep", { bucket: "leak", actor: "a", requireUndecided: true });
    expect(first.status).toBe("ok");
    const second = await d.recordAdminDecision(id, "reject", { bucket: "leak", actor: "b", requireUndecided: true });
    expect(second.status).toBe("already_decided");
    expect((await prisma.article.findUniqueOrThrow({ where: { id } })).isPositive).toBe(true);
    const third = await d.recordAdminDecision(id, "reject", { bucket: "leak", actor: "b" });
    expect(third.status).toBe("ok");
  });
});

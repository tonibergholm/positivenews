import { afterEach, expect, it, vi } from "vitest";
import { runPipeline } from "./pipeline";
import { shadowEvaluate } from "./jev-shadow";

vi.mock("./curate", () => ({ curateUnchecked: vi.fn().mockResolvedValue({ curated: 0, rejected: 0, skipped: 0 }) }));
vi.mock("./ingest", () => ({ ingestAll: vi.fn().mockResolvedValue({ total: 0, errors: [] }) }));
vi.mock("./keywords-maintenance", () => ({ deactivateStaleKeywords: vi.fn(), activatePendingKeywords: vi.fn() }));
vi.mock("./jev-shadow", () => ({ shadowEvaluate: vi.fn() }));
afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); });

it("runs shadow evaluation even when Jev is primary", async () => {
  vi.stubEnv("CURATOR_PROVIDER", "jev");
  await runPipeline();
  expect(shadowEvaluate).toHaveBeenCalledWith({ since: expect.any(Date), limit: 100, budgetMs: 90000 });
});

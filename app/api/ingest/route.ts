import { NextRequest, NextResponse } from "next/server";
import { isPipelineRunning, runPipeline } from "@/src/lib/pipeline";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // LLM curation can take a while on CPU

export async function POST(request: NextRequest) {
  const secret = process.env.INGEST_SECRET;
  if (!secret || request.headers.get("x-ingest-secret") !== secret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (isPipelineRunning()) {
    return NextResponse.json(
      { success: false, error: "Ingest already running" },
      { status: 409 }
    );
  }

  try {
    return NextResponse.json({
      success: true,
      ...(await runPipeline()),
    });
  } catch (err) {
    console.error("[/api/ingest]", err);
    return NextResponse.json({ success: false, error: "Ingest failed" }, { status: 500 });
  }
}

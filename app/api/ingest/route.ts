import { NextRequest, NextResponse } from "next/server";
import { ingestAll } from "@/src/lib/ingest";
import { curateUnchecked } from "@/src/lib/curate";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // LLM curation can take a while on CPU

export async function POST(request: NextRequest) {
  const secret = process.env.INGEST_SECRET;
  if (!secret || request.headers.get("x-ingest-secret") !== secret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const ingestResult = await ingestAll();
    const curationResult = await curateUnchecked();
    return NextResponse.json({
      success: true,
      ...ingestResult,
      curation: curationResult,
    });
  } catch (err) {
    console.error("[/api/ingest]", err);
    return NextResponse.json({ success: false, error: "Ingest failed" }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from "next/server";
import { ingestAll } from "@/src/lib/ingest";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  const secret = process.env.INGEST_SECRET;
  if (!secret || request.headers.get("x-ingest-secret") !== secret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await ingestAll();
    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    console.error("[/api/ingest]", err);
    return NextResponse.json({ success: false, error: "Ingest failed" }, { status: 500 });
  }
}

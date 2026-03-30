import { NextResponse } from "next/server";
import { ingestAll } from "@/src/lib/ingest";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST() {
  try {
    const result = await ingestAll();
    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    console.error("[/api/ingest]", err);
    return NextResponse.json(
      { success: false, error: String(err) },
      { status: 500 }
    );
  }
}

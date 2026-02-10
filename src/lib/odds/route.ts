// src/app/api/odds/route.ts
import { NextResponse } from "next/server";
import { fetchNbaOdds } from "@/lib/odds/theOddsApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const odds = await fetchNbaOdds({ useConsensus: false });

  return NextResponse.json(
    {
      ok: true,
      count: odds.events.length,
      sample: odds.events.slice(0, 3),
      odds,
    },
    { status: 200, headers: { "Cache-Control": "no-store" } }
  );
}

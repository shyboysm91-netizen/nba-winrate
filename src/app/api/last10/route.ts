import { NextResponse } from "next/server";
import { requirePaid } from "@/lib/subscription/requirePaid";
import { fetchNBATeamLast10 } from "@/lib/nba/espn";

export async function GET(req: Request) {
  const gate = await requirePaid();
  if (!gate.ok) {
    return NextResponse.json(
      { ok: false, error: gate.message },
      { status: gate.status }
    );
  }

  const { searchParams } = new URL(req.url);
  const teamId = searchParams.get("teamId");

  if (!teamId) {
    return NextResponse.json(
      { ok: false, error: "teamId 쿼리가 필요합니다. 예: /api/last10?teamId=14" },
      { status: 400 }
    );
  }

  try {
    const data = await fetchNBATeamLast10(teamId);
    return NextResponse.json({ ok: true, ...data });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: String(e?.message ?? e) },
      { status: 500 }
    );
  }
}

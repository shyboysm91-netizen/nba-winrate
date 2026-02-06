import { NextResponse } from "next/server";
import { requirePaid } from "@/lib/subscription/requirePaid";
import { analyzeGame } from "@/lib/analysis/analyzeGame";

export async function GET(req: Request) {
  const gate = await requirePaid();
  if (!gate.ok) {
    return NextResponse.json(
      { ok: false, error: gate.message },
      { status: gate.status }
    );
  }

  const { searchParams } = new URL(req.url);

  const homeTeamId = searchParams.get("homeTeamId") || "";
  const awayTeamId = searchParams.get("awayTeamId") || "";

  const spreadHomeRaw = searchParams.get("spreadHome"); // 예: -5.5
  const totalRaw = searchParams.get("total"); // 예: 228.5

  if (!homeTeamId || !awayTeamId) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "homeTeamId, awayTeamId가 필요합니다. 예: /api/analysis?homeTeamId=14&awayTeamId=13&spreadHome=-5.5&total=228.5",
      },
      { status: 400 }
    );
  }

  const spreadHome =
    spreadHomeRaw != null && spreadHomeRaw !== ""
      ? Number(spreadHomeRaw)
      : undefined;

  const total =
    totalRaw != null && totalRaw !== "" ? Number(totalRaw) : undefined;

  try {
    const result = await analyzeGame({
      homeTeamId,
      awayTeamId,
      spreadHome: Number.isFinite(spreadHome as any) ? spreadHome : undefined,
      total: Number.isFinite(total as any) ? total : undefined,
    });

    return NextResponse.json({ ok: true, result });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: String(e?.message ?? e) },
      { status: 500 }
    );
  }
}

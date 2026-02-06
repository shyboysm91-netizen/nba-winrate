// src/app/api/odds/route.ts
import { NextResponse } from "next/server";
import { fetchNbaOdds, kstDateFromIso } from "@/lib/odds/theOddsApi";

export const runtime = "nodejs";

function json(data: unknown, init?: ResponseInit) {
  return NextResponse.json(data, {
    ...init,
    headers: {
      "cache-control": "no-store",
      ...(init?.headers ?? {}),
    },
  });
}

/**
 * GET /api/odds?date=YYYY-MM-DD&useConsensus=0|1
 * - date 없으면: KST 기준 "내일" 날짜로 필터
 * - 반환: 해당 KST 날짜의 이벤트만
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);

  const date = searchParams.get("date"); // YYYY-MM-DD (KST 기준)
  const useConsensus = searchParams.get("useConsensus") === "1";

  const now = new Date();
  const kstToday = now.toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
  const kstTomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000).toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });

  const target = date ?? kstTomorrow;

  try {
    const odds = await fetchNbaOdds({
      useConsensus,
      // regions/markets/oddsFormat 등은 env로 제어 가능
    });

    const filtered = odds.events.filter((e) => kstDateFromIso(e.commenceTime) === target);

    return json({
      ok: true,
      targetKstDate: target,
      kstToday,
      kstTomorrow,
      source: odds.source,
      sportKey: odds.sportKey,
      fetchedAt: odds.fetchedAt,
      usage: odds.usage,
      count: filtered.length,
      events: filtered,
    });
  } catch (e: any) {
    return json(
      {
        ok: false,
        error: e?.message ?? "Unknown error",
      },
      { status: 500 }
    );
  }
}

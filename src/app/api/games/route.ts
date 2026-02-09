// src/app/api/games/route.ts
import { NextResponse } from "next/server";
import { getOfficialGamesForDashboard } from "@/lib/nba/nbaOfficial";
import { getNBAScoreboard as getEspnScoreboard } from "@/lib/nba/espn";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function toYmdKST(date = new Date()) {
  const kst = new Date(date.toLocaleString("en-US", { timeZone: "Asia/Seoul" }));
  const y = kst.getFullYear();
  const m = String(kst.getMonth() + 1).padStart(2, "0");
  const d = String(kst.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function normalizeDateParam(v: string) {
  const raw = v.trim();
  if (/^\d{8}$/.test(raw)) return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  return "";
}

function pickName(team: any) {
  return team?.displayName || team?.shortDisplayName || team?.name || team?.abbreviation || null;
}

/** =========================
 * ✅ 초간단 인메모리 캐시 (warm 인스턴스에서 즉시 체감)
 * - date별 결과를 60초 캐시
 * - 공식 일정 실패 후 ESPN fallback 결과도 캐시
 * ========================= */
type CacheItem<T> = { exp: number; val: T };
const g = globalThis as any;
const CACHE_KEY = "__NBA_GAMES_ROUTE_CACHE__";
if (!g[CACHE_KEY]) g[CACHE_KEY] = new Map<string, CacheItem<any>>();
const cache: Map<string, CacheItem<any>> = g[CACHE_KEY];

function cacheGet<T>(key: string): T | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.exp) {
    cache.delete(key);
    return null;
  }
  return hit.val as T;
}

function cacheSet<T>(key: string, val: T, ttlMs: number) {
  cache.set(key, { val, exp: Date.now() + ttlMs });
}

function withCacheHeaders(resp: NextResponse) {
  // ✅ Vercel CDN 캐시도 함께 타도록 (짧게)
  // - 60초 동안 공유 캐시
  // - 백그라운드 재검증 허용
  resp.headers.set("Cache-Control", "public, s-maxage=60, stale-while-revalidate=300");
  return resp;
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const dateParam = url.searchParams.get("date");
    const date = dateParam ? normalizeDateParam(dateParam) : toYmdKST();

    if (!date) {
      return NextResponse.json(
        { ok: false, error: "Invalid date. Use YYYY-MM-DD or YYYYMMDD." },
        { status: 400 }
      );
    }

    // ✅ 캐시 먼저 확인
    const cacheKey = `games:${date}`;
    const cached = cacheGet<any>(cacheKey);
    if (cached) {
      return withCacheHeaders(NextResponse.json(cached));
    }

    // ✅ 1순위: NBA 공식 일정
    try {
      const games = await getOfficialGamesForDashboard(date);
      const payload = { ok: true, date, count: games.length, games };
      cacheSet(cacheKey, payload, 60 * 1000);
      return withCacheHeaders(NextResponse.json(payload));
    } catch (e: any) {
      // 공식쪽이 깨져도 서비스가 멈추면 안 되니 ESPN으로 fallback
      const msg = String(e?.message ?? e);
      console.error("[games] nba official failed -> fallback espn:", msg);
    }

    // ✅ 2순위: ESPN fallback (기존 너 로직 유지용)
    const rawGames: any[] = await getEspnScoreboard(date);

    const games = rawGames.map((g) => {
      const homeTeam = g?.home?.team ?? {};
      const awayTeam = g?.away?.team ?? {};

      const homeId = homeTeam?.id != null ? String(homeTeam.id) : "";
      const awayId = awayTeam?.id != null ? String(awayTeam.id) : "";

      const homeName = pickName(homeTeam);
      const awayName = pickName(awayTeam);

      const spreadHome = g?.odds?.spreadHome ?? null;
      const total = g?.odds?.total ?? null;
      const provider = g?.odds?.provider ?? null;

      const oddsCompat = {
        markets: {
          spreads: { homePoint: typeof spreadHome === "number" ? spreadHome : null },
          totals: { point: typeof total === "number" ? total : null },
        },
        pickedBookmaker: {
          title: typeof provider === "string" && provider.trim() ? provider : null,
          key: typeof provider === "string" && provider.trim() ? provider : null,
        },
      };

      const homeCompat = {
        teamId: homeId || null,
        id: homeId || null,
        name: homeName,
        abbr: homeTeam?.abbreviation ?? null,
        triCode: homeTeam?.abbreviation ?? null,
        logo: homeTeam?.logo ?? null,
      };

      const awayCompat = {
        teamId: awayId || null,
        id: awayId || null,
        name: awayName,
        abbr: awayTeam?.abbreviation ?? null,
        triCode: awayTeam?.abbreviation ?? null,
        logo: awayTeam?.logo ?? null,
      };

      const kstText = g?.dateKST && g?.timeKST ? `${g.dateKST} ${g.timeKST} KST` : "";

      const gameId = String(g?.gameId ?? g?.id ?? "");
      return {
        gameId,
        id: gameId,
        state: g?.status ?? "UNKNOWN",
        status: g?.status ?? "UNKNOWN",
        statusText: kstText || (g?.statusText ?? ""),
        date: g?.dateKST ?? date,
        home: homeCompat,
        away: awayCompat,
        odds: oddsCompat,
        raw: g,
      };
    });

    const payload = { ok: true, date, count: games.length, games };
    cacheSet(cacheKey, payload, 60 * 1000);
    return withCacheHeaders(NextResponse.json(payload));
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message ?? "Unknown error" },
      { status: 500 }
    );
  }
}

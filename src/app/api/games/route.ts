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
  if (/^\d{8}$/.test(raw))
    return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  return "";
}

function pickName(team: any) {
  return (
    team?.displayName ||
    team?.shortDisplayName ||
    team?.name ||
    team?.abbreviation ||
    null
  );
}

/* =========================
   ✅ NBA OFFICIAL 정규화 helpers
   - pick API와 gameId를 "같은 규칙"으로 맞추는게 핵심
   ========================= */
function getGameIdOfficial(g: any): string {
  return String(
    g?.gameId ??
      g?.id ??
      g?.game_id ??
      g?.gameCode ??
      g?.gamecode ??
      g?.gameCodeId ??
      g?.gameCodeID ??
      g?.gameKey ??
      g?.game_key ??
      ""
  );
}

function getStartTimeUTCOfficial(g: any): string | null {
  const iso =
    g?.startTimeUTC ??
    g?.startTimeUtc ??
    g?.gameTimeUTC ??
    g?.gameTimeUtc ??
    g?.utcTime ??
    g?.commence_time ??
    g?.commenceTime ??
    g?.startTime ??
    g?.dateTimeUTC ??
    g?.gameDateTimeUTC ??
    g?.gameDateTimeUtc ??
    null;

  if (!iso) return null;
  const ms = Date.parse(String(iso));
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function getSideTeamOfficial(side: "home" | "away", g: any) {
  const t =
    (side === "home" ? g?.home : g?.away) ??
    (side === "home" ? g?.homeTeam : g?.awayTeam) ??
    {};

  const teamId = String(
    t?.teamId ??
      t?.id ??
      t?.team_id ??
      (side === "home" ? g?.homeTeamId : g?.awayTeamId) ??
      ""
  );

  const triCode = String(
    t?.triCode ??
      t?.abbr ??
      t?.abbreviation ??
      t?.teamTricode ??
      (side === "home" ? g?.homeTricode : g?.awayTricode) ??
      ""
  ).toUpperCase();

  const name = String(
    t?.displayName ??
      t?.name ??
      t?.teamName ??
      (side === "home" ? g?.homeTeamName : g?.awayTeamName) ??
      (triCode ? triCode : "")
  );

  return {
    teamId: teamId || null,
    id: teamId || null,
    name: name || null,
    abbr: triCode || null,
    triCode: triCode || null,
    logo: t?.logo ?? t?.teamLogo ?? null,
  };
}

function getStatusOfficial(g: any) {
  return String(
    g?.status ??
      g?.gameStatus ??
      g?.gameStatusText ??
      g?.state ??
      g?.gameState ??
      "SCHEDULED"
  );
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

    // ✅ 1순위: NBA 공식 일정
    try {
      const rawGames: any[] = await getOfficialGamesForDashboard(date);

      // ✅ 핵심: 공식 일정도 반드시 gameId를 확정해서 내려줌 (pick과 동일 매칭)
      const games = (rawGames || [])
        .map((g) => {
          const gameId = getGameIdOfficial(g);
          if (!gameId) return null;

          const home = getSideTeamOfficial("home", g);
          const away = getSideTeamOfficial("away", g);

          return {
            gameId,
            id: gameId, // UI 호환
            startTimeUTC: getStartTimeUTCOfficial(g),
            state: getStatusOfficial(g),
            status: getStatusOfficial(g),
            statusText: g?.statusText ?? g?.gameStatusText ?? "",
            date,
            home,
            away,
            // odds 칸이 있으면 UI에 그대로 표시될 수 있게 유지 (없으면 null)
            odds: g?.odds ?? null,
            raw: g,
          };
        })
        .filter(Boolean);

      return NextResponse.json({ ok: true, date, count: games.length, games });
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

    return NextResponse.json({ ok: true, date, count: games.length, games });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message ?? "Unknown error" },
      { status: 500 }
    );
  }
}

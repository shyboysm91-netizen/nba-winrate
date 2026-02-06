import { NextResponse } from "next/server";
import { requirePaid } from "@/lib/subscription/requirePaid";
import { fetchNBAGamesByKstDate } from "@/lib/nba/espn";
import { fetchNbaOdds, type NormalizedOdds } from "@/lib/odds/theOddsApi";

type ApiResp =
  | { ok: true; result: any }
  | { ok: false; error: string };

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

function yyyymmddLocal(addDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + addDays);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

function confidenceBase(gameCount: number) {
  if (gameCount >= 10) return 80;
  if (gameCount >= 7) return 75;
  return 70;
}

/** ✅ 상태값: FINAL/취소/연기/중단 계열만 제외하고 나머지는 분석 가능 */
function isAnalyzableStatus(raw: unknown) {
  const s = String(raw ?? "").trim().toLowerCase();
  if (!s) return true;

  const blocked = [
    "final",
    "canceled",
    "cancelled",
    "postponed",
    "postpone",
    "ppd",
    "suspended",
    "suspend",
    "abandoned",
    "abandon",
    "forfeit",
    "complete",
    "completed",
  ];

  return !blocked.some((k) => s.includes(k));
}

function hasAnalyzableGames(games: any[]) {
  return (games || []).some((g) => isAnalyzableStatus(g?.status));
}

/** ESPN triCode → The Odds API 팀명 */
const TRI_TO_TEAM: Record<string, string> = {
  ATL: "Atlanta Hawks",
  BOS: "Boston Celtics",
  BKN: "Brooklyn Nets",
  CHA: "Charlotte Hornets",
  CHI: "Chicago Bulls",
  CLE: "Cleveland Cavaliers",
  DAL: "Dallas Mavericks",
  DEN: "Denver Nuggets",
  DET: "Detroit Pistons",
  GSW: "Golden State Warriors",
  HOU: "Houston Rockets",
  IND: "Indiana Pacers",
  LAC: "Los Angeles Clippers",
  LAL: "Los Angeles Lakers",
  MEM: "Memphis Grizzlies",
  MIA: "Miami Heat",
  MIL: "Milwaukee Bucks",
  MIN: "Minnesota Timberwolves",
  NOP: "New Orleans Pelicans",
  NYK: "New York Knicks",
  OKC: "Oklahoma City Thunder",
  ORL: "Orlando Magic",
  PHI: "Philadelphia 76ers",
  PHX: "Phoenix Suns",
  POR: "Portland Trail Blazers",
  SAC: "Sacramento Kings",
  SAS: "San Antonio Spurs",
  TOR: "Toronto Raptors",
  UTA: "Utah Jazz",
  WAS: "Washington Wizards",
};

function normTeamName(name: string): string {
  return (name ?? "")
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/’/g, "'")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function makeMatchKey(home: string, away: string): string {
  return `${normTeamName(home)}__${normTeamName(away)}`;
}

function parseMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

function extractTeamsFromEspnGame(g: any): { home: string; away: string } {
  const triHome = String(g?.home?.triCode ?? "").toUpperCase();
  const triAway = String(g?.away?.triCode ?? "").toUpperCase();

  const homeName =
    g?.home?.name ||
    g?.homeTeam?.displayName ||
    g?.homeTeam?.name ||
    TRI_TO_TEAM[triHome] ||
    (triHome ? triHome : "");

  const awayName =
    g?.away?.name ||
    g?.awayTeam?.displayName ||
    g?.awayTeam?.name ||
    TRI_TO_TEAM[triAway] ||
    (triAway ? triAway : "");

  return { home: homeName, away: awayName };
}

function buildOddsBuckets(odds: NormalizedOdds) {
  const buckets = new Map<string, NormalizedOdds["events"][number][]>();

  for (const e of odds.events) {
    const k1 = makeMatchKey(e.homeTeam, e.awayTeam);
    const k2 = makeMatchKey(e.awayTeam, e.homeTeam);

    if (!buckets.has(k1)) buckets.set(k1, []);
    buckets.get(k1)!.push(e);

    if (!buckets.has(k2)) buckets.set(k2, []);
    buckets.get(k2)!.push(e);
  }

  return buckets;
}

function pickClosestEvent(
  candidates: NormalizedOdds["events"][number][],
  startTimeUtcIso: string | null
) {
  if (!candidates.length) return null;

  const startMs = parseMs(startTimeUtcIso);
  if (startMs === null) return candidates[0];

  let best = candidates[0];
  let bestDiff = Infinity;

  for (const c of candidates) {
    const cMs = parseMs(c.commenceTime);
    if (cMs === null) continue;
    const diff = Math.abs(cMs - startMs);
    if (diff < bestDiff) {
      best = c;
      bestDiff = diff;
    }
  }

  if (!Number.isFinite(bestDiff) || bestDiff > 24 * 60 * 60 * 1000) return null;
  return best;
}

/**
 * ✅ 기본 날짜 자동 선택
 * - 오늘에 "분석 가능" 경기가 있으면 → 오늘
 * - 없으면 → 내일
 */
async function resolveAutoDate(explicitDate?: string) {
  if (explicitDate) {
    const r = await fetchNBAGamesByKstDate(explicitDate);
    return r; // { date, games }
  }

  const today = yyyymmddLocal(0);
  const tomorrow = yyyymmddLocal(1);

  const todayRes = await fetchNBAGamesByKstDate(today);
  if (
    Array.isArray(todayRes?.games) &&
    todayRes.games.length > 0 &&
    hasAnalyzableGames(todayRes.games)
  ) {
    return todayRes;
  }

  return await fetchNBAGamesByKstDate(tomorrow);
}

export async function GET(req: Request) {
  try {
    // ✅ TOP3는 PRO 전용 (무료 완전 잠금)
    await requirePaid();

    const { searchParams } = new URL(req.url);
    const explicitDate = searchParams.get("date") || undefined;

    const { date: dateKst, games } = await resolveAutoDate(explicitDate);

    if (!Array.isArray(games) || games.length === 0) {
      return NextResponse.json<ApiResp>({
        ok: true,
        result: {
          date: dateKst,
          totalGames: 0,
          candidates: 0,
          top3: [],
          note: "해당 날짜 경기 없음",
          options: { provider: "MODEL_SIMPLE", mode: "9PICKS" },
        },
      });
    }

    // ✅ Odds는 TOP3 요청당 1번만 호출
    let oddsBuckets: Map<string, NormalizedOdds["events"][number][]> | null = null;
    let oddsFetchedAt: string | null = null;
    let oddsUsage: NormalizedOdds["usage"] | null = null;

    try {
      const odds = await fetchNbaOdds({ useConsensus: false });
      oddsBuckets = buildOddsBuckets(odds);
      oddsFetchedAt = odds.fetchedAt;
      oddsUsage = odds.usage ?? null;
    } catch {
      oddsBuckets = null;
    }

    const baseConf = confidenceBase(games.length);

    const ml: any[] = [];
    const spread: any[] = [];
    const total: any[] = [];

    for (const g of games) {
      const homeTeamId = String(g?.home?.teamId ?? g?.home?.id ?? "");
      const awayTeamId = String(g?.away?.teamId ?? g?.away?.id ?? "");
      if (!homeTeamId || !awayTeamId) continue;

      const triHome = String(g?.home?.triCode ?? "").toUpperCase();
      const triAway = String(g?.away?.triCode ?? "").toUpperCase();

      const homeDisplay = g?.home?.name ?? TRI_TO_TEAM[triHome] ?? (triHome ? triHome : null);
      const awayDisplay = g?.away?.name ?? TRI_TO_TEAM[triAway] ?? (triAway ? triAway : null);

      // ✅ 실제 배당 매칭
      let marketSpreadHome: number | null = null;
      let marketTotal: number | null = null;
      let marketProvider: string | null = null;

      if (oddsBuckets) {
        const { home, away } = extractTeamsFromEspnGame(g);
        const key = makeMatchKey(home, away);
        const candidates = oddsBuckets.get(key) ?? [];
        const matched = pickClosestEvent(candidates, g?.startTimeUTC ?? null);

        if (matched) {
          const sp = matched.markets?.spreads;
          const tt = matched.markets?.totals;

          marketSpreadHome = typeof sp?.homePoint === "number" ? sp.homePoint : null;
          marketTotal = typeof tt?.point === "number" ? tt.point : null;

          // ✅ provider: key 우선, 없으면 title
          const pb: any = matched.pickedBookmaker ?? null;
          marketProvider = (pb?.key ?? pb?.title ?? null) as string | null;
        }
      }

      const spreadHome =
        typeof marketSpreadHome === "number" && Number.isFinite(marketSpreadHome)
          ? marketSpreadHome
          : -2;

      const totalLine =
        typeof marketTotal === "number" && Number.isFinite(marketTotal)
          ? marketTotal
          : 218;

      const lineProvider = marketProvider ?? "MODEL_SIMPLE";

      const gameMeta = {
        gameId: g.gameId,
        date: dateKst,
        homeTeamId,
        awayTeamId,
        homeTeamName: homeDisplay,
        awayTeamName: awayDisplay,
      };

      ml.push({
        type: "ML",
        confidence: baseConf,
        provider: lineProvider,
        game: gameMeta,
        ui: {
          pickSide: "HOME",
          pickTeamId: homeTeamId,
          pickTeamName: gameMeta.homeTeamName,
        },
        meta: { homeTeamId, awayTeamId },
      });

      spread.push({
        type: "SPREAD",
        confidence: clamp(baseConf - 3, 70, 90),
        provider: lineProvider,
        game: gameMeta,
        ui: {
          pickSide: "HOME",
          pickTeamId: homeTeamId,
          pickTeamName: gameMeta.homeTeamName,
          pickLine: Number(spreadHome),
        },
        meta: { homeTeamId, awayTeamId },
      });

      total.push({
        type: "TOTAL",
        confidence: clamp(baseConf - 5, 70, 85),
        provider: lineProvider,
        game: gameMeta,
        ui: { pickTotal: "OVER", totalLine: Number(totalLine) },
        meta: { homeTeamId, awayTeamId },
      });
    }

    const top9 = [...ml.slice(0, 3), ...spread.slice(0, 3), ...total.slice(0, 3)];

    return NextResponse.json<ApiResp>({
      ok: true,
      result: {
        date: dateKst,
        totalGames: games.length,
        candidates: top9.length,
        top3: top9,
        note: "자동 날짜: 오늘(분석 가능 있으면) / 없으면 내일. 승3 + 핸디3 + 언더오버3",
        options: { provider: "MARKET_ODDS", mode: "9PICKS" },
        oddsMeta: {
          fetchedAt: oddsFetchedAt,
          usage: oddsUsage,
          ok: Boolean(oddsBuckets),
        },
      },
    });
  } catch (e: any) {
    return NextResponse.json<ApiResp>(
      { ok: false, error: String(e?.message ?? e) },
      { status: 500 }
    );
  }
}

import { NextResponse } from "next/server";
import { fetchNBAGamesByKstDate } from "@/lib/nba/espn";
import { fetchNbaOdds, type NormalizedOdds } from "@/lib/odds/theOddsApi";

export const runtime = "nodejs";

/** ESPN triCode → 공식 팀명 */
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

function json(data: unknown, init?: ResponseInit) {
  return NextResponse.json(data, {
    ...init,
    headers: { "cache-control": "no-store" },
  });
}

function norm(name: string) {
  return name.toLowerCase().replace(/[^a-z\s]/g, "").trim();
}

function makeKey(home: string, away: string) {
  return `${norm(home)}__${norm(away)}`;
}

function extractTeams(game: any) {
  const homeTri = game?.home?.triCode;
  const awayTri = game?.away?.triCode;

  const home =
    game?.homeTeam?.displayName ||
    game?.homeTeam?.name ||
    TRI_TO_TEAM[homeTri] ||
    "";

  const away =
    game?.awayTeam?.displayName ||
    game?.awayTeam?.name ||
    TRI_TO_TEAM[awayTri] ||
    "";

  return { home, away };
}

function buildBuckets(odds: NormalizedOdds) {
  const map = new Map<string, NormalizedOdds["events"][number][]>();

  for (const e of odds.events) {
    const k1 = makeKey(e.homeTeam, e.awayTeam);
    const k2 = makeKey(e.awayTeam, e.homeTeam);

    map.set(k1, [...(map.get(k1) ?? []), e]);
    map.set(k2, [...(map.get(k2) ?? []), e]);
  }
  return map;
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const date = searchParams.get("date") || undefined;

  try {
    const data = await fetchNBAGamesByKstDate(date);
    const odds = await fetchNbaOdds({ useConsensus: false });
    const buckets = buildBuckets(odds);

    const games = data.games.map((g: any) => {
      const { home, away } = extractTeams(g);
      const key = makeKey(home, away);
      const matched = buckets.get(key)?.[0] ?? null;

      return {
        ...g,
        odds: matched
          ? {
              source: "theoddsapi",
              markets: matched.markets,
              pickedBookmaker: matched.pickedBookmaker ?? null,
            }
          : null,
      };
    });

    return json({
      ok: true,
      date: data.date,
      games,
      oddsMeta: {
        fetchedAt: odds.fetchedAt,
        usage: odds.usage,
      },
    });
  } catch (e: any) {
    return json({ ok: false, error: String(e?.message ?? e) }, { status: 500 });
  }
}

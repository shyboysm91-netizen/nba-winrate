type NbaStatsScoreboardGame = {
  gameId: string;
  gameStatus: number;
  gameStatusText: string;
  gameTimeUTC: string;
  period?: number;
  gameClock?: string;
  awayTeam: { teamId: string; teamTricode: string; score: number };
  homeTeam: { teamId: string; teamTricode: string; score: number };
};

const KST_OFFSET_MIN = 9 * 60;

function nowKstYYYYMMDD(): string {
  const now = new Date();
  const kst = new Date(now.getTime() + KST_OFFSET_MIN * 60 * 1000);
  const y = kst.getUTCFullYear();
  const m = String(kst.getUTCMonth() + 1).padStart(2, "0");
  const d = String(kst.getUTCDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

function parseKstYYYYMMDD(dateStr: string): Date {
  if (!/^\d{8}$/.test(dateStr)) throw new Error("INVALID_DATE");
  const y = Number(dateStr.slice(0, 4));
  const m = Number(dateStr.slice(4, 6));
  const d = Number(dateStr.slice(6, 8));
  const utc = new Date(Date.UTC(y, m - 1, d, 0, 0, 0));
  utc.setUTCMinutes(utc.getUTCMinutes() - KST_OFFSET_MIN);
  return utc;
}

function kstYyyymmddFromUtcIso(isoUtc: string): string {
  const dt = new Date(isoUtc);
  const kst = new Date(dt.getTime() + KST_OFFSET_MIN * 60 * 1000);
  const y = kst.getUTCFullYear();
  const m = String(kst.getUTCMonth() + 1).padStart(2, "0");
  const d = String(kst.getUTCDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

function toYmd(dateUtc: Date): string {
  const y = dateUtc.getUTCFullYear();
  const m = String(dateUtc.getUTCMonth() + 1).padStart(2, "0");
  const d = String(dateUtc.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function seasonFromKstYyyymmdd(dateKst: string): string {
  const y = Number(dateKst.slice(0, 4));
  const m = Number(dateKst.slice(4, 6));
  const startYear = m >= 10 ? y : y - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
}

function normalizeStatus(gameStatus: number, text: string) {
  if (gameStatus === 3) return { state: "FINAL" as const, label: text || "Final" };
  if (gameStatus === 2) return { state: "LIVE" as const, label: text || "Live" };
  return { state: "SCHEDULED" as const, label: text || "Scheduled" };
}

async function fetchNbaStats(url: string) {
  const res = await fetch(url, {
    cache: "no-store",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36",
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "en-US,en;q=0.9,ko;q=0.8",
      Referer: "https://www.nba.com/",
      Origin: "https://www.nba.com",
      Connection: "keep-alive",
    },
  });

  if (!res.ok) throw new Error(`NBA_STATS_HTTP_${res.status}`);
  return res.json();
}

async function fetchNbaStatsScoreboardV3(ymd: string): Promise<NbaStatsScoreboardGame[]> {
  const url = `https://stats.nba.com/stats/scoreboardv3?GameDate=${encodeURIComponent(
    ymd
  )}&LeagueID=00`;

  const json = await fetchNbaStats(url);
  const games = json?.scoreboard?.games ?? [];

  return (games as any[]).map((g) => {
    const away = g?.awayTeam ?? {};
    const home = g?.homeTeam ?? {};

    return {
      gameId: String(g.gameId ?? ""),
      gameStatus: Number(g.gameStatus ?? 0),
      gameStatusText: String(g.gameStatusText ?? ""),
      gameTimeUTC: String(g.gameTimeUTC ?? g.gameTimeUtc ?? ""),
      period: Number(g?.period ?? 0) || undefined,
      gameClock: g?.gameClock ? String(g.gameClock) : undefined,
      awayTeam: {
        teamId: String(away.teamId ?? ""),
        teamTricode: String(away.teamTricode ?? ""),
        score: Number(away.score ?? 0),
      },
      homeTeam: {
        teamId: String(home.teamId ?? ""),
        teamTricode: String(home.teamTricode ?? ""),
        score: Number(home.score ?? 0),
      },
    };
  });
}

/**
 * ✅ KST 날짜 경기 목록
 */
export async function fetchNBAGamesByKstDate(date?: string) {
  const dateKst = date ?? nowKstYYYYMMDD();

  const kstMidnightUtc = parseKstYYYYMMDD(dateKst);
  const utcPrev = new Date(kstMidnightUtc.getTime() - 24 * 60 * 60 * 1000);
  const utcCur = new Date(kstMidnightUtc.getTime());
  const utcNext = new Date(kstMidnightUtc.getTime() + 24 * 60 * 60 * 1000);

  const [a, b, c] = await Promise.allSettled([
    fetchNbaStatsScoreboardV3(toYmd(utcPrev)),
    fetchNbaStatsScoreboardV3(toYmd(utcCur)),
    fetchNbaStatsScoreboardV3(toYmd(utcNext)),
  ]);

  const all = [
    ...(a.status === "fulfilled" ? a.value : []),
    ...(b.status === "fulfilled" ? b.value : []),
    ...(c.status === "fulfilled" ? c.value : []),
  ];

  const byId = new Map<string, NbaStatsScoreboardGame>();
  for (const g of all) if (g?.gameId) byId.set(g.gameId, g);

  const filtered = [...byId.values()].filter((g) => {
    if (!g.gameTimeUTC) return false;
    return kstYyyymmddFromUtcIso(g.gameTimeUTC) === dateKst;
  });

  const games = filtered.map((g) => {
    const st = normalizeStatus(g.gameStatus, g.gameStatusText);
    return {
      gameId: g.gameId,
      startTimeUTC: g.gameTimeUTC,
      startTimeKST: new Date(
        new Date(g.gameTimeUTC).getTime() + KST_OFFSET_MIN * 60 * 1000
      ).toISOString(),
      status: st.state,
      statusText: st.label,
      period: g.period ?? null,
      clock: g.gameClock ?? null,
      away: {
        teamId: g.awayTeam.teamId,
        triCode: g.awayTeam.teamTricode,
        name: null,
        score: Number.isFinite(g.awayTeam.score) ? g.awayTeam.score : null,
      },
      home: {
        teamId: g.homeTeam.teamId,
        triCode: g.homeTeam.teamTricode,
        name: null,
        score: Number.isFinite(g.homeTeam.score) ? g.homeTeam.score : null,
      },
    };
  });

  return { date: dateKst, games };
}

/**
 * ✅ 호환 유지
 */
export async function fetchNBAScoreboard(date?: string) {
  return fetchNBAGamesByKstDate(date);
}

/**
 * ✅ 핵심: 시즌 데이터가 비면 자동 fallback
 * - 1순위: dateKst 시즌
 * - 2순위: 오늘(KST) 시즌
 * - 3순위: (2순위 - 1년) 시즌
 */
export async function fetchNBATeamLast10(teamId: string, dateKst?: string) {
  const tid = String(teamId ?? "").trim();
  if (!tid) throw new Error("TEAM_ID_REQUIRED");

  const baseDate = dateKst && /^\d{8}$/.test(dateKst) ? dateKst : nowKstYYYYMMDD();
  const today = nowKstYYYYMMDD();

  const season1 = seasonFromKstYyyymmdd(baseDate);
  const season2 = seasonFromKstYyyymmdd(today);

  const prevStartYear = Number(season2.slice(0, 4)) - 1;
  const season3 = `${prevStartYear}-${String((prevStartYear + 1) % 100).padStart(2, "0")}`;

  const seasons = Array.from(new Set([season1, season2, season3]));

  for (const season of seasons) {
    const url =
      `https://stats.nba.com/stats/teamgamelog?` +
      `TeamID=${encodeURIComponent(tid)}` +
      `&Season=${encodeURIComponent(season)}` +
      `&SeasonType=${encodeURIComponent("Regular Season")}`;

    const json = await fetchNbaStats(url);

    const rs = (json?.resultSets?.[0] ?? json?.resultSet) as any;
    const headers: string[] = rs?.headers ?? [];
    const rows: any[] = rs?.rowSet ?? [];

    if (!Array.isArray(rows) || rows.length === 0) continue;

    const idx = (name: string) =>
      headers.findIndex((h) => String(h).toUpperCase() === name);

    const iGameDate = idx("GAME_DATE");
    const iMatchup = idx("MATCHUP");
    const iWL = idx("WL");
    const iPTS = idx("PTS");
    const iPlusMinus = idx("PLUS_MINUS");

    const last10 = rows.slice(0, 10).map((r) => {
      const gameDate = iGameDate >= 0 ? String(r[iGameDate] ?? "") : "";
      const matchup = iMatchup >= 0 ? String(r[iMatchup] ?? "") : "";
      const wl = iWL >= 0 ? String(r[iWL] ?? "") : "";

      const pts = iPTS >= 0 ? Number(r[iPTS] ?? 0) : null;
      const plusMinus =
        iPlusMinus >= 0 && r[iPlusMinus] != null ? Number(r[iPlusMinus]) : null;

      const oppPts =
        typeof pts === "number" &&
        Number.isFinite(pts) &&
        typeof plusMinus === "number" &&
        Number.isFinite(plusMinus)
          ? pts - plusMinus
          : null;

      const isHome = matchup.includes(" vs. ");
      const oppTri = matchup.split(isHome ? " vs. " : " @ ")[1] ?? "";

      return {
        gameDate,
        date: gameDate,
        matchup,
        isHome,
        oppTri,
        wl,
        result: wl,
        pts,
        ptsFor: pts,
        oppPts,
        ptsAgainst: oppPts,
        plusMinus,
      };
    });

    return { teamId: tid, season, games: last10 };
  }

  // 전부 실패하면 빈 배열 반환 (TOP3에서 dataOk=false로 처리)
  return { teamId: tid, season: seasons[0] ?? "", games: [] };
}

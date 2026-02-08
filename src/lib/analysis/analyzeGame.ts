import { fetchNBATeamLast10 } from "@/lib/nba/espn";

type Last10Game = {
  home: { id: string; score: number | null };
  away: { id: string; score: number | null };
  winner: "HOME" | "AWAY" | "TIE" | null;
};

type TeamStats = {
  teamId: string;
  games: number;
  wins: number;
  losses: number;
  winPct: number; // 0~1
  avgFor: number; // 득점
  avgAgainst: number; // 실점
};

function round1(n: number) {
  return Math.round(n * 10) / 10;
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function computeTeamStats(teamId: string, games10: Last10Game[]): TeamStats {
  let games = 0;
  let wins = 0;
  let losses = 0;
  let forSum = 0;
  let againstSum = 0;

  for (const g of games10) {
    const isHome = g.home.id === teamId;
    const isAway = g.away.id === teamId;
    if (!isHome && !isAway) continue;

    const myScore = isHome ? g.home.score : g.away.score;
    const oppScore = isHome ? g.away.score : g.home.score;

    if (myScore == null || oppScore == null) continue;

    games += 1;
    forSum += myScore;
    againstSum += oppScore;

    if (g.winner === "TIE" || g.winner == null) continue;

    const iWon =
      (isHome && g.winner === "HOME") ||
      (isAway && g.winner === "AWAY");

    if (iWon) wins += 1;
    else losses += 1;
  }

  const winPct = games > 0 ? wins / games : 0;
  const avgFor = games > 0 ? forSum / games : 0;
  const avgAgainst = games > 0 ? againstSum / games : 0;

  return { teamId, games, wins, losses, winPct, avgFor, avgAgainst };
}

function confidenceFromEdge(edge: number, gamesUsed: number) {
  const base = 50 + Math.abs(edge) * 6.5;
  let conf = clamp(base, 50, 92);

  if (gamesUsed < 6) conf = Math.min(conf, 64);
  else if (gamesUsed < 8) conf = Math.min(conf, 72);
  else if (gamesUsed < 10) conf = Math.min(conf, 78);

  return Math.round(conf);
}

export type AnalysisInput = {
  homeTeamId: string;
  awayTeamId: string;
  spreadHome?: number;
  total?: number;
};

export type AnalysisResult = {
  input: AnalysisInput;
  home: TeamStats;
  away: TeamStats;

  model: {
    expectedHomePts: number;
    expectedAwayPts: number;
    expectedMarginHome: number;
    expectedTotal: number;
  };

  picks: {
    ml?: { pick: "HOME" | "AWAY"; confidence: number; reason: string };
    spread?: { pick: "HOME" | "AWAY"; confidence: number; reason: string };
    total?: { pick: "OVER" | "UNDER"; confidence: number; reason: string };
  };
};

export async function analyzeGame(input: AnalysisInput): Promise<AnalysisResult> {
  const [homeRes, awayRes] = await Promise.all([
    fetchNBATeamLast10(input.homeTeamId),
    fetchNBATeamLast10(input.awayTeamId),
  ]);

  // ✅ last10 ❌ → games ⭕
  const homeStats = computeTeamStats(input.homeTeamId, homeRes.games);
  const awayStats = computeTeamStats(input.awayTeamId, awayRes.games);

  const expectedHomePts = (homeStats.avgFor + awayStats.avgAgainst) / 2;
  const expectedAwayPts = (awayStats.avgFor + homeStats.avgAgainst) / 2;

  const expectedMarginHome = expectedHomePts - expectedAwayPts;
  const expectedTotal = expectedHomePts + expectedAwayPts;

  const picks: AnalysisResult["picks"] = {};

  if (expectedMarginHome >= 2) {
    picks.ml = {
      pick: "HOME",
      confidence: confidenceFromEdge(
        expectedMarginHome,
        Math.min(homeStats.games, awayStats.games)
      ),
      reason: `예상 마진(홈) ${round1(expectedMarginHome)}점`,
    };
  } else if (expectedMarginHome <= -2) {
    picks.ml = {
      pick: "AWAY",
      confidence: confidenceFromEdge(
        expectedMarginHome,
        Math.min(homeStats.games, awayStats.games)
      ),
      reason: `예상 마진(홈) ${round1(expectedMarginHome)}점`,
    };
  }

  if (typeof input.spreadHome === "number" && Number.isFinite(input.spreadHome)) {
    const coverEdgeHome = expectedMarginHome - Math.abs(input.spreadHome);
    const coverEdgeAway = -expectedMarginHome - Math.abs(input.spreadHome);

    if (coverEdgeHome > 1) {
      picks.spread = {
        pick: "HOME",
        confidence: confidenceFromEdge(
          coverEdgeHome,
          Math.min(homeStats.games, awayStats.games)
        ),
        reason: `예상 마진 ${round1(expectedMarginHome)} vs 라인 ${input.spreadHome}`,
      };
    } else if (coverEdgeAway > 1) {
      picks.spread = {
        pick: "AWAY",
        confidence: confidenceFromEdge(
          coverEdgeAway,
          Math.min(homeStats.games, awayStats.games)
        ),
        reason: `예상 마진 ${round1(expectedMarginHome)} vs 라인 ${input.spreadHome}`,
      };
    }
  }

  if (typeof input.total === "number" && Number.isFinite(input.total)) {
    const diff = expectedTotal - input.total;
    if (diff > 3) {
      picks.total = {
        pick: "OVER",
        confidence: confidenceFromEdge(
          diff,
          Math.min(homeStats.games, awayStats.games)
        ),
        reason: `예상 합계 ${round1(expectedTotal)} vs 라인 ${input.total}`,
      };
    } else if (diff < -3) {
      picks.total = {
        pick: "UNDER",
        confidence: confidenceFromEdge(
          diff,
          Math.min(homeStats.games, awayStats.games)
        ),
        reason: `예상 합계 ${round1(expectedTotal)} vs 라인 ${input.total}`,
      };
    }
  }

  return {
    input,
    home: {
      ...homeStats,
      winPct: round1(homeStats.winPct * 100) / 100,
      avgFor: round1(homeStats.avgFor),
      avgAgainst: round1(homeStats.avgAgainst),
    },
    away: {
      ...awayStats,
      winPct: round1(awayStats.winPct * 100) / 100,
      avgFor: round1(awayStats.avgFor),
      avgAgainst: round1(awayStats.avgAgainst),
    },
    model: {
      expectedHomePts: round1(expectedHomePts),
      expectedAwayPts: round1(expectedAwayPts),
      expectedMarginHome: round1(expectedMarginHome),
      expectedTotal: round1(expectedTotal),
    },
    picks,
  };
}

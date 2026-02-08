import { fetchNBAScoreboard } from "@/lib/nba/espn";
import { analyzeGame } from "@/lib/analysis/analyzeGame";

type PickType = "ML" | "SPREAD" | "TOTAL";

type TopPick = {
  type: PickType;
  gameId: string;
  matchup: string;
  pick: string;
  confidence: number;
  reason: string;
  line?: {
    spreadHome?: number | null;
    total?: number | null;
    provider?: string | null;
  };
};

function addIf(picks: TopPick[], p: TopPick | null | undefined) {
  if (!p) return;
  if (p.confidence < 50) return;
  picks.push(p);
}

export async function recommendTop3(dateYYYYMMDD?: string) {
  const { date, games } = await fetchNBAScoreboard(dateYYYYMMDD);

  const candidates: TopPick[] = [];

  for (const g of games) {
    // ✅ id 없음 → teamId만 사용
    if (!g?.home?.teamId || !g?.away?.teamId) continue;

    // ✅ scoreboard 타입에는 odds가 없음 (타입 에러 방지)
    // 라인 기반 추천은 api/top3에서 odds 매칭 후 처리하는 구조
    const spreadHome: number | undefined = undefined;
    const total: number | undefined = undefined;
    const provider: string | null = null;

    const analysis = await analyzeGame({
      homeTeamId: g.home.teamId,
      awayTeamId: g.away.teamId,
      spreadHome,
      total,
    });

    const matchup = `${g.away.triCode || g.away.name} @ ${g.home.triCode || g.home.name}`;

    if (analysis.picks.ml) {
      addIf(candidates, {
        type: "ML",
        gameId: g.gameId,
        matchup,
        pick: analysis.picks.ml.pick,
        confidence: analysis.picks.ml.confidence,
        reason: analysis.picks.ml.reason,
      });
    }

    // spread/total은 라인이 없으면 생성되지 않도록 analyzeGame이 이미 막고 있음
    if (analysis.picks.spread && typeof spreadHome === "number") {
      addIf(candidates, {
        type: "SPREAD",
        gameId: g.gameId,
        matchup,
        pick: `${analysis.picks.spread.pick} (home line ${spreadHome})`,
        confidence: analysis.picks.spread.confidence,
        reason: analysis.picks.spread.reason,
        line: { spreadHome, provider },
      });
    }

    if (analysis.picks.total && typeof total === "number") {
      addIf(candidates, {
        type: "TOTAL",
        gameId: g.gameId,
        matchup,
        pick: `${analysis.picks.total.pick} (O/U ${total})`,
        confidence: analysis.picks.total.confidence,
        reason: analysis.picks.total.reason,
        line: { total, provider },
      });
    }
  }

  const sortDesc = (arr: TopPick[]) =>
    arr.slice().sort((a, b) => b.confidence - a.confidence);

  const bestML = sortDesc(candidates.filter((c) => c.type === "ML"));
  const bestSpread = sortDesc(candidates.filter((c) => c.type === "SPREAD"));
  const bestTotal = sortDesc(candidates.filter((c) => c.type === "TOTAL"));

  const top3: TopPick[] = [];

  const pushUniqueGame = (p?: TopPick) => {
    if (!p) return false;
    if (top3.some((x) => x.gameId === p.gameId)) return false;
    top3.push(p);
    return true;
  };

  // ✅ 혼합 보장 (가능한 만큼)
  pushUniqueGame(bestML[0]);
  pushUniqueGame(bestSpread[0]);
  pushUniqueGame(bestTotal[0]);

  // 부족하면 남은 후보 중 높은 점수로 채움 (게임 중복 금지)
  if (top3.length < 3) {
    for (const c of sortDesc(candidates)) {
      if (top3.length >= 3) break;
      if (top3.some((x) => x.gameId === c.gameId)) continue;
      top3.push(c);
    }
  }

  return {
    date,
    totalGames: games.length,
    candidates: candidates.length,
    top3,
  };
}

// src/lib/top3/scoring.ts
export type PickType = "ML" | "SPREAD" | "TOTAL";

export type GameOdds = {
  spreadHome?: number | null;
  total?: number | null;
  // 선택: ESPN/공급자에 따라 있을 수도 있음
  moneylineHome?: number | null;
  moneylineAway?: number | null;
  provider?: string | null;
};

export type TeamLast10 = {
  games: number; // 0~10
  wins: number;
  losses: number;
  pf: number; // points for 합
  pa: number; // points against 합
};

export type GameLite = {
  id: string;
  date: string; // YYYYMMDD
  homeTeamId: string;
  awayTeamId: string;
  homeTeamName?: string;
  awayTeamName?: string;
  odds?: GameOdds | null;
};

export type CandidatePick = {
  gameId: string;
  date: string;
  type: PickType;

  label: string; // 화면 표시용
  pick: string;  // 예: "HOME ML", "HOME -3.5", "OVER 228.5"
  line?: number | null;

  modelProb: number;   // 0~1
  marketProb: number;  // 0~1 (없으면 0.5)
  edgePct: number;     // (model - market)*100
  confidence: number;  // 0~100

  provider?: string | null;

  meta: {
    homeTeamId: string;
    awayTeamId: string;
    homeTeamName?: string;
    awayTeamName?: string;
    // 디버그/설명용
    notes: string[];
  };
};

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

function safeDiv(a: number, b: number) {
  return b === 0 ? 0 : a / b;
}

/**
 * American odds(-120, +150) -> implied probability
 * (없거나 0이면 null)
 */
export function impliedProbFromAmericanOdds(american?: number | null): number | null {
  if (american == null || !Number.isFinite(american) || american === 0) return null;
  const x = american;
  if (x < 0) return (-x) / ((-x) + 100);
  return 100 / (x + 100);
}

/**
 * last10 기반 아주 단순한 ML 승률 추정 (fallback 전용)
 * - win% + 최근 득실마진(경기당) 섞어서 0.05~0.95로 제한
 * - 홈 어드밴티지 약간(+0.02)
 */
export function estimateHomeWinProbFromLast10(home: TeamLast10, away: TeamLast10): { pHome: number; notes: string[] } {
  const notes: string[] = [];

  const hg = Math.max(0, home.games || 0);
  const ag = Math.max(0, away.games || 0);

  const homeWinPct = hg > 0 ? home.wins / hg : 0.5;
  const awayWinPct = ag > 0 ? away.wins / ag : 0.5;

  const homePdPerGame = hg > 0 ? (home.pf - home.pa) / hg : 0;
  const awayPdPerGame = ag > 0 ? (away.pf - away.pa) / ag : 0;

  // win% (기본) + 득실차 차이(보정)
  // 득실차 차이 10점이면 약 0.08 정도 영향
  const pdDelta = homePdPerGame - awayPdPerGame;
  const pdAdj = clamp(pdDelta * 0.008, -0.12, 0.12);

  let pHome = 0.78 * homeWinPct + 0.22 * (1 - awayWinPct);
  pHome += pdAdj;
  pHome += 0.02; // 홈 어드밴티지

  pHome = clamp(pHome, 0.05, 0.95);

  notes.push(`homeWinPct=${homeWinPct.toFixed(2)} awayWinPct=${awayWinPct.toFixed(2)}`);
  notes.push(`pdDelta=${pdDelta.toFixed(1)} pdAdj=${pdAdj.toFixed(3)} homeAdv=+0.02`);
  return { pHome, notes };
}

/**
 * edge -> confidence 매핑(통일)
 * - edge 0%면 50 근처
 * - edge 10%면 70 근처
 * - edge 20%면 85 근처
 * - 0~100 clamp
 */
export function confidenceFromEdgePct(edgePct: number): number {
  const c = 50 + edgePct * 1.75; // 10 -> 67.5 / 20 -> 85
  return Math.round(clamp(c, 0, 100));
}

type BuildOptions = {
  relax: boolean;          // 후보 조건 완화
  fallbackML: boolean;     // 라인 없을 때 ML 후보 생성
  minConfidence: number;   // 기본 55
  maxCandidates: number;   // 안전장치
};

const DEFAULT_OPTS: BuildOptions = {
  relax: false,
  fallbackML: true,
  minConfidence: 55,
  maxCandidates: 120,
};

export function buildTop3Candidates(args: {
  games: GameLite[];
  getLast10: (teamId: string) => Promise<TeamLast10 | null>;
  opts?: Partial<BuildOptions>;
}): Promise<CandidatePick[]> {
  const opts: BuildOptions = { ...DEFAULT_OPTS, ...(args.opts || {}) };

  return (async () => {
    const candidates: CandidatePick[] = [];

    // last10 캐시
    const last10Cache = new Map<string, TeamLast10 | null>();
    const getLast10Cached = async (teamId: string) => {
      if (last10Cache.has(teamId)) return last10Cache.get(teamId)!;
      const v = await args.getLast10(teamId);
      last10Cache.set(teamId, v);
      return v;
    };

    for (const g of args.games) {
      if (candidates.length >= opts.maxCandidates) break;

      const odds = g.odds || undefined;
      const spreadHome = odds?.spreadHome ?? null;
      const total = odds?.total ?? null;

      // last10
      const [h10, a10] = await Promise.all([
        getLast10Cached(g.homeTeamId),
        getLast10Cached(g.awayTeamId),
      ]);

      // last10 없으면 fallback ML도 제한 (완전 빈 데이터면 추천 품질 떨어짐)
      const hasLast10 = !!h10 && !!a10 && (h10.games > 0 || a10.games > 0);

      // (A) SPREAD 후보
      if (spreadHome != null && Number.isFinite(spreadHome)) {
        // 시장확률은 라인만 있을 땐 0.5로 가정(최소 기능)
        // 모델확률은 last10으로 “홈이 커버할 확률”을 근사
        let model = 0.5;
        const notes: string[] = [];
        if (hasLast10) {
          const { pHome, notes: n2 } = estimateHomeWinProbFromLast10(h10!, a10!);
          // 스프레드는 ML보다 변동성이 커서 0.5 쪽으로 당김
          model = clamp(0.5 + (pHome - 0.5) * 0.75, 0.05, 0.95);
          notes.push(...n2, "spreadModel=shrink(ML,0.75)");
        } else {
          notes.push("noLast10 -> spreadModel=0.50");
        }

        const market = 0.5;
        const edgePct = (model - market) * 100;
        const confidence = confidenceFromEdgePct(edgePct);

        // 기본은 58 이상, relax면 52 이상부터 후보 포함
        const gate = opts.relax ? Math.min(opts.minConfidence, 52) : Math.max(opts.minConfidence, 58);
        if (confidence >= gate) {
          const homeSide = spreadHome; // 홈 기준 라인
          const pick =
            homeSide <= 0
              ? `HOME ${homeSide}` // -3.5 같은 형태
              : `HOME +${homeSide}`;

          candidates.push({
            gameId: g.id,
            date: g.date,
            type: "SPREAD",
            label: `${g.awayTeamName ?? g.awayTeamId} @ ${g.homeTeamName ?? g.homeTeamId}`,
            pick,
            line: homeSide,
            modelProb: model,
            marketProb: market,
            edgePct: Math.round(edgePct * 10) / 10,
            confidence,
            provider: odds?.provider ?? null,
            meta: {
              homeTeamId: g.homeTeamId,
              awayTeamId: g.awayTeamId,
              homeTeamName: g.homeTeamName,
              awayTeamName: g.awayTeamName,
              notes,
            },
          });
        }
      }

      // (B) TOTAL 후보
      if (total != null && Number.isFinite(total)) {
        let modelOver = 0.5;
        const notes: string[] = [];
        if (hasLast10) {
          const hppg = safeDiv(h10!.pf, Math.max(1, h10!.games));
          const apg = safeDiv(a10!.pa, Math.max(1, a10!.games));
          const appg = safeDiv(a10!.pf, Math.max(1, a10!.games));
          const hpa = safeDiv(h10!.pa, Math.max(1, h10!.games));

          // 매우 단순 기대 득점: (내 득점 + 상대 실점)/2 합
          const expHome = (hppg + apg) / 2;
          const expAway = (appg + hpa) / 2;
          const expTotal = expHome + expAway;

          // 라인 대비 차이를 확률로 매핑 (10점 차 -> 약 0.16)
          const delta = expTotal - total;
          modelOver = clamp(0.5 + delta * 0.016, 0.05, 0.95);

          notes.push(`expTotal=${expTotal.toFixed(1)} line=${total.toFixed(1)} delta=${delta.toFixed(1)}`);
        } else {
          notes.push("noLast10 -> totalModel=0.50");
        }

        const market = 0.5;
        const edgePct = (modelOver - market) * 100;
        const confidence = confidenceFromEdgePct(edgePct);

        const gate = opts.relax ? Math.min(opts.minConfidence, 52) : Math.max(opts.minConfidence, 58);
        if (confidence >= gate) {
          const pick = `OVER ${total}`;
          candidates.push({
            gameId: g.id,
            date: g.date,
            type: "TOTAL",
            label: `${g.awayTeamName ?? g.awayTeamId} @ ${g.homeTeamName ?? g.homeTeamId}`,
            pick,
            line: total,
            modelProb: modelOver,
            marketProb: market,
            edgePct: Math.round(edgePct * 10) / 10,
            confidence,
            provider: odds?.provider ?? null,
            meta: {
              homeTeamId: g.homeTeamId,
              awayTeamId: g.awayTeamId,
              homeTeamName: g.homeTeamName,
              awayTeamName: g.awayTeamName,
              notes,
            },
          });
        }
      }

      // (C) ML fallback 후보 (라인 없을 때 or 후보 부족 시에도 생성 가능)
      if (opts.fallbackML && hasLast10) {
        const { pHome, notes } = estimateHomeWinProbFromLast10(h10!, a10!);

        // 시장확률: moneyline 있으면 implied, 없으면 0.5
        const impliedHome =
          impliedProbFromAmericanOdds(odds?.moneylineHome ?? null) ?? 0.5;

        const edgePct = (pHome - impliedHome) * 100;
        const confidence = confidenceFromEdgePct(edgePct);

        // ML은 변동 적어서 기본 gate 조금 낮게
        const gate = opts.relax ? Math.min(opts.minConfidence, 50) : Math.max(opts.minConfidence, 55);
        if (confidence >= gate) {
          candidates.push({
            gameId: g.id,
            date: g.date,
            type: "ML",
            label: `${g.awayTeamName ?? g.awayTeamId} @ ${g.homeTeamName ?? g.homeTeamId}`,
            pick: `HOME ML`,
            line: null,
            modelProb: pHome,
            marketProb: impliedHome,
            edgePct: Math.round(edgePct * 10) / 10,
            confidence,
            provider: odds?.provider ?? null,
            meta: {
              homeTeamId: g.homeTeamId,
              awayTeamId: g.awayTeamId,
              homeTeamName: g.homeTeamName,
              awayTeamName: g.awayTeamName,
              notes: [
                ...notes,
                `marketProb=${impliedHome.toFixed(3)} (moneylineHome or 0.5)`,
              ],
            },
          });
        }
      }
    }

    // 중복 제거(같은 게임 같은 타입은 confidence 높은 것만)
    const key = (c: CandidatePick) => `${c.gameId}:${c.type}`;
    const best = new Map<string, CandidatePick>();
    for (const c of candidates) {
      const k = key(c);
      const prev = best.get(k);
      if (!prev || c.confidence > prev.confidence) best.set(k, c);
    }

    // 정렬: confidence -> edgePct
    return Array.from(best.values()).sort((a, b) => {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      return b.edgePct - a.edgePct;
    });
  })();
}

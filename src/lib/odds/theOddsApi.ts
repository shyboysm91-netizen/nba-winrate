// src/lib/odds/theOddsApi.ts
/* eslint-disable no-console */

export type TheOddsApiResponse = {
  // 기존에서 odds.events 형태로 쓰는 전제 유지
  events: any[];
  // 기존 로직에 영향 없도록 optional 메타(추가 형태)
  _meta?: {
    source: "live" | "cache" | "stale-cache" | "fallback";
    fetchedAt: string;
    cacheKey: string;
    ttlMs: number;
    staleTtlMs: number;
    requestsRemaining?: number;
    requestsUsed?: number;
    requestsLastCost?: number;
    status?: number;
    error?: string;
  };
};

// ✅ 확정: 30분 캐시
const DEFAULT_TTL_MS = 30 * 60 * 1000;
// 오류 시 오래된 값(stale)로 버티기(운영 안정성) - 추가 형태
const DEFAULT_STALE_TTL_MS = 6 * 60 * 60 * 1000;
// 네트워크 타임아웃
const FETCH_TIMEOUT_MS = 8_000;

function numEnv(name: string, fallback: number) {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// env로 조절 가능(기본은 30분)
const TTL_MS = numEnv("ODDS_CACHE_TTL_MS", DEFAULT_TTL_MS);
const STALE_TTL_MS = numEnv("ODDS_CACHE_STALE_TTL_MS", DEFAULT_STALE_TTL_MS);

/**
 * ✅ “배당 없는 경기에도 의미 있는 배당” 생성용 기본값(최후 수단)
 * - 고정 fallback(-2 / 218) 대신, 환경변수로 조절 가능하게 "준배당" 기본값 제공
 */
const DEFAULT_EST_SPREAD_ABS = numEnv("ODDS_EST_DEFAULT_SPREAD_ABS", 2.5);
const DEFAULT_EST_TOTAL = numEnv("ODDS_EST_DEFAULT_TOTAL", 224);
const DEFAULT_EST_JUICE = numEnv("ODDS_EST_DEFAULT_JUICE", -110);

type CacheEntry = {
  value: TheOddsApiResponse;
  expiresAt: number; // fresh 만료
  staleExpiresAt: number; // stale 만료
};

declare global {
  // eslint-disable-next-line no-var
  var __ODDS_API_CACHE__: Map<string, CacheEntry> | undefined;

  // eslint-disable-next-line no-var
  var __ODDS_LINE_HISTORY__: {
    // 팀별 최근 라인
    team: Map<
      string,
      {
        spreadAbs?: number;
        total?: number;
        updatedAt: number;
        source: "REAL" | "ESTIMATED";
      }
    >;
    // 최근 fetch에서 계산한 리그 평균
    league: {
      spreadAbs?: number;
      total?: number;
      updatedAt: number;
      sampleCount: number;
    };
  } | undefined;
}

const cache: Map<string, CacheEntry> =
  globalThis.__ODDS_API_CACHE__ ?? (globalThis.__ODDS_API_CACHE__ = new Map());

const lineHistory =
  globalThis.__ODDS_LINE_HISTORY__ ??
  (globalThis.__ODDS_LINE_HISTORY__ = {
    team: new Map(),
    league: { updatedAt: 0, sampleCount: 0 },
  });

function now() {
  return Date.now();
}

function getFresh(cacheKey: string) {
  const e = cache.get(cacheKey);
  if (!e) return null;
  if (now() <= e.expiresAt) return e.value;
  return null;
}

function getStale(cacheKey: string) {
  const e = cache.get(cacheKey);
  if (!e) return null;
  if (now() <= e.staleExpiresAt) return e.value;
  return null;
}

function setCache(cacheKey: string, value: TheOddsApiResponse) {
  const t = now();
  cache.set(cacheKey, {
    value,
    expiresAt: t + TTL_MS,
    staleExpiresAt: t + STALE_TTL_MS,
  });
}

function buildOddsUrl(params?: {
  regions?: string;
  markets?: string;
  oddsFormat?: "american" | "decimal";
  dateFormat?: "iso" | "unix";
}) {
  const apiKey = process.env.THE_ODDS_API_KEY || process.env.ODDS_API_KEY || "";
  const regions = params?.regions ?? "us";
  const markets = params?.markets ?? "h2h,spreads,totals";
  const oddsFormat = params?.oddsFormat ?? "american";
  const dateFormat = params?.dateFormat ?? "iso";

  const base = `https://api.the-odds-api.com/v4/sports/basketball_nba/odds`;
  const url = new URL(base);
  url.searchParams.set("apiKey", apiKey);
  url.searchParams.set("regions", regions);
  url.searchParams.set("markets", markets);
  url.searchParams.set("oddsFormat", oddsFormat);
  url.searchParams.set("dateFormat", dateFormat);
  return url.toString();
}

async function fetchJsonWithTimeout(url: string) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
    });

    const headers = res.headers;
    const remaining = Number(headers.get("x-requests-remaining") ?? "");
    const used = Number(headers.get("x-requests-used") ?? "");
    const last = Number(headers.get("x-requests-last") ?? "");

    const status = res.status;
    let data: any = null;

    try {
      data = await res.json();
    } catch {
      data = null;
    }

    return {
      ok: res.ok,
      status,
      data,
      usage: {
        requestsRemaining: Number.isFinite(remaining) ? remaining : undefined,
        requestsUsed: Number.isFinite(used) ? used : undefined,
        requestsLastCost: Number.isFinite(last) ? last : undefined,
      },
    };
  } finally {
    clearTimeout(id);
  }
}

/**
 * -----------------------------
 * ✅ “배당 없는 경기” 추정 라인 생성 로직 (추가 형태)
 * - The Odds API 이벤트 구조를 유지하면서, spreads/totals가 없으면
 *   synthetic bookmaker("ESTIMATED")를 주입한다.
 * - downstream(/api/pick)의 기존 매칭 로직이 그대로 동작하도록
 *   bookmakers[].markets[] 형태로만 추가한다.
 * -----------------------------
 */

function safeNum(v: any): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function getSpreadsLineFromEvent(event: any): { spreadAbs: number; ok: boolean } | null {
  const home = event?.home_team;
  const away = event?.away_team;
  const bms: any[] = Array.isArray(event?.bookmakers) ? event.bookmakers : [];
  for (const bm of bms) {
    const markets: any[] = Array.isArray(bm?.markets) ? bm.markets : [];
    const spreads = markets.find((m) => m?.key === "spreads");
    if (!spreads || !Array.isArray(spreads?.outcomes)) continue;

    const oHome = spreads.outcomes.find((o: any) => o?.name === home);
    const oAway = spreads.outcomes.find((o: any) => o?.name === away);
    const pHome = safeNum(oHome?.point);
    const pAway = safeNum(oAway?.point);

    // spreads는 보통 홈/원정이 +/-(동일 절대값)
    if (pHome !== null) return { spreadAbs: Math.abs(pHome), ok: true };
    if (pAway !== null) return { spreadAbs: Math.abs(pAway), ok: true };
  }
  return null;
}

function getTotalsLineFromEvent(event: any): { total: number; ok: boolean } | null {
  const bms: any[] = Array.isArray(event?.bookmakers) ? event.bookmakers : [];
  for (const bm of bms) {
    const markets: any[] = Array.isArray(bm?.markets) ? bm.markets : [];
    const totals = markets.find((m) => m?.key === "totals");
    if (!totals || !Array.isArray(totals?.outcomes)) continue;

    // outcomes: Over/Under, 둘 다 같은 point가 일반적
    const oOver = totals.outcomes.find((o: any) => o?.name === "Over");
    const oUnder = totals.outcomes.find((o: any) => o?.name === "Under");
    const p = safeNum(oOver?.point) ?? safeNum(oUnder?.point);
    if (p !== null) return { total: p, ok: true };
  }
  return null;
}

function hasMarket(event: any, key: "spreads" | "totals") {
  const bms: any[] = Array.isArray(event?.bookmakers) ? event.bookmakers : [];
  for (const bm of bms) {
    const markets: any[] = Array.isArray(bm?.markets) ? bm.markets : [];
    if (markets.some((m) => m?.key === key && Array.isArray(m?.outcomes) && m.outcomes.length > 0)) {
      return true;
    }
  }
  return false;
}

function upsertTeamHistory(teamName: string, patch: Partial<{ spreadAbs: number; total: number }>, source: "REAL" | "ESTIMATED") {
  if (!teamName) return;
  const prev = lineHistory.team.get(teamName);
  const next = {
    spreadAbs: patch.spreadAbs ?? prev?.spreadAbs,
    total: patch.total ?? prev?.total,
    updatedAt: now(),
    source,
  };
  lineHistory.team.set(teamName, next);
}

function recomputeLeagueAveragesFromEvents(events: any[]) {
  let spreadsSum = 0;
  let spreadsN = 0;
  let totalsSum = 0;
  let totalsN = 0;

  for (const ev of events) {
    const sp = getSpreadsLineFromEvent(ev);
    if (sp && Number.isFinite(sp.spreadAbs) && sp.spreadAbs > 0) {
      spreadsSum += sp.spreadAbs;
      spreadsN += 1;
    }
    const tt = getTotalsLineFromEvent(ev);
    if (tt && Number.isFinite(tt.total) && tt.total > 0) {
      totalsSum += tt.total;
      totalsN += 1;
    }
  }

  const next = {
    spreadAbs: spreadsN > 0 ? spreadsSum / spreadsN : undefined,
    total: totalsN > 0 ? totalsSum / totalsN : undefined,
    updatedAt: now(),
    sampleCount: Math.max(spreadsN, totalsN),
  };

  // 샘플이 있으면 갱신, 없으면 기존 유지
  if (next.sampleCount > 0) {
    lineHistory.league = next;
  }
}

function pickEstimatedSpreadAbs(home: string, away: string): { value: number; sourceDetail: string } {
  const h = lineHistory.team.get(home);
  const a = lineHistory.team.get(away);

  // 1) 최근 동일 팀 라인 기반
  if (h?.spreadAbs && a?.spreadAbs) {
    const v = (h.spreadAbs + a.spreadAbs) / 2;
    return { value: roundToHalf(v), sourceDetail: "TEAM_RECENT_AVG" };
  }
  if (h?.spreadAbs) return { value: roundToHalf(h.spreadAbs), sourceDetail: "TEAM_HOME_RECENT" };
  if (a?.spreadAbs) return { value: roundToHalf(a.spreadAbs), sourceDetail: "TEAM_AWAY_RECENT" };

  // 2) 리그 평균
  if (lineHistory.league.spreadAbs) {
    return { value: roundToHalf(lineHistory.league.spreadAbs), sourceDetail: "LEAGUE_AVG" };
  }

  // 3) 기본 준배당
  return { value: roundToHalf(DEFAULT_EST_SPREAD_ABS), sourceDetail: "DEFAULT_ESTIMATE" };
}

function pickEstimatedTotal(home: string, away: string): { value: number; sourceDetail: string } {
  const h = lineHistory.team.get(home);
  const a = lineHistory.team.get(away);

  // 1) 최근 동일 팀 라인 기반
  if (h?.total && a?.total) {
    const v = (h.total + a.total) / 2;
    return { value: roundToHalf(v), sourceDetail: "TEAM_RECENT_AVG" };
  }
  if (h?.total) return { value: roundToHalf(h.total), sourceDetail: "TEAM_HOME_RECENT" };
  if (a?.total) return { value: roundToHalf(a.total), sourceDetail: "TEAM_AWAY_RECENT" };

  // 2) 리그 평균
  if (lineHistory.league.total) {
    return { value: roundToHalf(lineHistory.league.total), sourceDetail: "LEAGUE_AVG" };
  }

  // 3) 기본 준배당
  return { value: roundToHalf(DEFAULT_EST_TOTAL), sourceDetail: "DEFAULT_ESTIMATE" };
}

function roundToHalf(n: number) {
  // NBA 라인 관례상 0.5 단위가 흔함
  return Math.round(n * 2) / 2;
}

function ensureEstimatedBookmaker(event: any) {
  const home = event?.home_team;
  const away = event?.away_team;
  if (!home || !away) return event;

  const needSpreads = !hasMarket(event, "spreads");
  const needTotals = !hasMarket(event, "totals");
  if (!needSpreads && !needTotals) return event;

  const estSpread = pickEstimatedSpreadAbs(home, away);
  const estTotal = pickEstimatedTotal(home, away);

  const markets: any[] = [];

  if (needSpreads) {
    // 홈: -X / 원정: +X (기본 형태)
    const x = estSpread.value;
    markets.push({
      key: "spreads",
      outcomes: [
        { name: home, point: -x, price: DEFAULT_EST_JUICE },
        { name: away, point: x, price: DEFAULT_EST_JUICE },
      ],
      _meta: { provider: "ESTIMATED", sourceDetail: estSpread.sourceDetail },
    });
  }

  if (needTotals) {
    const t = estTotal.value;
    markets.push({
      key: "totals",
      outcomes: [
        { name: "Over", point: t, price: DEFAULT_EST_JUICE },
        { name: "Under", point: t, price: DEFAULT_EST_JUICE },
      ],
      _meta: { provider: "ESTIMATED", sourceDetail: estTotal.sourceDetail },
    });
  }

  const syntheticBookmaker = {
    key: "estimated",
    title: "ESTIMATED",
    last_update: new Date().toISOString(),
    markets,
    _meta: {
      provider: "ESTIMATED",
      spreadsSource: needSpreads ? estSpread.sourceDetail : "REAL",
      totalsSource: needTotals ? estTotal.sourceDetail : "REAL",
    },
  };

  const bms: any[] = Array.isArray(event?.bookmakers) ? event.bookmakers : [];
  const already = bms.some((b) => b?.key === "estimated" || b?.title === "ESTIMATED");
  const nextBookmakers = already ? bms : [...bms, syntheticBookmaker];

  // 팀 히스토리(ESTIMATED)도 저장: 단, REAL이 있으면 REAL이 우선적으로 들어가게 아래 단계에서 처리됨
  if (needSpreads) {
    upsertTeamHistory(home, { spreadAbs: estSpread.value }, "ESTIMATED");
    upsertTeamHistory(away, { spreadAbs: estSpread.value }, "ESTIMATED");
  }
  if (needTotals) {
    upsertTeamHistory(home, { total: estTotal.value }, "ESTIMATED");
    upsertTeamHistory(away, { total: estTotal.value }, "ESTIMATED");
  }

  return {
    ...event,
    bookmakers: nextBookmakers,
    _oddsMeta: {
      ...(event?._oddsMeta ?? {}),
      ensured: true,
      provider: "ESTIMATED",
      spreads: needSpreads ? { provider: "ESTIMATED", sourceDetail: estSpread.sourceDetail } : { provider: "REAL" },
      totals: needTotals ? { provider: "ESTIMATED", sourceDetail: estTotal.sourceDetail } : { provider: "REAL" },
    },
  };
}

function updateHistoryFromRealLines(events: any[]) {
  // REAL 라인이 있는 경우, 팀 히스토리에 REAL로 반영 (ESTIMATED보다 우선)
  for (const ev of events) {
    const home = ev?.home_team;
    const away = ev?.away_team;
    if (!home || !away) continue;

    const sp = getSpreadsLineFromEvent(ev);
    if (sp && Number.isFinite(sp.spreadAbs) && sp.spreadAbs > 0) {
      upsertTeamHistory(home, { spreadAbs: sp.spreadAbs }, "REAL");
      upsertTeamHistory(away, { spreadAbs: sp.spreadAbs }, "REAL");
    }

    const tt = getTotalsLineFromEvent(ev);
    if (tt && Number.isFinite(tt.total) && tt.total > 0) {
      upsertTeamHistory(home, { total: tt.total }, "REAL");
      upsertTeamHistory(away, { total: tt.total }, "REAL");
    }
  }
}

function enrichEventsWithEstimatedOdds(rawEvents: any[]) {
  const events = Array.isArray(rawEvents) ? rawEvents : [];

  // 1) 이번 fetch에서 REAL 샘플로 리그 평균 갱신
  recomputeLeagueAveragesFromEvents(events);

  // 2) REAL 라인이 있는 경기는 팀 히스토리 갱신(REAL 우선)
  updateHistoryFromRealLines(events);

  // 3) spreads/totals 없는 이벤트에 ESTIMATED bookmaker 주입
  return events.map((ev) => ensureEstimatedBookmaker(ev));
}

// ✅ 단일 진입점 유지
export async function fetchNbaOdds(): Promise<TheOddsApiResponse> {
  const url = buildOddsUrl();
  const cacheKey = url;

  // 1) fresh 캐시
  const fresh = getFresh(cacheKey);
  if (fresh) {
    return {
      ...fresh,
      _meta: {
        ...(fresh._meta ?? {}),
        source: "cache",
        fetchedAt: new Date().toISOString(),
        cacheKey,
        ttlMs: TTL_MS,
        staleTtlMs: STALE_TTL_MS,
      },
    };
  }

  // 2) live fetch
  try {
    const apiKey = process.env.THE_ODDS_API_KEY || process.env.ODDS_API_KEY;
    if (!apiKey) {
      return {
        events: [],
        _meta: {
          source: "fallback",
          fetchedAt: new Date().toISOString(),
          cacheKey,
          ttlMs: TTL_MS,
          staleTtlMs: STALE_TTL_MS,
          error: "Missing THE_ODDS_API_KEY/ODDS_API_KEY",
        },
      };
    }

    const r = await fetchJsonWithTimeout(url);

    // 정상 응답: 배열이면 events로 감싸서 유지
    if (r.ok && Array.isArray(r.data)) {
      const enriched = enrichEventsWithEstimatedOdds(r.data);

      const value: TheOddsApiResponse = {
        events: enriched,
        _meta: {
          source: "live",
          fetchedAt: new Date().toISOString(),
          cacheKey,
          ttlMs: TTL_MS,
          staleTtlMs: STALE_TTL_MS,
          status: r.status,
          ...r.usage,
        },
      };
      setCache(cacheKey, value);
      return value;
    }

    // 실패: stale 있으면 stale로
    const stale = getStale(cacheKey);
    if (stale) {
      return {
        ...stale,
        _meta: {
          ...(stale._meta ?? {}),
          source: "stale-cache",
          fetchedAt: new Date().toISOString(),
          cacheKey,
          ttlMs: TTL_MS,
          staleTtlMs: STALE_TTL_MS,
          status: r.status,
          ...r.usage,
          error:
            (r.data && (r.data.message || r.data.error)) ||
            "Non-OK response (using stale-cache)",
        },
      };
    }

    // stale도 없으면 기존 fallback 유지
    return {
      events: [],
      _meta: {
        source: "fallback",
        fetchedAt: new Date().toISOString(),
        cacheKey,
        ttlMs: TTL_MS,
        staleTtlMs: STALE_TTL_MS,
        status: r.status,
        ...r.usage,
        error:
          (r.data && (r.data.message || r.data.error)) ||
          "Non-OK response (no cache)",
      },
    };
  } catch (err: any) {
    const stale = getStale(cacheKey);
    if (stale) {
      return {
        ...stale,
        _meta: {
          ...(stale._meta ?? {}),
          source: "stale-cache",
          fetchedAt: new Date().toISOString(),
          cacheKey,
          ttlMs: TTL_MS,
          staleTtlMs: STALE_TTL_MS,
          error: err?.message || "Fetch failed (using stale-cache)",
        },
      };
    }

    return {
      events: [],
      _meta: {
        source: "fallback",
        fetchedAt: new Date().toISOString(),
        cacheKey,
        ttlMs: TTL_MS,
        staleTtlMs: STALE_TTL_MS,
        error: err?.message || "Fetch failed (no cache)",
      },
    };
  }
}

// (추가) 운영 중 캐시 강제 초기화가 필요할 때만 사용
export function __clearOddsCacheForDebug() {
  cache.clear();
}

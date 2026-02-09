import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";

import { fetchNBAGamesByKstDate } from "@/lib/nba/espn";
import { fetchNbaOdds, type NormalizedOdds } from "@/lib/odds/theOddsApi";

type ApiResp =
  | { ok: true; result: any }
  | { ok: false; error: string };

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

function baseConfidence(totalGames: number) {
  if (totalGames >= 10) return 80;
  if (totalGames >= 7) return 75;
  return 70;
}

/** KST YYYYMMDD */
function kstDateKeyNow() {
  const now = new Date();
  const s = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now); // YYYY-MM-DD
  return s.replaceAll("-", "");
}

function isProRow(row: any): boolean {
  if (!row) return false;
  if (typeof row.is_pro === "boolean") return row.is_pro;
  if (typeof row.is_active === "boolean") return row.is_active;
  if (typeof row.active === "boolean") return row.active;
  if (typeof row.status === "string") return row.status.toLowerCase() === "active";
  if (typeof row.plan === "string") return row.plan.toLowerCase().includes("pro");
  return false;
}

/** ✅ TOP3 내부 호출 플래그 (FREE 1회 제한 bypass 용) */
const INTERNAL_TOP3_HEADER = "x-internal-top3";

function isInternalTop3(req: Request) {
  try {
    const h = req.headers.get(INTERNAL_TOP3_HEADER);
    if (h && String(h).trim() === "1") return true;

    const { searchParams } = new URL(req.url);
    const q = searchParams.get("internal");
    if (q && String(q).trim() === "1") return true;
  } catch {}
  return false;
}

/** =========================
 * ✅ 초간단 인메모리 캐시 (서버리스 warm 인스턴스에서만 효과)
 * - games: 60초
 * - odds: 60초
 * ========================= */
type CacheItem<T> = { exp: number; val: T };
const gCache = globalThis as any;

const GAMES_CACHE_KEY = "__NBA_GAMES_CACHE__";
const ODDS_CACHE_KEY = "__NBA_ODDS_CACHE__";

if (!gCache[GAMES_CACHE_KEY]) gCache[GAMES_CACHE_KEY] = new Map<string, CacheItem<any>>();
if (!gCache[ODDS_CACHE_KEY]) gCache[ODDS_CACHE_KEY] = new Map<string, CacheItem<any>>();

const gamesCache: Map<string, CacheItem<any>> = gCache[GAMES_CACHE_KEY];
const oddsCache: Map<string, CacheItem<any>> = gCache[ODDS_CACHE_KEY];

function cacheGet<T>(m: Map<string, CacheItem<T>>, key: string): T | null {
  const hit = m.get(key);
  if (!hit) return null;
  if (Date.now() > hit.exp) {
    m.delete(key);
    return null;
  }
  return hit.val;
}
function cacheSet<T>(m: Map<string, CacheItem<T>>, key: string, val: T, ttlMs: number) {
  m.set(key, { val, exp: Date.now() + ttlMs });
}

async function fetchGamesCached(date?: string) {
  const key = `games:${date ?? "auto"}`;
  const cached = cacheGet<any>(gamesCache, key);
  if (cached) return cached;

  const res = await fetchNBAGamesByKstDate(date);
  cacheSet(gamesCache, key, res, 60 * 1000);
  return res;
}

async function fetchOddsCached() {
  const key = `odds:nba`;
  const cached = cacheGet<NormalizedOdds>(oddsCache, key);
  if (cached) return cached;

  const res = await fetchNbaOdds({ useConsensus: false });
  cacheSet(oddsCache, key, res, 60 * 1000);
  return res;
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

/**
 * ✅ FIX 1)
 * The Odds API 매칭은 "영문 풀팀명" 기준
 */
function extractTeamsFromEspnGame(g: any): { home: string; away: string } {
  const triHome = String(
    g?.home?.triCode ?? g?.home?.abbr ?? g?.home?.abbreviation ?? ""
  ).toUpperCase();
  const triAway = String(
    g?.away?.triCode ?? g?.away?.abbr ?? g?.away?.abbreviation ?? ""
  ).toUpperCase();

  const homeFromTri = TRI_TO_TEAM[triHome];
  const awayFromTri = TRI_TO_TEAM[triAway];

  const homeNameFallback =
    g?.homeTeam?.displayName ||
    g?.homeTeam?.name ||
    g?.home?.name ||
    (triHome ? triHome : "");

  const awayNameFallback =
    g?.awayTeam?.displayName ||
    g?.awayTeam?.name ||
    g?.away?.name ||
    (triAway ? triAway : "");

  return {
    home: homeFromTri ?? String(homeNameFallback ?? ""),
    away: awayFromTri ?? String(awayNameFallback ?? ""),
  };
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

async function getSupabaseAuthClient() {
  const cookieStore = await cookies();

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anon) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY");
  }

  return createServerClient(url, anon, {
    cookies: {
      getAll() {
        const anyStore: any = cookieStore as any;
        if (typeof anyStore.getAll === "function") {
          return anyStore.getAll().map((c: any) => ({ name: c.name, value: c.value }));
        }
        return [];
      },
      setAll(cookiesToSet) {
        const anyStore: any = cookieStore as any;
        if (typeof anyStore.set === "function") {
          cookiesToSet.forEach(({ name, value, options }) => {
            anyStore.set(name, value, options);
          });
        }
      },
    },
  });
}

export async function GET(req: Request) {
  try {
    const internalTop3 = isInternalTop3(req);

    // ✅ 로그인 필수
    const supabaseAuth = await getSupabaseAuthClient();
    const {
      data: { user },
      error: userErr,
    } = await supabaseAuth.auth.getUser();

    if (userErr) {
      return NextResponse.json<ApiResp>({ ok: false, error: userErr.message }, { status: 401 });
    }

    if (!user) {
      return NextResponse.json<ApiResp>(
        { ok: false, error: "로그인이 필요합니다." },
        { status: 401 }
      );
    }

    // ✅ subscriptions
    const { data: sub, error: subErr } = await supabaseAuth
      .from("subscriptions")
      .select("*")
      .eq("user_id", user.id)
      .maybeSingle();

    if (subErr) {
      return NextResponse.json<ApiResp>(
        { ok: false, error: `subscriptions 조회 실패: ${subErr.message}` },
        { status: 500 }
      );
    }

    const isPro = isProRow(sub);

    // ✅ FREE: KST 기준 하루 1경기 제한 (TOP3 내부 호출은 제외)
    if (!isPro && !internalTop3) {
      const dateKey = kstDateKeyNow();

      const { data: usage, error: usageErr } = await supabaseAuth
        .from("daily_usage")
        .select("pick_count")
        .eq("user_id", user.id)
        .eq("date_key", dateKey)
        .maybeSingle();

      if (usageErr) {
        return NextResponse.json<ApiResp>(
          { ok: false, error: `usage 조회 실패: ${usageErr.message}` },
          { status: 500 }
        );
      }

      const used = (usage?.pick_count ?? 0) >= 1;
      if (used) {
        return NextResponse.json<ApiResp>(
          { ok: false, error: "무료 사용자는 하루 1경기만 분석 가능합니다." },
          { status: 403 }
        );
      }

      const nextCount = (usage?.pick_count ?? 0) + 1;

      const { error: upsertErr } = await supabaseAuth.from("daily_usage").upsert(
        {
          user_id: user.id,
          date_key: dateKey,
          pick_count: nextCount,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,date_key" }
      );

      if (upsertErr) {
        return NextResponse.json<ApiResp>(
          { ok: false, error: `usage 저장 실패: ${upsertErr.message}` },
          { status: 500 }
        );
      }
    }

    const { searchParams } = new URL(req.url);
    const date = searchParams.get("date") || undefined;
    const gameId = searchParams.get("gameId") || "";

    if (!gameId.trim()) {
      return NextResponse.json<ApiResp>(
        { ok: false, error: "gameId가 필요합니다." },
        { status: 400 }
      );
    }

    // ✅ games 캐시 사용
    const { date: dateKst, games } = await fetchGamesCached(date);

    const g = (games || []).find((x: any) => String(x?.gameId) === String(gameId));
    if (!g) {
      return NextResponse.json<ApiResp>(
        { ok: false, error: "해당 gameId의 경기를 찾지 못했습니다." },
        { status: 404 }
      );
    }

    const homeTeamId = String(g?.home?.teamId ?? g?.home?.id ?? "");
    const awayTeamId = String(g?.away?.teamId ?? g?.away?.id ?? "");

    const triHome = String(g?.home?.triCode ?? "").toUpperCase();
    const triAway = String(g?.away?.triCode ?? "").toUpperCase();

    const homeName = g?.home?.name ?? TRI_TO_TEAM[triHome] ?? (triHome ? triHome : null);
    const awayName = g?.away?.name ?? TRI_TO_TEAM[triAway] ?? (triAway ? triAway : null);

    const conf0 = baseConfidence((games || []).length);

    let marketSpreadHome: number | null = null;
    let marketTotal: number | null = null;
    let marketProvider: string | null = null;

    try {
      // ✅ odds 캐시 사용 (TOP3에서 pick 여러번 호출해도 60초 안에 1번만 호출됨)
      const odds = await fetchOddsCached();
      const buckets = buildOddsBuckets(odds);

      const { home, away } = extractTeamsFromEspnGame(g);
      const key = makeMatchKey(home, away);
      const candidates = buckets.get(key) ?? [];

      const startIso =
        (g?.startTimeUTC as string | null) ??
        (g?.raw?.gameDateTimeUTC as string | null) ??
        (g?.raw?.gameTimeUTC as string | null) ??
        (g?.raw?.startTimeUTC as string | null) ??
        null;

      const matched = pickClosestEvent(candidates, startIso);

      if (matched) {
        const sp = matched.markets?.spreads;
        const tt = matched.markets?.totals;

        marketSpreadHome = typeof sp?.homePoint === "number" ? sp.homePoint : null;
        marketTotal = typeof tt?.point === "number" ? tt.point : null;

        const pb: any = matched.pickedBookmaker ?? null;
        marketProvider = (pb?.key ?? pb?.title ?? null) as string | null;
      }
    } catch {}

    const spreadHome =
      typeof marketSpreadHome === "number" && Number.isFinite(marketSpreadHome)
        ? marketSpreadHome
        : -2;

    const totalLine =
      typeof marketTotal === "number" && Number.isFinite(marketTotal)
        ? marketTotal
        : 218;

    const lineProvider = marketProvider ?? "MODEL_SIMPLE";

    const picks = [
      {
        type: "ML",
        confidence: conf0,
        provider: lineProvider,
        game: {
          gameId,
          date: dateKst,
          homeTeamId,
          awayTeamId,
          homeTeamName: homeName,
          awayTeamName: awayName,
        },
        ui: { pickSide: "HOME", pickTeamId: homeTeamId, pickTeamName: homeName },
        meta: { homeTeamId, awayTeamId },
      },
      {
        type: "SPREAD",
        confidence: clamp(conf0 - 3, 70, 90),
        provider: lineProvider,
        game: {
          gameId,
          date: dateKst,
          homeTeamId,
          awayTeamId,
          homeTeamName: homeName,
          awayTeamName: awayName,
        },
        ui: {
          pickSide: "HOME",
          pickTeamId: homeTeamId,
          pickTeamName: homeName,
          pickLine: Number(spreadHome),
        },
        meta: { homeTeamId, awayTeamId },
      },
      {
        type: "TOTAL",
        confidence: clamp(conf0 - 5, 70, 85),
        provider: lineProvider,
        game: {
          gameId,
          date: dateKst,
          homeTeamId,
          awayTeamId,
          homeTeamName: homeName,
          awayTeamName: awayName,
        },
        ui: { pickTotal: "OVER", totalLine: Number(totalLine) },
        meta: { homeTeamId, awayTeamId },
      },
    ];

    return NextResponse.json<ApiResp>({
      ok: true,
      result: {
        date: dateKst,
        gameId,
        spreadHome: marketSpreadHome,
        total: marketTotal,
        provider: marketProvider,
        picks,
      },
    });
  } catch (e: any) {
    return NextResponse.json<ApiResp>(
      { ok: false, error: String(e?.message ?? e) },
      { status: 500 }
    );
  }
}

/* =========================
   🔥 POST 어댑터 (GET 그대로 재사용)
   - JSON body 없어도 동작 (쿼리 fallback)
   - TOP3 내부 호출 헤더 추가
   ========================= */
export async function POST(req: Request) {
  const url = new URL(req.url);

  const body = await req.json().catch(() => null);
  const gameId = body?.gameId ?? url.searchParams.get("gameId");
  const date = body?.date ?? url.searchParams.get("date");

  if (!gameId) {
    return NextResponse.json<ApiResp>(
      { ok: false, error: "gameId가 필요합니다." },
      { status: 400 }
    );
  }

  url.searchParams.set("gameId", String(gameId));
  if (date) url.searchParams.set("date", String(date));

  const headers = new Headers(req.headers);
  headers.set(INTERNAL_TOP3_HEADER, "1");

  const getReq = new Request(url.toString(), {
    method: "GET",
    headers,
  });

  return GET(getReq);
}

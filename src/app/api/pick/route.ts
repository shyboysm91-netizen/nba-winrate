// src/app/api/pick/route.ts
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";

import { getOfficialGamesForDashboard } from "@/lib/nba/nbaOfficial";
import { fetchNbaOdds } from "@/lib/odds/theOddsApi";

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
function kstDateKeyNow() {
  const now = new Date();
  const s = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  return s.replaceAll("-", "");
}
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
function ymdToDateKey(ymd: string) {
  return ymd.replaceAll("-", "");
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
function extractTeamsFromEspnLikeGame(g: any): { home: string; away: string } {
  const triHome = String(g?.home?.triCode ?? g?.home?.abbr ?? g?.home?.abbreviation ?? "").toUpperCase();
  const triAway = String(g?.away?.triCode ?? g?.away?.abbr ?? g?.away?.abbreviation ?? "").toUpperCase();

  const homeFromTri = TRI_TO_TEAM[triHome];
  const awayFromTri = TRI_TO_TEAM[triAway];

  const homeNameFallback =
    g?.homeTeam?.displayName || g?.homeTeam?.name || g?.home?.name || (triHome ? triHome : "");
  const awayNameFallback =
    g?.awayTeam?.displayName || g?.awayTeam?.name || g?.away?.name || (triAway ? triAway : "");

  return {
    home: homeFromTri ?? String(homeNameFallback ?? ""),
    away: awayFromTri ?? String(awayNameFallback ?? ""),
  };
}

type NormalizedOdds = {
  events: Array<{
    homeTeam: string;
    awayTeam: string;
    commenceTime: string | null;
    markets: {
      spreads?: {
        homePoint: number | null;
        awayPoint: number | null;
        provider: string | null;
        sourceDetail?: string | null;
      };
      totals?: {
        point: number | null;
        provider: string | null;
        sourceDetail?: string | null;
      };
    };
    pickedBookmaker?: { key?: string; title?: string } | null;
  }>;
};

function safeNum(v: any): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function readSpreadsFromEvent(ev: any) {
  const home = String(ev?.home_team ?? "");
  const away = String(ev?.away_team ?? "");
  const bms: any[] = Array.isArray(ev?.bookmakers) ? ev.bookmakers : [];

  // 1) REAL 우선: ESTIMATED 아닌 북메이커에서 spreads 먼저 찾기
  const ordered = [
    ...bms.filter((b) => String(b?.title ?? b?.key ?? "").toUpperCase() !== "ESTIMATED" && String(b?.key ?? "") !== "estimated"),
    ...bms.filter((b) => String(b?.title ?? b?.key ?? "").toUpperCase() === "ESTIMATED" || String(b?.key ?? "") === "estimated"),
  ];

  for (const bm of ordered) {
    const markets: any[] = Array.isArray(bm?.markets) ? bm.markets : [];
    const m = markets.find((x) => x?.key === "spreads");
    if (!m || !Array.isArray(m?.outcomes) || m.outcomes.length === 0) continue;

    const oHome = m.outcomes.find((o: any) => String(o?.name ?? "") === home);
    const oAway = m.outcomes.find((o: any) => String(o?.name ?? "") === away);

    const homePoint = safeNum(oHome?.point);
    const awayPoint = safeNum(oAway?.point);

    if (homePoint === null && awayPoint === null) continue;

    const provider = String(bm?.title ?? bm?.key ?? "") || null;
    const sourceDetail =
      (m?._meta?.provider === "ESTIMATED" ? String(m?._meta?.sourceDetail ?? "") : "") || null;

    return {
      homePoint,
      awayPoint,
      provider,
      sourceDetail,
      pickedBookmaker: { key: bm?.key, title: bm?.title },
    };
  }

  return null;
}

function readTotalsFromEvent(ev: any) {
  const bms: any[] = Array.isArray(ev?.bookmakers) ? ev.bookmakers : [];

  const ordered = [
    ...bms.filter((b) => String(b?.title ?? b?.key ?? "").toUpperCase() !== "ESTIMATED" && String(b?.key ?? "") !== "estimated"),
    ...bms.filter((b) => String(b?.title ?? b?.key ?? "").toUpperCase() === "ESTIMATED" || String(b?.key ?? "") === "estimated"),
  ];

  for (const bm of ordered) {
    const markets: any[] = Array.isArray(bm?.markets) ? bm.markets : [];
    const m = markets.find((x) => x?.key === "totals");
    if (!m || !Array.isArray(m?.outcomes) || m.outcomes.length === 0) continue;

    const oOver = m.outcomes.find((o: any) => String(o?.name ?? "") === "Over");
    const oUnder = m.outcomes.find((o: any) => String(o?.name ?? "") === "Under");
    const point = safeNum(oOver?.point) ?? safeNum(oUnder?.point);

    if (point === null) continue;

    const provider = String(bm?.title ?? bm?.key ?? "") || null;
    const sourceDetail =
      (m?._meta?.provider === "ESTIMATED" ? String(m?._meta?.sourceDetail ?? "") : "") || null;

    return {
      point,
      provider,
      sourceDetail,
      pickedBookmaker: { key: bm?.key, title: bm?.title },
    };
  }

  return null;
}

function normalizeOdds(raw: any): NormalizedOdds {
  const rawEvents: any[] = Array.isArray(raw?.events) ? raw.events : [];
  const events = rawEvents.map((ev) => {
    const homeTeam = String(ev?.home_team ?? "");
    const awayTeam = String(ev?.away_team ?? "");
    const commenceTime = (ev?.commence_time ?? ev?.commenceTime ?? null) ? String(ev?.commence_time ?? ev?.commenceTime) : null;

    const sp = readSpreadsFromEvent(ev);
    const tt = readTotalsFromEvent(ev);

    const pickedBookmaker =
      (sp?.pickedBookmaker ?? null) ||
      (tt?.pickedBookmaker ?? null) ||
      (ev?._oddsMeta?.provider ? { title: String(ev._oddsMeta.provider) } : null);

    return {
      homeTeam,
      awayTeam,
      commenceTime,
      markets: {
        spreads: sp
          ? { homePoint: sp.homePoint, awayPoint: sp.awayPoint, provider: sp.provider, sourceDetail: sp.sourceDetail }
          : undefined,
        totals: tt ? { point: tt.point, provider: tt.provider, sourceDetail: tt.sourceDetail } : undefined,
      },
      pickedBookmaker,
    };
  });

  return { events };
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
function pickClosestEvent(candidates: NormalizedOdds["events"][number][], startTimeUtcIso: string | null) {
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
  if (!url || !anon) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY");

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

function getOfficialGameId(x: any): string {
  return String(
    x?.gameId ??
      x?.id ??
      x?.game_id ??
      x?.gameCode ??
      x?.gamecode ??
      x?.gameCodeId ??
      x?.gameCodeID ??
      x?.gameKey ??
      x?.game_key ??
      ""
  );
}
function getOfficialStartTimeUTC(x: any): string | null {
  const iso =
    x?.startTimeUTC ??
    x?.startTimeUtc ??
    x?.gameTimeUTC ??
    x?.gameTimeUtc ??
    x?.utcTime ??
    x?.startTime ??
    x?.dateTimeUTC ??
    x?.gameDateTimeUTC ??
    x?.gameDateTimeUtc ??
    x?.commence_time ??
    x?.commenceTime ??
    null;

  if (!iso) return null;
  const ms = Date.parse(String(iso));
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}
function getOfficialTeam(side: "home" | "away", x: any) {
  const t =
    (side === "home" ? x?.home : x?.away) ??
    (side === "home" ? x?.homeTeam : x?.awayTeam) ??
    {};

  const teamId = String(
    t?.teamId ??
      t?.id ??
      t?.team_id ??
      (side === "home" ? x?.homeTeamId : x?.awayTeamId) ??
      ""
  );

  const triCode = String(
    t?.triCode ??
      t?.abbr ??
      t?.abbreviation ??
      t?.teamTricode ??
      (side === "home" ? x?.homeTricode : x?.awayTricode) ??
      ""
  ).toUpperCase();

  const name = String(
    t?.displayName ??
      t?.name ??
      t?.teamName ??
      (side === "home" ? x?.homeTeamName : x?.awayTeamName) ??
      (triCode ? triCode : "")
  );

  return {
    teamId: teamId || null,
    id: teamId || null,
    triCode: triCode || null,
    abbr: triCode || null,
    abbreviation: triCode || null,
    name: name || null,
    displayName: name || null,
    logo: t?.logo ?? t?.teamLogo ?? null,
  };
}
async function fetchOfficialGamesByDate(dateYmd: string) {
  const rawGames: any[] = await getOfficialGamesForDashboard(dateYmd as any);
  return Array.isArray(rawGames) ? rawGames : [];
}

export async function GET(req: Request) {
  try {
    const internalTop3 = isInternalTop3(req);

    const supabaseAuth = await getSupabaseAuthClient();
    const {
      data: { user },
      error: userErr,
    } = await supabaseAuth.auth.getUser();

    if (userErr) return NextResponse.json<ApiResp>({ ok: false, error: userErr.message }, { status: 401 });
    if (!user) return NextResponse.json<ApiResp>({ ok: false, error: "로그인이 필요합니다." }, { status: 401 });

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

      if ((usage?.pick_count ?? 0) >= 1) {
        return NextResponse.json<ApiResp>(
          { ok: false, error: "무료 사용자는 하루 1경기만 분석 가능합니다." },
          { status: 403 }
        );
      }

      const { error: upsertErr } = await supabaseAuth.from("daily_usage").upsert(
        {
          user_id: user.id,
          date_key: dateKey,
          pick_count: (usage?.pick_count ?? 0) + 1,
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
    const dateParam = searchParams.get("date") || "";
    const gameId = (searchParams.get("gameId") || "").trim();

    if (!gameId) return NextResponse.json<ApiResp>({ ok: false, error: "gameId가 필요합니다." }, { status: 400 });

    const dateYmd = dateParam ? normalizeDateParam(dateParam) : toYmdKST();
    if (!dateYmd) {
      return NextResponse.json<ApiResp>(
        { ok: false, error: "Invalid date. Use YYYY-MM-DD or YYYYMMDD." },
        { status: 400 }
      );
    }

    const officialGames = await fetchOfficialGamesByDate(dateYmd);
    let found = officialGames.find((x: any) => getOfficialGameId(x) === gameId);

    if (!found && dateYmd !== toYmdKST()) {
      const retryGames = await fetchOfficialGamesByDate(toYmdKST());
      found = retryGames.find((x: any) => getOfficialGameId(x) === gameId) ?? null;
    }

    if (!found) {
      return NextResponse.json<ApiResp>(
        { ok: false, error: "해당 gameId의 경기를 NBA 공식 일정에서 찾지 못했습니다." },
        { status: 404 }
      );
    }

    const g = {
      gameId,
      startTimeUTC: getOfficialStartTimeUTC(found),
      home: getOfficialTeam("home", found),
      away: getOfficialTeam("away", found),
      raw: found,
    };

    const dateKst = ymdToDateKey(dateYmd);

    const homeTeamId = String(g?.home?.teamId ?? g?.home?.id ?? "");
    const awayTeamId = String(g?.away?.teamId ?? g?.away?.id ?? "");

    const triHome = String(g?.home?.triCode ?? "").toUpperCase();
    const triAway = String(g?.away?.triCode ?? "").toUpperCase();

    const homeName = g?.home?.name ?? TRI_TO_TEAM[triHome] ?? (triHome ? triHome : null);
    const awayName = g?.away?.name ?? TRI_TO_TEAM[triAway] ?? (triAway ? triAway : null);

    const conf0 = baseConfidence((officialGames || []).length);

    let marketSpreadHome: number | null = null;
    let marketTotal: number | null = null;
    let marketProvider: string | null = null;

    try {
      const rawOdds = await fetchNbaOdds();
      const odds = normalizeOdds(rawOdds);
      const buckets = buildOddsBuckets(odds);

      const { home, away } = extractTeamsFromEspnLikeGame(g);
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

        // ✅ provider 우선순위: spreads/totals 쪽 provider > pickedBookmaker
        marketProvider =
          (sp?.provider || null) ??
          (tt?.provider || null) ??
          ((matched.pickedBookmaker?.key ?? matched.pickedBookmaker?.title ?? null) as string | null);
      }
    } catch {}

    // ✅ 최후 fallback도 "준배당" 기본값으로 의미 있게
    const spreadHome =
      typeof marketSpreadHome === "number" && Number.isFinite(marketSpreadHome)
        ? marketSpreadHome
        : -2.5;

    const totalLine =
      typeof marketTotal === "number" && Number.isFinite(marketTotal)
        ? marketTotal
        : 224;

    const lineProvider = marketProvider ?? "MODEL_SIMPLE";

    const picks = [
      {
        type: "ML",
        confidence: conf0,
        provider: lineProvider,
        game: { gameId, date: dateKst, homeTeamId, awayTeamId, homeTeamName: homeName, awayTeamName: awayName },
        ui: { pickSide: "HOME", pickTeamId: homeTeamId, pickTeamName: homeName },
        meta: { homeTeamId, awayTeamId },
      },
      {
        type: "SPREAD",
        confidence: clamp(conf0 - 3, 70, 90),
        provider: lineProvider,
        game: { gameId, date: dateKst, homeTeamId, awayTeamId, homeTeamName: homeName, awayTeamName: awayName },
        ui: { pickSide: "HOME", pickTeamId: homeTeamId, pickTeamName: homeName, pickLine: Number(spreadHome) },
        meta: { homeTeamId, awayTeamId },
      },
      {
        type: "TOTAL",
        confidence: clamp(conf0 - 5, 70, 85),
        provider: lineProvider,
        game: { gameId, date: dateKst, homeTeamId, awayTeamId, homeTeamName: homeName, awayTeamName: awayName },
        ui: { pickTotal: "OVER", totalLine: Number(totalLine) },
        meta: { homeTeamId, awayTeamId },
      },
    ];

    return NextResponse.json<ApiResp>({
      ok: true,
      result: {
        date: dateKst,
        gameId,
        spreadHome,
        total: totalLine,
        provider: lineProvider,
        picks,
        game: g,
      },
    });
  } catch (e: any) {
    return NextResponse.json<ApiResp>({ ok: false, error: String(e?.message ?? e) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const url = new URL(req.url);
  const body = await req.json().catch(() => null);

  const gameId = body?.gameId ?? url.searchParams.get("gameId");
  const date = body?.date ?? url.searchParams.get("date");

  if (!gameId) {
    return NextResponse.json<ApiResp>({ ok: false, error: "gameId가 필요합니다." }, { status: 400 });
  }

  url.searchParams.set("gameId", String(gameId));
  if (date) url.searchParams.set("date", String(date));

  const headers = new Headers(req.headers);
  headers.set(INTERNAL_TOP3_HEADER, "1");

  const getReq = new Request(url.toString(), { method: "GET", headers });
  return GET(getReq);
}

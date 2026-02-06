import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createRouteHandlerClient } from "@supabase/auth-helpers-nextjs";
import { createClient } from "@supabase/supabase-js";

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
  const homeName =
    g?.home?.name ||
    g?.homeTeam?.displayName ||
    g?.homeTeam?.name ||
    TRI_TO_TEAM[String(g?.home?.triCode ?? "").toUpperCase()] ||
    String(g?.home?.triCode ?? "");

  const awayName =
    g?.away?.name ||
    g?.awayTeam?.displayName ||
    g?.awayTeam?.name ||
    TRI_TO_TEAM[String(g?.away?.triCode ?? "").toUpperCase()] ||
    String(g?.away?.triCode ?? "");

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

export async function GET(req: Request) {
  try {
    // ✅ 로그인 필수
    const supabaseAuth = createRouteHandlerClient({ cookies });
    const {
      data: { user },
    } = await supabaseAuth.auth.getUser();

    if (!user) {
      return NextResponse.json<ApiResp>({ ok: false, error: "로그인이 필요합니다." }, { status: 401 });
    }

    // ✅ 서비스 롤로 subscriptions + daily_usage 체크
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
    const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

    const { data: sub } = await admin
      .from("subscriptions")
      .select("*")
      .eq("user_id", user.id)
      .maybeSingle();

    const isPro = isProRow(sub);

    // ✅ FREE: KST 기준 하루 1경기 제한
    if (!isPro) {
      const dateKey = kstDateKeyNow();

      const { data: usage } = await admin
        .from("daily_usage")
        .select("pick_count")
        .eq("user_id", user.id)
        .eq("date_key", dateKey)
        .maybeSingle();

      const used = (usage?.pick_count ?? 0) >= 1;
      if (used) {
        return NextResponse.json<ApiResp>(
          { ok: false, error: "무료 사용자는 하루 1경기만 분석 가능합니다." },
          { status: 403 }
        );
      }

      const nextCount = (usage?.pick_count ?? 0) + 1;
      const { error: upsertErr } = await admin.from("daily_usage").upsert(
        {
          user_id: user.id,
          date_key: dateKey,
          pick_count: nextCount,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,date_key" }
      );

      if (upsertErr) {
        return NextResponse.json<ApiResp>({ ok: false, error: "usage 저장 실패" }, { status: 500 });
      }
    }

    // ---- 기존 로직 유지 (분석/픽 생성) ----
    const { searchParams } = new URL(req.url);
    const date = searchParams.get("date") || undefined;
    const gameId = searchParams.get("gameId") || "";

    if (!gameId.trim()) {
      return NextResponse.json<ApiResp>(
        { ok: false, error: "gameId가 필요합니다." },
        { status: 400 }
      );
    }

    const { date: dateKst, games } = await fetchNBAGamesByKstDate(date);
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
      const odds = await fetchNbaOdds({ useConsensus: false });
      const buckets = buildOddsBuckets(odds);

      const { home, away } = extractTeamsFromEspnGame(g);
      const key = makeMatchKey(home, away);
      const candidates = buckets.get(key) ?? [];

      const matched = pickClosestEvent(candidates, g?.startTimeUTC ?? null);

      if (matched) {
        const sp = matched.markets?.spreads;
        const tt = matched.markets?.totals;

        marketSpreadHome = typeof sp?.homePoint === "number" ? sp.homePoint : null;
        marketTotal = typeof tt?.point === "number" ? tt.point : null;

        const pb: any = matched.pickedBookmaker ?? null;
        marketProvider = (pb?.key ?? pb?.title ?? null) as string | null;
      }
    } catch {
      // odds 실패해도 픽 생성은 계속
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
        spreadHome: marketSpreadHome, // 실제 시장 라인(없으면 null)
        total: marketTotal, // 실제 시장 라인(없으면 null)
        provider: marketProvider, // (없으면 null)
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

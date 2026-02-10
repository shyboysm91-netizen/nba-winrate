// src/app/api/top3/route.ts
import { NextResponse } from "next/server";
import { requirePaid } from "@/lib/subscription/requirePaid";
import { getOfficialGamesForDashboard } from "@/lib/nba/nbaOfficial";

// ✅ 핵심: fetch가 아니라 /api/pick 라우트 핸들러를 직접 호출해서 재사용
import { POST as pickPOST } from "@/app/api/pick/route";

type ApiResp =
  | { ok: true; result: any }
  | { ok: false; error: string };

const INTERNAL_TOP3_HEADER = "x-internal-top3";

function toYmdKST(date = new Date()) {
  const kst = new Date(date.toLocaleString("en-US", { timeZone: "Asia/Seoul" }));
  const y = kst.getFullYear();
  const m = String(kst.getMonth() + 1).padStart(2, "0");
  const d = String(kst.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
function ymdToDateKey(ymd: string) {
  return ymd.replaceAll("-", "");
}
function normalizeDateParam(v: string) {
  const raw = String(v ?? "").trim();
  if (/^\d{8}$/.test(raw)) return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  return "";
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

/** ✅ 상태값: FINAL/취소/연기/중단 계열만 제외 */
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

async function fetchOfficialGamesByDate(dateYmd: string) {
  const rawGames: any[] = await getOfficialGamesForDashboard(dateYmd as any);
  const games = Array.isArray(rawGames) ? rawGames : [];
  return { date: ymdToDateKey(dateYmd), games };
}

/**
 * ✅ 날짜 선택
 * - date 쿼리 있으면 그 날짜
 * - 없으면 오늘(없으면 내일)
 */
async function resolveAutoDate(explicitDate?: string) {
  if (explicitDate) {
    const ymd = normalizeDateParam(explicitDate);
    if (ymd) return await fetchOfficialGamesByDate(ymd);
  }

  const todayYmd = toYmdKST();
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowYmd = toYmdKST(tomorrow);

  const todayRes = await fetchOfficialGamesByDate(todayYmd);
  const hasToday =
    Array.isArray(todayRes.games) &&
    todayRes.games.some((g) => isAnalyzableStatus(g?.status ?? g?.statusText));
  if (hasToday) return todayRes;

  return await fetchOfficialGamesByDate(tomorrowYmd);
}

type PickType = "ML" | "SPREAD" | "TOTAL";

function getConf(x: any) {
  const n = Number(x?.confidence ?? x?.score ?? x?.trust ?? -1);
  return Number.isFinite(n) ? n : -1;
}

function deepProvider(node: any): string | null {
  if (!node || typeof node !== "object") return null;
  const direct =
    node.provider ??
    node.lineProvider ??
    node.base ??
    node.book ??
    node.bookmaker ??
    node?.ui?.provider ??
    node?.ui?.base ??
    node?.ui?.book ??
    node?.ui?.bookmaker ??
    node?.meta?.provider ??
    node?.meta?.base ??
    node?.meta?.book ??
    node?.meta?.bookmaker ??
    node?.odds?.provider ??
    node?.market?.provider ??
    null;
  return direct ? String(direct) : null;
}

function deepSpreadLine(node: any): number | null {
  const raw =
    node?.ui?.pickLine ??
    node?.pickLine ??
    node?.line ??
    node?.handicap ??
    node?.spread ??
    node?.lines?.spreadHome ??
    node?.lines?.spread ??
    node?.odds?.spread ??
    node?.market?.spread ??
    node?.meta?.spread ??
    null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function deepTotalLine(node: any): number | null {
  const raw =
    node?.ui?.totalLine ??
    node?.totalLine ??
    node?.line ??
    node?.total ??
    node?.lines?.total ??
    node?.odds?.total ??
    node?.market?.total ??
    node?.meta?.total ??
    null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * ✅ /api/pick POST 핸들러를 직접 호출 (세션/쿠키 유지)
 * ✅ 내부호출 헤더 포함(무료 제한 우회)
 */
async function callPickViaHandler(req: Request, gameId: string, dateKst: string) {
  const url = new URL(req.url);
  const pickUrl = `${url.origin}/api/pick`;

  const cookie = req.headers.get("cookie") || "";
  const authorization = req.headers.get("authorization") || "";

  const pickReq = new Request(pickUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
      authorization,
      [INTERNAL_TOP3_HEADER]: "1",
    },
    body: JSON.stringify({ gameId, date: dateKst }),
  });

  const res = await pickPOST(pickReq);
  const status = (res as Response).status;

  let json: any = null;
  try {
    json = await (res as Response).json();
  } catch {
    json = null;
  }

  const logicalOk =
    status >= 200 &&
    status < 300 &&
    (json?.ok === true || typeof json?.ok === "undefined");

  return { ok: logicalOk, status, json };
}

function normalizePickItem(item: any, gameMeta: any, type: PickType) {
  const provider = deepProvider(item) ?? null;

  const spreadLine = type === "SPREAD" ? deepSpreadLine(item) : null;
  const totalLine = type === "TOTAL" ? deepTotalLine(item) : null;

  if (type === "SPREAD" && spreadLine === null) return null;
  if (type === "TOTAL" && totalLine === null) return null;

  return {
    ...item,
    type,
    provider,
    game: item?.game ?? gameMeta,
    ui: {
      ...(item?.ui ?? {}),
      ...(type === "SPREAD" ? { pickLine: Number(spreadLine) } : {}),
      ...(type === "TOTAL" ? { totalLine: Number(totalLine) } : {}),
    },
  };
}

function gidOf(x: any) {
  return String(x?.game?.gameId ?? x?.gameId ?? "");
}

/**
 * ✅ 핵심: "경기 다양성" 우선
 * - 글로벌 usedGames에 있는 경기는 가능한 한 피해서 뽑는다.
 * - 그래도 부족하면(경기 수 부족) 그때만 재사용 허용
 */
function pickTopNWithGlobalDiversity(items: any[], n: number, usedGames: Set<string>) {
  const sorted = [...items].sort((a, b) => getConf(b) - getConf(a));

  const out: any[] = [];
  const localUsed = new Set<string>();

  // 1) 글로벌 중복 피하면서 뽑기
  for (const it of sorted) {
    const gid = gidOf(it);
    if (!gid) continue;
    if (usedGames.has(gid)) continue;
    if (localUsed.has(gid)) continue;
    localUsed.add(gid);
    out.push(it);
    if (out.length >= n) break;
  }

  // 2) 그래도 부족하면: 글로벌 중복 허용(단, 같은 타입 내에서는 경기 중복은 최대한 피함)
  if (out.length < n) {
    for (const it of sorted) {
      const gid = gidOf(it);
      if (!gid) continue;
      if (localUsed.has(gid)) continue;
      localUsed.add(gid);
      out.push(it);
      if (out.length >= n) break;
    }
  }

  // 3) 그래도 부족하면: 타입 내 중복도 허용(경기 수가 너무 적은 날)
  if (out.length < n) {
    for (const it of sorted) {
      if (out.includes(it)) continue;
      out.push(it);
      if (out.length >= n) break;
    }
  }

  // 글로벌 사용 경기 업데이트 (1~2단계에서 뽑힌 게임)
  for (const it of out) {
    const gid = gidOf(it);
    if (gid) usedGames.add(gid);
  }

  return out;
}

export async function GET(req: Request) {
  try {
    await requirePaid();

    const { searchParams } = new URL(req.url);
    const explicitDate = searchParams.get("date") || undefined;

    const { date: dateKst, games } = await resolveAutoDate(explicitDate);

    if (!Array.isArray(games) || games.length === 0) {
      return NextResponse.json({
        ok: true,
        result: { date: dateKst, totalGames: 0, candidates: 0, top3: [], note: "해당 날짜 경기 없음" },
      } satisfies ApiResp);
    }

    const mlPool: any[] = [];
    const spPool: any[] = [];
    const ttPool: any[] = [];

    let pickCalled = 0;
    let pickOk = 0;
    let excludedPickFail = 0;
    let excludedNoPicksArray = 0;
    let excludedNotAnalyzable = 0;

    for (const rawGame of games) {
      const gameId = getOfficialGameId(rawGame);
      if (!gameId) continue;

      const statusRaw = rawGame?.status ?? rawGame?.statusText ?? "";
      if (!isAnalyzableStatus(statusRaw)) {
        excludedNotAnalyzable += 1;
        continue;
      }

      const home = getOfficialTeam("home", rawGame);
      const away = getOfficialTeam("away", rawGame);

      const homeTeamId = String(home?.teamId ?? "");
      const awayTeamId = String(away?.teamId ?? "");
      if (!homeTeamId || !awayTeamId) continue;

      const gameMeta = {
        gameId,
        date: dateKst,
        homeTeamId,
        awayTeamId,
        homeTeamName: home?.name ?? null,
        awayTeamName: away?.name ?? null,
      };

      pickCalled += 1;
      const pr = await callPickViaHandler(req, gameId, dateKst);

      if (!pr.ok || !pr.json) {
        excludedPickFail += 1;
        continue;
      }
      pickOk += 1;

      const payload = (pr.json?.result ?? pr.json?.data ?? pr.json) ?? null;
      const picks = Array.isArray(payload?.picks) ? payload.picks : null;

      if (!picks) {
        excludedNoPicksArray += 1;
        continue;
      }

      for (const p of picks) {
        const t = String(p?.type ?? "").toUpperCase() as PickType;
        if (t !== "ML" && t !== "SPREAD" && t !== "TOTAL") continue;

        const normalized = normalizePickItem(p, gameMeta, t);
        if (!normalized) continue;

        if (t === "ML") mlPool.push(normalized);
        if (t === "SPREAD") spPool.push(normalized);
        if (t === "TOTAL") ttPool.push(normalized);
      }
    }

    // ✅ 글로벌 다양성 적용: ML -> SPREAD -> TOTAL 순서로 "경기 중복 최소화"
    const usedGames = new Set<string>();
    const ml3 = pickTopNWithGlobalDiversity(mlPool, 3, usedGames);
    const sp3 = pickTopNWithGlobalDiversity(spPool, 3, usedGames);
    const tt3 = pickTopNWithGlobalDiversity(ttPool, 3, usedGames);

    const top9 = [...ml3, ...sp3, ...tt3];

    return NextResponse.json({
      ok: true,
      result: {
        date: dateKst,
        totalGames: games.length,
        candidates: top9.length,
        top3: top9,
        note:
          "TOP3는 최근 10경기 흐름을 중심으로 팀 컨디션과 경기 맥락을 분석해, 가능한 한 다양한 경기로 ML/핸디/언오버를 혼합 추천합니다.",
        meta: {
          pickCalled,
          pickOk,
          mlPool: mlPool.length,
          spPool: spPool.length,
          ttPool: ttPool.length,
          usedGamesCount: usedGames.size,
          excludedPickFail,
          excludedNoPicksArray,
          excludedNotAnalyzable,
        },
      },
    } satisfies ApiResp);
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: String(e?.message ?? e) },
      { status: 500 }
    );
  }
}

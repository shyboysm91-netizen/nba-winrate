import { NextResponse } from "next/server";
import { requirePaid } from "@/lib/subscription/requirePaid";
import { fetchNBAGamesByKstDate } from "@/lib/nba/espn";
import { POST as pickPOST } from "@/app/api/pick/route";

type ApiResp =
  | { ok: true; result: any }
  | { ok: false; error: string };

function yyyymmddLocal(addDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + addDays);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

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

function hasAnalyzableGames(games: any[]) {
  return (games || []).some((g) => isAnalyzableStatus(g?.status));
}

async function resolveAutoDate(explicitDate?: string) {
  if (explicitDate) return await fetchNBAGamesByKstDate(explicitDate);

  const today = yyyymmddLocal(0);
  const tomorrow = yyyymmddLocal(1);

  const todayRes = await fetchNBAGamesByKstDate(today);
  if (
    Array.isArray(todayRes?.games) &&
    todayRes.games.length > 0 &&
    hasAnalyzableGames(todayRes.games)
  ) {
    return todayRes;
  }

  return await fetchNBAGamesByKstDate(tomorrow);
}

function unwrapPick(json: any) {
  if (!json || typeof json !== "object") return json;
  if (json.result && typeof json.result === "object") return json.result;
  if (json.data && typeof json.data === "object") return json.data;
  return json;
}

type PickType = "ML" | "SPREAD" | "TOTAL";

function isModelSimple(provider: any) {
  return String(provider ?? "").toUpperCase() === "MODEL_SIMPLE";
}

function isDefaultFallbackOdds(spread?: any, total?: any) {
  const s = Number(spread);
  const t = Number(total);
  return Number.isFinite(s) && Number.isFinite(t) && s === -2 && t === 218;
}

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
  if (!node || typeof node !== "object") return null;
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
  if (!node || typeof node !== "object") return null;
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

function scanPicksByUiSignature(pickPayloadRaw: any): Array<{ type: PickType; item: any }> {
  const root = unwrapPick(pickPayloadRaw);
  const out: Array<{ type: PickType; item: any }> = [];
  const seen = new Set<any>();

  const classify = (node: any): PickType | null => {
    if (!node || typeof node !== "object") return null;

    const ui = node.ui;
    if (!ui || typeof ui !== "object") return null;

    const pickLine = Number(ui.pickLine ?? node.pickLine ?? node.line ?? node.handicap);
    const totalLine = Number(ui.totalLine ?? node.totalLine ?? node.total ?? node.line);

    if (Number.isFinite(pickLine)) return "SPREAD";
    if (Number.isFinite(totalLine) || ui.pickTotal) return "TOTAL";

    const hasTeam = Boolean(ui.pickTeamId || ui.pickTeamName);
    const hasSide = Boolean(ui.pickSide);
    if (hasTeam && hasSide) return "ML";

    return null;
  };

  const walk = (node: any) => {
    if (!node || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);

    const t = classify(node);
    if (t) out.push({ type: t, item: node });

    if (Array.isArray(node)) {
      for (const it of node) walk(it);
      return;
    }

    for (const k of Object.keys(node)) walk((node as any)[k]);
  };

  walk(root);
  return out;
}

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

/** ✅ 동시성 제한 병렬 실행 */
async function mapLimit<T, R>(
  arr: T[],
  limit: number,
  fn: (item: T, idx: number) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(arr.length) as any;
  let i = 0;

  const workers = new Array(Math.max(1, Math.min(limit, arr.length))).fill(0).map(async () => {
    while (true) {
      const idx = i++;
      if (idx >= arr.length) break;
      out[idx] = await fn(arr[idx], idx);
    }
  });

  await Promise.all(workers);
  return out;
}

function pickTop3DistinctByGame(items: any[], used: Set<string>) {
  const sorted = [...items].sort((a, b) => getConf(b) - getConf(a));
  const out: any[] = [];
  for (const it of sorted) {
    const gid = String(it?.game?.gameId ?? it?.gameId ?? "");
    if (!gid) continue;
    if (used.has(gid)) continue;
    used.add(gid);
    out.push(it);
    if (out.length >= 3) break;
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
        result: {
          date: dateKst,
          totalGames: 0,
          candidates: 0,
          top3: [],
          note: "해당 날짜 경기 없음",
        },
      } satisfies ApiResp);
    }

    const targets = (games || [])
      .filter((g: any) => {
        const gameId = String(g?.gameId ?? "");
        if (!gameId) return false;
        if (!isAnalyzableStatus(g?.status)) return false;
        const homeTeamId = String(g?.home?.teamId ?? "");
        const awayTeamId = String(g?.away?.teamId ?? "");
        if (!homeTeamId || !awayTeamId) return false;
        return true;
      })
      .map((g: any) => ({
        gameId: String(g.gameId),
        homeTeamId: String(g?.home?.teamId ?? ""),
        awayTeamId: String(g?.away?.teamId ?? ""),
        homeTeamName: g?.home?.name ?? null,
        awayTeamName: g?.away?.name ?? null,
      }));

    const mlAll: any[] = [];
    const spAll: any[] = [];
    const ttAll: any[] = [];

    let pickCalled = 0;
    let pickOk = 0;

    let excludedPickFail = 0;
    let excludedNoProvider = 0;
    let excludedModelSimple = 0;
    let excludedFallback = 0;
    let excludedNoLine = 0;

    let firstPickShape: any = null;

    // ✅ 병렬(동시성 4)로 pick 호출
    const results = await mapLimit(
      targets,
      4,
      async (t) => {
        pickCalled += 1;
        const pr = await callPickViaHandler(req, t.gameId, dateKst);
        return { t, pr };
      }
    );

    for (const { t, pr } of results) {
      if (!pr.ok || !pr.json) {
        excludedPickFail += 1;
        continue;
      }
      pickOk += 1;

      const payload = unwrapPick(pr.json);

      if (!firstPickShape) {
        firstPickShape = {
          pickStatus: pr.status,
          envelopeKeys: pr.json ? Object.keys(pr.json) : null,
          payloadKeys: payload ? Object.keys(payload) : null,
          providerGuess: deepProvider(payload),
          spreadGuess: deepSpreadLine(payload),
          totalGuess: deepTotalLine(payload),
        };
      }

      const payloadProvider = deepProvider(payload);
      const payloadSpread = deepSpreadLine(payload);
      const payloadTotal = deepTotalLine(payload);

      const scanned = scanPicksByUiSignature(pr.json);

      for (const { type, item } of scanned) {
        const provider = deepProvider(item) ?? payloadProvider;
        if (!provider) {
          excludedNoProvider += 1;
          continue;
        }
        if (isModelSimple(provider)) {
          excludedModelSimple += 1;
          continue;
        }

        const spreadLine = deepSpreadLine(item) ?? payloadSpread;
        const totalLine = deepTotalLine(item) ?? payloadTotal;

        if (isDefaultFallbackOdds(spreadLine ?? undefined, totalLine ?? undefined)) {
          excludedFallback += 1;
          continue;
        }

        if (type === "SPREAD" && spreadLine === null) {
          excludedNoLine += 1;
          continue;
        }
        if (type === "TOTAL" && totalLine === null) {
          excludedNoLine += 1;
          continue;
        }

        const normalized = {
          ...item,
          type,
          provider,
          game: item?.game ?? {
            gameId: t.gameId,
            date: dateKst,
            homeTeamId: t.homeTeamId,
            awayTeamId: t.awayTeamId,
            homeTeamName: t.homeTeamName,
            awayTeamName: t.awayTeamName,
          },
          ui: {
            ...(item?.ui ?? {}),
            ...(type === "SPREAD" ? { pickLine: Number(spreadLine) } : {}),
            ...(type === "TOTAL" ? { totalLine: Number(totalLine) } : {}),
          },
        };

        if (type === "ML") mlAll.push(normalized);
        if (type === "SPREAD") spAll.push(normalized);
        if (type === "TOTAL") ttAll.push(normalized);
      }
    }

    const used = new Set<string>();
    const ml3 = pickTop3DistinctByGame(mlAll, used);
    const sp3 = pickTop3DistinctByGame(spAll, used);
    const tt3 = pickTop3DistinctByGame(ttAll, used);

    const top9 = [...ml3, ...sp3, ...tt3];

    return NextResponse.json({
      ok: true,
      result: {
        date: dateKst,
        totalGames: games.length,
        candidates: top9.length,
        top3: top9,
        note:
          "TOP3는 /api/pick POST 핸들러를 직접 호출해(재사용) ML/핸디/언오버를 추출. MODEL_SIMPLE/기본값(-2,218) 제외. 9개 모두 서로 다른 경기.",
        meta: {
          pickCalled,
          pickOk,
          mlFound: mlAll.length,
          spFound: spAll.length,
          ttFound: ttAll.length,
          excludedPickFail,
          excludedNoProvider,
          excludedModelSimple,
          excludedFallback,
          excludedNoLine,
          firstPickShape,
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

// src/lib/nba/espn.ts
// ✅ pick/route.ts + games/route.ts 호환 유지
// ✅ ESPN scoreboard가 특정 날짜에 404를 주는 경우가 있어 폴백(오늘 재시도) 추가
// ✅ (추가) analyzeGame.ts 빌드 오류 해결용: fetchNBATeamLast10 export 제공

type FetchByKstDateResult = {
  date: string; // KST YYYYMMDD
  games: any[];
};

export type Last10Row = {
  wl: string; // "W" | "L" | 기타
  date?: string | null; // ISO or YYYY-MM-DD
  opponentId?: string | null;
  opponentName?: string | null;
  homeAway?: "HOME" | "AWAY" | null;
  scoreFor?: number | null;
  scoreAgainst?: number | null;
};

function kstDateKey(date: Date) {
  const s = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date); // YYYY-MM-DD
  return s.replaceAll("-", "");
}

function parseInputDateToKstKey(date?: string) {
  if (!date) return kstDateKey(new Date());

  const d = String(date).trim();
  if (/^\d{8}$/.test(d)) return d;
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d.replaceAll("-", "");

  return kstDateKey(new Date());
}

async function fetchEspnScoreboardRawByDates(yyyymmdd: string) {
  const url =
    `https://site.web.api.espn.com/apis/v2/sports/basketball/nba/scoreboard` +
    `?dates=${encodeURIComponent(yyyymmdd)}`;

  const res = await fetch(url, { cache: "no-store" });

  // ✅ 404 등 에러 시 body까지 포함해서 에러 throw
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`ESPN scoreboard error (${res.status}) ${t}`);
  }

  return res.json();
}

function toIsoUtcFromEspnEvent(ev: any): string | null {
  const iso = ev?.date ?? ev?.competitions?.[0]?.date ?? null;
  if (!iso) return null;
  const ms = Date.parse(String(iso));
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function normalizeEventToGame(ev: any) {
  const gameId = String(ev?.id ?? "");
  if (!gameId) return null;

  const comp = Array.isArray(ev?.competitions) ? ev.competitions[0] : null;
  const competitors = Array.isArray(comp?.competitors) ? comp.competitors : [];

  const homeRaw = competitors.find((c: any) => c?.homeAway === "home") ?? null;
  const awayRaw = competitors.find((c: any) => c?.homeAway === "away") ?? null;

  const homeTeam = homeRaw?.team ?? {};
  const awayTeam = awayRaw?.team ?? {};

  const home = {
    teamId: homeTeam?.id != null ? String(homeTeam.id) : "",
    id: homeTeam?.id != null ? String(homeTeam.id) : "",
    triCode: String(homeTeam?.abbreviation ?? "").toUpperCase(),
    abbr: String(homeTeam?.abbreviation ?? "").toUpperCase(),
    abbreviation: String(homeTeam?.abbreviation ?? "").toUpperCase(),
    name: String(homeTeam?.displayName ?? homeTeam?.name ?? ""),
    displayName: String(homeTeam?.displayName ?? homeTeam?.name ?? ""),
  };

  const away = {
    teamId: awayTeam?.id != null ? String(awayTeam.id) : "",
    id: awayTeam?.id != null ? String(awayTeam.id) : "",
    triCode: String(awayTeam?.abbreviation ?? "").toUpperCase(),
    abbr: String(awayTeam?.abbreviation ?? "").toUpperCase(),
    abbreviation: String(awayTeam?.abbreviation ?? "").toUpperCase(),
    name: String(awayTeam?.displayName ?? awayTeam?.name ?? ""),
    displayName: String(awayTeam?.displayName ?? awayTeam?.name ?? ""),
  };

  const startTimeUTC = toIsoUtcFromEspnEvent(ev);

  return {
    gameId,
    startTimeUTC,
    home,
    away,
    raw: {
      id: ev?.id ?? null,
      date: ev?.date ?? null,
      competitions: ev?.competitions ?? null,
      status: ev?.status ?? null,
    },
  };
}

/**
 * ✅ 공통: 날짜로 ESPN 가져오되, 실패(특히 404)하면 "오늘"로 1회 폴백
 */
async function fetchScoreboardWithFallback(dateKey: string) {
  try {
    return await fetchEspnScoreboardRawByDates(dateKey);
  } catch (e) {
    // ✅ 폴백: 오늘 날짜로 재시도
    const todayKey = kstDateKey(new Date());
    if (todayKey !== dateKey) {
      try {
        return await fetchEspnScoreboardRawByDates(todayKey);
      } catch {
        // 둘 다 실패면 원래 에러 유지
      }
    }
    throw e;
  }
}

/**
 * ✅ games/route.ts 호환용 (raw scoreboard)
 */
export async function getNBAScoreboard(date?: string) {
  const dateKey = parseInputDateToKstKey(date);
  return fetchScoreboardWithFallback(dateKey);
}

/**
 * ✅ pick/route.ts가 사용하는 함수
 */
export async function fetchNBAGamesByKstDate(date?: string): Promise<FetchByKstDateResult> {
  const dateKey = parseInputDateToKstKey(date);

  // ✅ ESPN 404 폴백 포함
  const raw = await fetchScoreboardWithFallback(dateKey);

  const events = Array.isArray(raw?.events) ? raw.events : [];
  const games = events.map((ev: any) => normalizeEventToGame(ev)).filter(Boolean);

  // ⚠️ 폴백으로 오늘 데이터를 가져왔을 수도 있으니,
  // 반환 date는 "실제로 성공한 데이터" 기준으로 맞추고 싶다면 여기서 조정 가능.
  // 지금은 기존 로직 보호 위해 입력 dateKey 그대로 유지.
  return { date: dateKey, games };
}

/* ─────────────────────────────────────────────────────────────
 * ✅ (추가) 최근 10경기: 팀 Last10 (analyzeGame.ts 빌드 오류 해결)
 * - ESPN 팀 스케줄 API에서 최근 완료 경기만 골라 10개 반환
 * - 실패 시 [] 반환 (서비스 다운 방지)
 * ───────────────────────────────────────────────────────────── */

function inferNbaSeasonYearKst(now = new Date()) {
  // NBA 시즌은 대체로 10월 시작 → 다음 해 6월 종료
  // ESPN seasonYear는 "시즌 시작 연도"로 들어가는 경우가 많음
  const kst = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Seoul" }));
  const y = kst.getFullYear();
  const m = kst.getMonth() + 1;
  return m >= 9 ? y : y - 1;
}

async function fetchEspnTeamSchedule(teamId: string, seasonYear?: number) {
  const base = `https://site.web.api.espn.com/apis/v2/sports/basketball/nba/teams/${encodeURIComponent(
    teamId
  )}/schedule`;
  const url = new URL(base);

  // ESPN은 season/seasonType 파라미터를 받는 경우가 있음. (없어도 동작하는 케이스 있음)
  const sy = seasonYear ?? inferNbaSeasonYearKst();
  url.searchParams.set("season", String(sy));
  url.searchParams.set("seasontype", "2"); // 정규시즌(보통 2)

  const res = await fetch(url.toString(), { cache: "no-store" });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`ESPN team schedule error (${res.status}) ${t}`);
  }
  return res.json();
}

function tryNumber(v: any): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeScheduleItemToLast10Row(item: any, teamId: string): Last10Row | null {
  // item 형태는 ESPN이 종종 바뀜 → 최대한 방어적으로
  const competition = item?.competitions?.[0] ?? item?.competition ?? null;
  const competitors = Array.isArray(competition?.competitors)
    ? competition.competitors
    : Array.isArray(item?.competitors)
      ? item.competitors
      : [];

  const self =
    competitors.find((c: any) => String(c?.team?.id ?? c?.teamId ?? "") === String(teamId)) ?? null;
  const opp =
    competitors.find((c: any) => String(c?.team?.id ?? c?.teamId ?? "") !== String(teamId)) ?? null;

  const statusState =
    String(competition?.status?.type?.state ?? item?.status?.type?.state ?? "").toLowerCase();
  const statusName =
    String(competition?.status?.type?.name ?? item?.status?.type?.name ?? "").toLowerCase();

  // 완료 경기만
  const isFinal =
    statusState === "post" ||
    statusName.includes("final") ||
    statusName.includes("completed");

  if (!isFinal) return null;

  const dateIso = competition?.date ?? item?.date ?? null;
  const wl =
    String(self?.winner ?? "").toLowerCase() === "true"
      ? "W"
      : String(self?.winner ?? "").toLowerCase() === "false"
        ? "L"
        : String(item?.result ?? item?.outcome ?? "").toUpperCase() || "U";

  const homeAwayRaw = String(self?.homeAway ?? "").toLowerCase();
  const homeAway: "HOME" | "AWAY" | null =
    homeAwayRaw === "home" ? "HOME" : homeAwayRaw === "away" ? "AWAY" : null;

  const scoreFor = tryNumber(self?.score ?? self?.points ?? null);
  const scoreAgainst = tryNumber(opp?.score ?? opp?.points ?? null);

  const opponentId = String(opp?.team?.id ?? opp?.teamId ?? "") || null;
  const opponentName =
    String(opp?.team?.displayName ?? opp?.team?.name ?? opp?.team?.shortDisplayName ?? "") || null;

  return {
    wl,
    date: dateIso ? String(dateIso) : null,
    opponentId,
    opponentName,
    homeAway,
    scoreFor,
    scoreAgainst,
  };
}

/**
 * ✅ analyzeGame.ts에서 import하는 함수
 * - 팀 최근 10경기(완료 경기) 반환
 * - 실패 시 [] (빌드/런타임 안정성)
 */
export async function fetchNBATeamLast10(teamId: string, seasonYear?: number): Promise<Last10Row[]> {
  try {
    if (!teamId || !String(teamId).trim()) return [];

    const raw = await fetchEspnTeamSchedule(String(teamId).trim(), seasonYear);

    // ESPN 일정은 크게 2가지 케이스가 있음:
    // 1) events 배열
    // 2) leagues/season/weeks 구조
    const events = Array.isArray(raw?.events) ? raw.events : [];

    let candidates: any[] = [];
    if (events.length) {
      candidates = events;
    } else {
      // weeks/entries 쪽을 최대한 펼치기
      const weeks = Array.isArray(raw?.weeks) ? raw.weeks : [];
      for (const w of weeks) {
        const evs = Array.isArray(w?.events) ? w.events : [];
        candidates.push(...evs);
      }
    }

    const rows: Last10Row[] = [];
    for (const it of candidates) {
      const r = normalizeScheduleItemToLast10Row(it, String(teamId).trim());
      if (r) rows.push(r);
    }

    // 최신 10개 (날짜 내림차순)
    rows.sort((a, b) => {
      const am = a?.date ? Date.parse(String(a.date)) : NaN;
      const bm = b?.date ? Date.parse(String(b.date)) : NaN;
      if (!Number.isFinite(am) && !Number.isFinite(bm)) return 0;
      if (!Number.isFinite(am)) return 1;
      if (!Number.isFinite(bm)) return -1;
      return bm - am;
    });

    return rows.slice(0, 10);
  } catch {
    return [];
  }
}

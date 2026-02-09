// src/lib/nba/nbaOfficial.ts
/**
 * NBA 공식(nba.com CDN) 스케줄을 KST 날짜 기준으로 안정적으로 필터링해서
 * Dashboard가 기대하는 구조로 반환
 *
 * FIX:
 * - teamId가 number로 오는 경우가 많음 -> safeStr이 문자열만 받아서 teamId가 null로 떨어졌고,
 *   그 때문에 teamNameKr 매핑이 실패해서 영어로 보였음.
 * - 이제 string/number 모두 문자열로 변환해서 teamId/triCode를 확실히 채움.
 */

type AnyObj = Record<string, any>;

function safeStr(v: any): string | null {
  if (typeof v === "string") {
    const s = v.trim();
    return s ? s : null;
  }
  if (typeof v === "number" && Number.isFinite(v)) {
    return String(v);
  }
  return null;
}

function safeNum(v: any): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function todayYmdKST() {
  const kst = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Seoul" }));
  const y = kst.getFullYear();
  const m = String(kst.getMonth() + 1).padStart(2, "0");
  const d = String(kst.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

const kstFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function toKSTPartsFromISO(iso: string) {
  const dt = new Date(iso);
  const parts = kstFmt.formatToParts(dt);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const yyyy = get("year");
  const mm = get("month");
  const dd = get("day");
  const hh = get("hour");
  const mi = get("minute");
  return { dateKST: `${yyyy}-${mm}-${dd}`, timeKST: `${hh}:${mi}` };
}

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url, {
    cache: "no-store",
    headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`NBA fetch failed (${res.status}): ${t.slice(0, 200)}`);
  }
  return res.json();
}

function extractGameDates(scheduleJson: AnyObj): AnyObj[] {
  const gs = scheduleJson?.leagueSchedule ?? scheduleJson?.schedule ?? scheduleJson ?? {};
  const gameDates =
    (Array.isArray(gs?.gameDates) && gs.gameDates) ||
    (Array.isArray(gs?.dates) && gs.dates) ||
    [];
  return gameDates;
}

function pickFirst10Date(v: any): string | null {
  const s = safeStr(v);
  if (!s) return null;
  return s.length >= 10 ? s.slice(0, 10) : null;
}

function normalizeTeam(t: AnyObj) {
  // ✅ teamId가 number여도 문자열로 고정
  const teamId = safeStr(t?.teamId) ?? safeStr(t?.id) ?? null;

  // ✅ triCode도 number일 수는 거의 없지만 안전하게 처리
  const tri =
    safeStr(t?.teamTricode) ??
    safeStr(t?.triCode) ??
    safeStr(t?.abbreviation) ??
    safeStr(t?.teamAbbreviation) ??
    null;

  // ✅ 여기 name은 한국어로 바꿀 게 아니라, Dashboard가 teamNameKr로 바꾸도록 "fallback"만 넣어두면 됨
  //    (id가 제대로 들어가면 무조건 teamNameKr가 한국어로 치환)
  //    그래서 영어 풀네임을 굳이 합치지 않고, 짧게 유지
  const name =
    safeStr(t?.teamName) ??
    safeStr(t?.name) ??
    safeStr(t?.nickname) ??
    tri ??
    "팀";

  const logo =
    safeStr(t?.logo) ??
    (teamId ? `https://cdn.nba.com/logos/nba/${teamId}/global/L/logo.svg` : null);

  return {
    teamId,
    id: teamId,
    name,              // fallback용
    abbr: tri,
    triCode: tri,
    logo,
  };
}

function normalizeStatus(game: AnyObj) {
  const statusNum = safeNum(game?.gameStatus) ?? safeNum(game?.statusNum) ?? null;
  const statusText =
    safeStr(game?.gameStatusText) ??
    safeStr(game?.statusText) ??
    safeStr(game?.status) ??
    null;

  let state = "UNKNOWN";
  if (statusNum === 1) state = "SCHEDULED";
  else if (statusNum === 2) state = "IN_PROGRESS";
  else if (statusNum === 3) state = "FINAL";

  return { state, status: state, statusText };
}

function normalizeTimeKST(game: AnyObj) {
  const iso =
    safeStr(game?.gameDateTimeUTC) ??
    safeStr(game?.gameTimeUTC) ??
    safeStr(game?.gameDateTime) ??
    safeStr(game?.startTimeUTC) ??
    null;

  if (!iso) return { dateKST: null as string | null, timeKST: null as string | null, iso: null as string | null };

  const { dateKST, timeKST } = toKSTPartsFromISO(iso);
  return { dateKST, timeKST, iso };
}

async function fetchScheduleGamesByKstDate(dateYmd: string): Promise<AnyObj[]> {
  const scheduleUrl = "https://cdn.nba.com/static/json/staticData/scheduleLeagueV2_1.json";
  const schedule = await fetchJson(scheduleUrl);

  const gameDates = extractGameDates(schedule);

  // 1) gameDates[].gameDate 앞 10글자 매칭
  const buckets = gameDates.filter((d) => pickFirst10Date(d?.gameDate) === dateYmd);
  const direct: AnyObj[] = [];
  for (const b of buckets) if (Array.isArray(b?.games)) direct.push(...b.games);
  if (direct.length) return direct;

  // 2) gameDateEst 등 다른 키 대비
  const buckets2 = gameDates.filter((d) => pickFirst10Date(d?.gameDateEst) === dateYmd);
  const direct2: AnyObj[] = [];
  for (const b of buckets2) if (Array.isArray(b?.games)) direct2.push(...b.games);
  if (direct2.length) return direct2;

  // 3) 전체 스캔 fallback
  const scanned: AnyObj[] = [];
  for (const gd of gameDates) {
    const arr = Array.isArray(gd?.games) ? gd.games : [];
    for (const g of arr) {
      const { dateKST } = normalizeTimeKST(g);
      if (dateKST === dateYmd) scanned.push(g);
    }
  }
  return scanned;
}

async function fetchTodayOddsMap(): Promise<
  Map<string, { spreadHome: number | null; total: number | null; provider: string | null }>
> {
  const url = "https://cdn.nba.com/static/json/liveData/odds/odds_todaysGames.json";
  const json = await fetchJson(url);

  const games = Array.isArray(json?.games)
    ? json.games
    : Array.isArray(json?.odds?.games)
      ? json.odds.games
      : [];

  const map = new Map<string, { spreadHome: number | null; total: number | null; provider: string | null }>();

  for (const g of games) {
    const gameId = safeStr(g?.gameId) ?? safeStr(g?.id) ?? null;
    if (!gameId) continue;

    const provider =
      safeStr(g?.provider) ??
      safeStr(g?.bookName) ??
      safeStr(g?.sportsbook) ??
      safeStr(g?.book?.name) ??
      null;

    const spreadHome =
      safeNum(g?.spreadHome) ??
      safeNum(g?.homeSpread) ??
      safeNum(g?.spread) ??
      null;

    const total =
      safeNum(g?.total) ??
      safeNum(g?.overUnder) ??
      null;

    map.set(gameId, { spreadHome, total, provider });
  }

  return map;
}

export async function getOfficialGamesForDashboard(dateYmd: string): Promise<any[]> {
  const games = await fetchScheduleGamesByKstDate(dateYmd);

  const isToday = dateYmd === todayYmdKST();
  const oddsMap = isToday ? await fetchTodayOddsMap().catch(() => new Map()) : new Map();

  return games.map((g) => {
    const gameId = safeStr(g?.gameId) ?? safeStr(g?.id) ?? "";

    const homeTeamRaw = g?.homeTeam ?? g?.home ?? {};
    const awayTeamRaw = g?.awayTeam ?? g?.away ?? {};

    const home = normalizeTeam(homeTeamRaw);
    const away = normalizeTeam(awayTeamRaw);

    const { state, status, statusText } = normalizeStatus(g);
    const { dateKST, timeKST } = normalizeTimeKST(g);

    const kstText = dateKST && timeKST ? `${dateKST} ${timeKST} KST` : (statusText ?? "");

    const odds = oddsMap.get(gameId) ?? { spreadHome: null, total: null, provider: null };

    return {
      gameId,
      id: gameId,
      state,
      status,
      statusText: kstText,
      date: dateYmd,

      // ✅ 여기 teamId가 살아나면 Dashboard의 teamNameKr가 한국어로 바꿔서 보여줌
      home,
      away,

      odds: {
        markets: {
          spreads: { homePoint: typeof odds.spreadHome === "number" ? odds.spreadHome : null },
          totals: { point: typeof odds.total === "number" ? odds.total : null },
        },
        pickedBookmaker: {
          title: typeof odds.provider === "string" && odds.provider.trim() ? odds.provider : null,
          key: typeof odds.provider === "string" && odds.provider.trim() ? odds.provider : null,
        },
      },

      raw: g,
    };
  });
}

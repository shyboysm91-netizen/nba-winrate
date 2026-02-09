// src/lib/nba/espn.ts
/**
 * ✅ 중요: /api/pick/route.ts 가 기대하는 시그니처를 "원래대로" 맞춘다.
 * - fetchNBAGamesByKstDate(date?) => { date: "YYYYMMDD", games: any[] }
 *
 * 지금 games 화면은 NBA 공식 스케줄(nbaOfficial.ts)로 잘 나오고 있으니,
 * 분석(pick)도 동일 소스를 쓰도록 여기서 공식 스케줄을 사용한다.
 */

import { getOfficialGamesForDashboard } from "@/lib/nba/nbaOfficial";

function kstYmdToday(): string {
  const now = new Date();
  const s = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now); // YYYY-MM-DD
  return s;
}

function normalizeToYmd(input?: string | null): string {
  const raw = (input ?? "").trim();
  if (!raw) return kstYmdToday();

  // YYYYMMDD
  if (/^\d{8}$/.test(raw)) {
    return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  }

  // YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;

  // 그 외는 오늘로 처리(깨지지 않게)
  return kstYmdToday();
}

function ymdToKey(ymd: string): string {
  return ymd.replaceAll("-", "");
}

/**
 * ✅ /api/pick/route.ts 가 import 하는 함수 (복구)
 * - 반환: { date: YYYYMMDD, games: [...] }
 * - games는 Dashboard 호환 구조 (home/away/odds) 그대로
 */
export async function fetchNBAGamesByKstDate(date?: string | null): Promise<{ date: string; games: any[] }> {
  const ymd = normalizeToYmd(date);
  const key = ymdToKey(ymd);

  const games = await getOfficialGamesForDashboard(ymd); // 이미 Dashboard 호환 형태로 만들어짐

  // gameId/id는 무조건 문자열로 보장(매칭 안정화)
  const fixed = (games || []).map((g: any) => {
    const gameId = g?.gameId != null ? String(g.gameId) : (g?.id != null ? String(g.id) : "");
    return { ...g, gameId, id: gameId };
  });

  return { date: key, games: fixed };
}

/**
 * (옵션) 예전 ESPN 기반 함수가 다른 곳에서 필요할 수도 있어서 "빈 껍데기"로 유지 가능.
 * 지금 프로젝트 흐름에서는 공식 스케줄을 쓰고 있으니 pick/games는 위 함수로 해결된다.
 */
export async function getNBAScoreboard(_date: string): Promise<any[]> {
  // 기존 코드가 필요하면 여기에 ESPN 호출 로직을 유지해도 됨.
  // 현재는 사용처가 없어도 빌드/런타임 깨지지 않게 배열 반환.
  return [];
}

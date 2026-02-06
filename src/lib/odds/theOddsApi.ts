// src/lib/odds/theOddsApi.ts
import "server-only";

export type OddsMarket = "h2h" | "spreads" | "totals";

export type NormalizedOdds = {
  source: "theoddsapi";
  sportKey: "basketball_nba";
  fetchedAt: string; // ISO
  events: Array<{
    id: string;
    commenceTime: string; // ISO
    homeTeam: string;
    awayTeam: string;

    // "대표 라인" (한 북메이커/컨센서스에서 추출한 1세트)
    markets: {
      h2h?: {
        home: number | null; // american
        away: number | null; // american
      };
      spreads?: {
        homePoint: number | null; // e.g. -2.5
        homePrice: number | null; // american
        awayPoint: number | null; // e.g. +2.5
        awayPrice: number | null; // american
      };
      totals?: {
        point: number | null; // e.g. 218.5
        overPrice: number | null; // american
        underPrice: number | null; // american
      };
    };

    // 디버깅/확장용(원하면 UI에서 숨겨도 됨)
    pickedBookmaker?: {
      key: string;
      title: string;
      lastUpdate?: string;
    };
  }>;
  usage?: {
    requestsRemaining?: number | null;
    requestsUsed?: number | null;
  };
};

type TheOddsApiOutcome = {
  name: string; // team name OR "Over"/"Under"
  price: number; // american or decimal depending oddsFormat
  point?: number; // spread/total points
};

type TheOddsApiMarket = {
  key: OddsMarket;
  outcomes: TheOddsApiOutcome[];
};

type TheOddsApiBookmaker = {
  key: string;
  title: string;
  last_update?: string;
  markets: TheOddsApiMarket[];
};

type TheOddsApiEvent = {
  id: string;
  sport_key: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers?: TheOddsApiBookmaker[];
};

function median(nums: number[]): number | null {
  if (!nums.length) return null;
  const arr = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(arr.length / 2);
  if (arr.length % 2 === 0) return (arr[mid - 1] + arr[mid]) / 2;
  return arr[mid];
}

function pickBestBookmaker(
  books: TheOddsApiBookmaker[] | undefined,
  preferredBookmakers: string[]
): TheOddsApiBookmaker | null {
  if (!books?.length) return null;

  // 1) preferred bookmaker 우선
  for (const key of preferredBookmakers) {
    const found = books.find((b) => b.key === key);
    if (found) return found;
  }

  // 2) markets(h2h/spreads/totals) 가장 많이 갖춘 bookmaker
  const score = (b: TheOddsApiBookmaker) => {
    const keys = new Set(b.markets?.map((m) => m.key) ?? []);
    return keys.size;
  };

  let best = books[0];
  let bestScore = score(best);

  for (const b of books.slice(1)) {
    const s = score(b);
    if (s > bestScore) {
      best = b;
      bestScore = s;
    }
  }
  return best ?? null;
}

function findMarket(book: TheOddsApiBookmaker, key: OddsMarket): TheOddsApiMarket | null {
  return book.markets?.find((m) => m.key === key) ?? null;
}

function normalizeFromBookmaker(
  evt: TheOddsApiEvent,
  book: TheOddsApiBookmaker
): NormalizedOdds["events"][number]["markets"] {
  const markets: NormalizedOdds["events"][number]["markets"] = {};

  // h2h
  const h2h = findMarket(book, "h2h");
  if (h2h) {
    const home = h2h.outcomes.find((o) => o.name === evt.home_team)?.price ?? null;
    const away = h2h.outcomes.find((o) => o.name === evt.away_team)?.price ?? null;
    markets.h2h = { home, away };
  }

  // spreads
  const spreads = findMarket(book, "spreads");
  if (spreads) {
    const home = spreads.outcomes.find((o) => o.name === evt.home_team);
    const away = spreads.outcomes.find((o) => o.name === evt.away_team);
    markets.spreads = {
      homePoint: typeof home?.point === "number" ? home.point : null,
      homePrice: typeof home?.price === "number" ? home.price : null,
      awayPoint: typeof away?.point === "number" ? away.point : null,
      awayPrice: typeof away?.price === "number" ? away.price : null,
    };
  }

  // totals
  const totals = findMarket(book, "totals");
  if (totals) {
    const over = totals.outcomes.find((o) => o.name.toLowerCase() === "over");
    const under = totals.outcomes.find((o) => o.name.toLowerCase() === "under");
    markets.totals = {
      point: typeof over?.point === "number" ? over.point : typeof under?.point === "number" ? under.point : null,
      overPrice: typeof over?.price === "number" ? over.price : null,
      underPrice: typeof under?.price === "number" ? under.price : null,
    };
  }

  return markets;
}

/**
 * 컨센서스(북메이커 여러개)로 "대표 라인"을 만들고 싶을 때 사용.
 * - spreads: point는 median, price는 median
 * - totals: point는 median, over/under price는 median
 * - h2h: home/away price median
 */
function normalizeByConsensus(evt: TheOddsApiEvent): NormalizedOdds["events"][number]["markets"] {
  const books = evt.bookmakers ?? [];
  const markets: NormalizedOdds["events"][number]["markets"] = {};

  // h2h
  {
    const homePrices: number[] = [];
    const awayPrices: number[] = [];
    for (const b of books) {
      const m = findMarket(b, "h2h");
      if (!m) continue;
      const home = m.outcomes.find((o) => o.name === evt.home_team)?.price;
      const away = m.outcomes.find((o) => o.name === evt.away_team)?.price;
      if (typeof home === "number") homePrices.push(home);
      if (typeof away === "number") awayPrices.push(away);
    }
    const home = median(homePrices);
    const away = median(awayPrices);
    if (home !== null || away !== null) markets.h2h = { home, away };
  }

  // spreads
  {
    const homePoints: number[] = [];
    const awayPoints: number[] = [];
    const homePrices: number[] = [];
    const awayPrices: number[] = [];
    for (const b of books) {
      const m = findMarket(b, "spreads");
      if (!m) continue;
      const home = m.outcomes.find((o) => o.name === evt.home_team);
      const away = m.outcomes.find((o) => o.name === evt.away_team);
      if (typeof home?.point === "number") homePoints.push(home.point);
      if (typeof away?.point === "number") awayPoints.push(away.point);
      if (typeof home?.price === "number") homePrices.push(home.price);
      if (typeof away?.price === "number") awayPrices.push(away.price);
    }

    const hp = median(homePoints);
    const ap = median(awayPoints);
    const hpr = median(homePrices);
    const apr = median(awayPrices);

    if (hp !== null || ap !== null || hpr !== null || apr !== null) {
      markets.spreads = {
        homePoint: hp,
        homePrice: hpr,
        awayPoint: ap,
        awayPrice: apr,
      };
    }
  }

  // totals
  {
    const points: number[] = [];
    const overPrices: number[] = [];
    const underPrices: number[] = [];

    for (const b of books) {
      const m = findMarket(b, "totals");
      if (!m) continue;
      const over = m.outcomes.find((o) => o.name.toLowerCase() === "over");
      const under = m.outcomes.find((o) => o.name.toLowerCase() === "under");
      const p = typeof over?.point === "number" ? over.point : typeof under?.point === "number" ? under.point : undefined;
      if (typeof p === "number") points.push(p);
      if (typeof over?.price === "number") overPrices.push(over.price);
      if (typeof under?.price === "number") underPrices.push(under.price);
    }

    const pt = median(points);
    const op = median(overPrices);
    const up = median(underPrices);
    if (pt !== null || op !== null || up !== null) {
      markets.totals = {
        point: pt,
        overPrice: op,
        underPrice: up,
      };
    }
  }

  return markets;
}

export async function fetchNbaOdds(params?: {
  regions?: string; // default 'us'
  markets?: OddsMarket[]; // default ['h2h','spreads','totals']
  oddsFormat?: "american" | "decimal"; // default 'american'
  dateFormat?: "iso" | "unix"; // default 'iso'
  // bookmaker key list, e.g. ["draftkings","fanduel","pointsbetus","betrivers"]
  preferredBookmakers?: string[];
  // If true -> median consensus across books. Else -> pick 1 bookmaker best/ preferred.
  useConsensus?: boolean;
}): Promise<NormalizedOdds> {
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) {
    throw new Error("Missing env: ODDS_API_KEY");
  }

  const regions = params?.regions ?? process.env.ODDS_API_REGION ?? "us";
  const markets = (params?.markets ?? ["h2h", "spreads", "totals"]).join(",");
  const oddsFormat = params?.oddsFormat ?? "american";
  const dateFormat = params?.dateFormat ?? "iso";

  const preferredBookmakers =
    params?.preferredBookmakers ??
    (process.env.ODDS_API_BOOKMAKERS ? process.env.ODDS_API_BOOKMAKERS.split(",").map((s) => s.trim()).filter(Boolean) : []);

  const url = new URL("https://api.the-odds-api.com/v4/sports/basketball_nba/odds");
  url.searchParams.set("apiKey", apiKey);
  url.searchParams.set("regions", regions);
  url.searchParams.set("markets", markets);
  url.searchParams.set("oddsFormat", oddsFormat);
  url.searchParams.set("dateFormat", dateFormat);

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: { "accept": "application/json" },
    // 서버에서 항상 최신 라인(너무 캐시되면 안 됨)
    cache: "no-store",
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`TheOddsAPI error: ${res.status} ${res.statusText} ${text}`);
  }

  const data = (await res.json()) as TheOddsApiEvent[];

  const usageRemaining = Number(res.headers.get("x-requests-remaining"));
  const usageUsed = Number(res.headers.get("x-requests-used"));

  const useConsensus = params?.useConsensus ?? false;

  const events: NormalizedOdds["events"] = data
    .filter((e) => e.sport_key === "basketball_nba")
    .map((evt) => {
      const picked = pickBestBookmaker(evt.bookmakers, preferredBookmakers);

      const marketsNormalized = useConsensus
        ? normalizeByConsensus(evt)
        : picked
          ? normalizeFromBookmaker(evt, picked)
          : normalizeByConsensus(evt); // bookmaker 없으면 컨센서스도 비어있을 수 있음

      return {
        id: evt.id,
        commenceTime: evt.commence_time,
        homeTeam: evt.home_team,
        awayTeam: evt.away_team,
        markets: marketsNormalized,
        pickedBookmaker: picked
          ? { key: picked.key, title: picked.title, lastUpdate: picked.last_update }
          : undefined,
      };
    });

  return {
    source: "theoddsapi",
    sportKey: "basketball_nba",
    fetchedAt: new Date().toISOString(),
    events,
    usage: {
      requestsRemaining: Number.isFinite(usageRemaining) ? usageRemaining : null,
      requestsUsed: Number.isFinite(usageUsed) ? usageUsed : null,
    },
  };
}

export function kstDateFromIso(iso: string): string {
  // YYYY-MM-DD in Asia/Seoul
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
}

"use client";

import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { yyyymmddLocal } from "@/lib/ui/date";
import { teamNameKr } from "@/lib/ui/teams";
import { PickCard, Pill } from "@/components/dashboard/PickCard";
import HistoryPanel from "@/components/dashboard/HistoryPanel";
import type { Top3Response } from "@/components/dashboard/types";

type Props = { isPaid: boolean };
type GamesResponse = { ok: boolean; date?: string; games?: any[]; error?: string };

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-neutral-200 bg-white p-5">
      <div className="font-semibold">{title}</div>
      <div className="mt-3">{children}</div>
    </div>
  );
}

function isAnalyzableGame(g: any) {
  const s = String(g?.status ?? g?.state ?? "").toUpperCase();
  const t = String(g?.statusText ?? "").toUpperCase();
  const combined = `${s} ${t}`.trim();

  if (combined.includes("FINAL")) return false;
  if (combined.includes("COMPLETED")) return false;
  if (combined.includes("POSTPON")) return false;
  if (combined.includes("CANCEL")) return false;
  if (combined.includes("SUSPEND")) return false;
  if (combined.includes("DELAY")) return false;

  return true; // PRE/SCHEDULED/IN_PROGRESS 등
}

function getMarketSpreadHome(g: any): number | null {
  const v = g?.odds?.markets?.spreads?.homePoint;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function getMarketTotal(g: any): number | null {
  const v = g?.odds?.markets?.totals?.point;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function getMarketProvider(g: any): string | null {
  const v = g?.odds?.pickedBookmaker?.title ?? g?.odds?.pickedBookmaker?.key ?? null;
  return typeof v === "string" && v.trim() ? v : null;
}

export default function Dashboard({ isPaid }: Props) {
  const locked = !isPaid;
  const commonLockUI = (
    <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
      무료 상태라서 이 기능은 잠금이야. (유료 활성화 필요)
    </div>
  );

  const todayDate = useMemo(() => yyyymmddLocal(0), []);
  const tomorrowDate = useMemo(() => yyyymmddLocal(1), []);

  const [tab, setTab] = useState<"games" | "top3">("games");
  const [date, setDate] = useState<string>(() => yyyymmddLocal(1));

  const [todayLoading, setTodayLoading] = useState(false);
  const [todayError, setTodayError] = useState<string | null>(null);
  const [todayData, setTodayData] = useState<GamesResponse | null>(null);

  const [tomorrowLoading, setTomorrowLoading] = useState(false);
  const [tomorrowError, setTomorrowError] = useState<string | null>(null);
  const [tomorrowData, setTomorrowData] = useState<GamesResponse | null>(null);

  const [todayFallbackToTomorrow, setTodayFallbackToTomorrow] = useState(false);

  const [pickLoadingByGame, setPickLoadingByGame] = useState<Record<string, boolean>>({});
  const [pickErrorByGame, setPickErrorByGame] = useState<Record<string, string | null>>({});
  const [picksByGame, setPicksByGame] = useState<Record<string, any[]>>({});

  const [top3Loading, setTop3Loading] = useState(false);
  const [top3Error, setTop3Error] = useState<string | null>(null);
  const [top3Data, setTop3Data] = useState<Top3Response | null>(null);

  const fetchGames = async (dateStr: string, setLoading: any, setErr: any, setData: any) => {
    setErr(null);
    setLoading(true);
    try {
      const res = await fetch(`/api/games?date=${encodeURIComponent(dateStr)}`, { cache: "no-store" });
      const json = (await res.json()) as GamesResponse;
      if (!res.ok || !json.ok) {
        setErr(json.error || `요청 실패 (${res.status})`);
        setData(null);
        return null;
      }
      setData(json);
      return json;
    } catch (e: any) {
      setErr(String(e?.message ?? e));
      setData(null);
      return null;
    } finally {
      setLoading(false);
    }
  };

  const fetchToday = async () => {
    setTodayFallbackToTomorrow(false);
    const json = await fetchGames(todayDate, setTodayLoading, setTodayError, setTodayData);
    const games = Array.isArray(json?.games) ? json!.games! : [];
    const hasAnalyzable = games.some((g: any) => isAnalyzableGame(g));
    if (!hasAnalyzable) {
      setTodayFallbackToTomorrow(true);
      await fetchGames(tomorrowDate, setTomorrowLoading, setTomorrowError, setTomorrowData);
    }
  };

  const fetchTomorrow = () => fetchGames(tomorrowDate, setTomorrowLoading, setTomorrowError, setTomorrowData);

  const fetchPick = async (targetDate: string, gameId: string) => {
    setPickErrorByGame((p) => ({ ...p, [gameId]: null }));
    setPickLoadingByGame((p) => ({ ...p, [gameId]: true }));

    try {
      const res = await fetch(
        `/api/pick?date=${encodeURIComponent(targetDate)}&gameId=${encodeURIComponent(gameId)}`,
        { cache: "no-store" }
      );
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.ok) {
        setPickErrorByGame((p) => ({ ...p, [gameId]: json?.error ?? `요청 실패 (${res.status})` }));
        setPicksByGame((p) => ({ ...p, [gameId]: [] }));
        return;
      }
      const picks = Array.isArray(json?.result?.picks) ? json.result.picks : [];
      setPicksByGame((p) => ({ ...p, [gameId]: picks }));
    } catch (e: any) {
      setPickErrorByGame((p) => ({ ...p, [gameId]: String(e?.message ?? e) }));
      setPicksByGame((p) => ({ ...p, [gameId]: [] }));
    } finally {
      setPickLoadingByGame((p) => ({ ...p, [gameId]: false }));
    }
  };

  const fetchTop3 = async () => {
    setTop3Error(null);
    setTop3Loading(true);
    try {
      const res = await fetch(`/api/top3?date=${encodeURIComponent(date)}`, { cache: "no-store" });
      const json = (await res.json()) as Top3Response;
      if (!res.ok || !json.ok) {
        setTop3Error(json.error || `요청 실패 (${res.status})`);
        setTop3Data(null);
        return;
      }
      setTop3Data(json);
    } catch (e: any) {
      setTop3Error(String(e?.message ?? e));
      setTop3Data(null);
    } finally {
      setTop3Loading(false);
    }
  };

  const renderGames = (data: GamesResponse | null, targetDate: string) => {
    if (!data?.games) return null;

    return (
      <div className="mt-4 space-y-2">
        <div className="text-xs text-neutral-500">
          date: {data.date} / games: {data.games.length}
        </div>

        {data.games.map((g: any) => {
          const gameId = String(g.gameId);
          const awayId = String(g?.away?.teamId ?? g?.away?.id ?? "");
          const homeId = String(g?.home?.teamId ?? g?.home?.id ?? "");
          const awayName = teamNameKr(awayId, g?.away?.name ?? g?.away?.abbr ?? g?.away?.triCode);
          const homeName = teamNameKr(homeId, g?.home?.name ?? g?.home?.abbr ?? g?.home?.triCode);

          const picks = picksByGame[gameId] ?? [];
          const pickErr = pickErrorByGame[gameId] ?? null;
          const pickLoading = pickLoadingByGame[gameId] ?? false;

          const canAnalyze = isAnalyzableGame(g);

          const marketSpreadHome = getMarketSpreadHome(g);
          const marketTotal = getMarketTotal(g);
          const marketProvider = getMarketProvider(g);

          return (
            <div key={gameId} className="rounded-xl border border-neutral-200 p-3">
              <div className="flex items-center justify-between gap-3">
                <div className="font-semibold">
                  {awayName} vs {homeName}
                </div>
                <div className="text-xs text-neutral-500">
                  {g.state ?? g.status ?? "-"} / {g.statusText ?? "-"}
                </div>
              </div>

              <div className="mt-2 flex gap-2 text-xs text-neutral-600 flex-wrap">
                <Pill>spreadHome: {marketSpreadHome ?? "null"}</Pill>
                <Pill>total: {marketTotal ?? "null"}</Pill>
                <Pill>provider: {marketProvider ?? "null"}</Pill>
              </div>

              {canAnalyze ? (
                <div className="mt-3">
                  <button
                    onClick={() => fetchPick(targetDate, gameId)}
                    disabled={pickLoading}
                    className="rounded-xl bg-neutral-900 text-white px-4 py-2 text-sm font-medium disabled:opacity-50"
                  >
                    {pickLoading ? "분석 중..." : "이 경기 분석/픽 만들기"}
                  </button>

                  {pickErr ? (
                    <div className="mt-3 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">
                      {pickErr}
                    </div>
                  ) : null}

                  {picks.length ? (
                    <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3">
                      {picks.map((p: any, idx: number) => (
                        <PickCard key={`${gameId}-${idx}-${p?.type}`} p={p} />
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div className="mt-6 space-y-4">
      <div className="rounded-2xl border border-neutral-200 bg-white p-5">
        <div className="flex items-center gap-3">
          <div className="font-semibold">컨트롤</div>
          <div className="ml-auto flex items-center gap-2">
            <label className="text-xs text-neutral-600">TOP3 날짜(YYYYMMDD)</label>
            <input
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="w-[140px] rounded-xl border border-neutral-200 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-400"
              placeholder={tomorrowDate}
            />
            <button onClick={() => setDate(tomorrowDate)} className="rounded-xl border border-neutral-200 bg-white px-3 py-2 text-sm">
              내일로
            </button>
            <Pill>API: /api/games /api/top3 /api/pick</Pill>
          </div>
        </div>

        <div className="mt-4 flex gap-2">
          {[
            { key: "games" as const, label: "오늘/내일 경기" },
            { key: "top3" as const, label: "TOP3" },
          ].map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`rounded-xl px-4 py-2 text-sm font-medium border ${
                tab === t.key ? "bg-neutral-900 text-white border-neutral-900" : "bg-white text-neutral-900 border-neutral-200"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {tab === "games" && (
        <Card title="오늘/내일 경기">
          {locked ? (
            commonLockUI
          ) : (
            <div className="space-y-6">
              <div className="rounded-2xl border border-neutral-200 bg-white p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="font-semibold">오늘 경기</div>
                    <div className="text-xs text-neutral-500">date: {todayDate}</div>
                  </div>
                  <button
                    onClick={fetchToday}
                    disabled={todayLoading}
                    className="rounded-xl bg-neutral-900 text-white px-4 py-2 text-sm font-medium disabled:opacity-50"
                  >
                    {todayLoading ? "불러오는 중..." : "오늘 경기 불러오기"}
                  </button>
                </div>

                {todayError ? (
                  <div className="mt-3 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">{todayError}</div>
                ) : null}

                {renderGames(todayData, todayDate)}

                {todayFallbackToTomorrow ? (
                  <div className="mt-4 rounded-2xl border border-neutral-200 bg-neutral-50 p-4">
                    <div className="font-semibold text-neutral-900">
                      오늘에 분석 가능한 경기(시작 전/진행중)가 없어서, 내일 경기를 자동으로 보여줍니다.
                    </div>
                    <div className="mt-1 text-xs text-neutral-600">date: {tomorrowDate}</div>
                    {tomorrowError ? (
                      <div className="mt-3 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">
                        {tomorrowError}
                      </div>
                    ) : null}
                    {renderGames(tomorrowData, tomorrowDate)}
                  </div>
                ) : null}
              </div>

              <div className="rounded-2xl border border-neutral-200 bg-white p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="font-semibold">내일 경기</div>
                    <div className="text-xs text-neutral-500">date: {tomorrowDate}</div>
                  </div>
                  <button
                    onClick={fetchTomorrow}
                    disabled={tomorrowLoading}
                    className="rounded-xl bg-neutral-900 text-white px-4 py-2 text-sm font-medium disabled:opacity-50"
                  >
                    {tomorrowLoading ? "불러오는 중..." : "내일 경기 불러오기"}
                  </button>
                </div>

                {tomorrowError ? (
                  <div className="mt-3 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">{tomorrowError}</div>
                ) : null}

                {renderGames(tomorrowData, tomorrowDate)}
              </div>
            </div>
          )}
        </Card>
      )}

      {tab === "top3" && (
        <Card title="TOP3 추천 (승3/핸디3/언더오버3)">
          {locked ? (
            commonLockUI
          ) : (
            <>
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={fetchTop3}
                  disabled={top3Loading}
                  className="rounded-xl bg-neutral-900 text-white px-4 py-2 text-sm font-medium disabled:opacity-50"
                >
                  {top3Loading ? "불러오는 중..." : "TOP3 불러오기"}
                </button>
              </div>

              {top3Error ? (
                <div className="mt-3 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">{top3Error}</div>
              ) : null}

              {top3Data?.result ? (
                <div className="mt-4 space-y-5">
                  <div className="text-xs text-neutral-500">
                    date: {top3Data.result.date} / totalGames: {top3Data.result.totalGames} / candidates: {top3Data.result.candidates}
                  </div>

                  {top3Data.result.top3.length === 0 ? (
                    <div className="rounded-xl border border-neutral-200 bg-neutral-50 p-4 text-sm text-neutral-800">TOP3가 비어있어.</div>
                  ) : (
                    (() => {
                      const all = top3Data.result.top3 || [];
                      const ml = all.filter((x: any) => String(x?.type).toUpperCase() === "ML").slice(0, 3);
                      const sp = all.filter((x: any) => String(x?.type).toUpperCase() === "SPREAD").slice(0, 3);
                      const tt = all.filter((x: any) => String(x?.type).toUpperCase() === "TOTAL").slice(0, 3);

                      const sections = [
                        { title: "승 (머니라인) TOP3", items: ml },
                        { title: "핸디캡 TOP3", items: sp },
                        { title: "언더/오버 TOP3", items: tt },
                      ];

                      return (
                        <div className="space-y-6">
                          {sections.map((sec) => (
                            <div key={sec.title} className="space-y-3">
                              <div className="text-sm font-semibold text-neutral-900">{sec.title}</div>
                              <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                                {sec.items.map((p: any, idx: number) => (
                                  <PickCard key={`${sec.title}-${p?.game?.gameId}-${idx}`} p={p} />
                                ))}
                              </div>
                            </div>
                          ))}
                        </div>
                      );
                    })()
                  )}
                </div>
              ) : null}

              <HistoryPanel
                top3Data={top3Data}
                setTop3Data={setTop3Data}
                setTabTop3={() => setTab("top3")}
                setDate={setDate}
              />
            </>
          )}
        </Card>
      )}
    </div>
  );
}

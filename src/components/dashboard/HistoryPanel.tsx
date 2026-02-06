"use client";

import { useMemo, useState } from "react";
import { yyyymmddLocal } from "@/lib/ui/date";
import type { Top3Response } from "./types";

type HistoryItem = { id: number; date: string; created_at: string; payload: any };

type Props = {
  top3Data: Top3Response | null;
  setTop3Data: (v: Top3Response | null) => void;
  setTabTop3: () => void;
  setDate: (d: string) => void;
};

export default function HistoryPanel({ top3Data, setTop3Data, setTabTop3, setDate }: Props) {
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyItems, setHistoryItems] = useState<HistoryItem[]>([]);
  const [historyOpen, setHistoryOpen] = useState<Record<string, boolean>>({});

  const saveTop3 = async () => {
    setSaveMsg(null);
    const payload = top3Data?.result;
    if (!payload?.top3?.length) {
      setSaveMsg("저장할 TOP3가 없습니다.");
      return;
    }

    try {
      const res = await fetch("/api/top3/history", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ date: payload.date, payload }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.ok) {
        setSaveMsg(json?.error ?? `저장 실패 (${res.status})`);
        return;
      }
      setSaveMsg("저장 완료 ✅");
    } catch (e: any) {
      setSaveMsg(String(e?.message ?? e));
    }
  };

  const fetchHistory = async () => {
    setHistoryError(null);
    setHistoryLoading(true);
    try {
      const res = await fetch("/api/top3/history?limit=50", { cache: "no-store" });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.ok) {
        setHistoryError(json?.error ?? `불러오기 실패 (${res.status})`);
        setHistoryItems([]);
        return;
      }
      const items = Array.isArray(json.items) ? (json.items as HistoryItem[]) : [];
      items.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      setHistoryItems(items);
    } catch (e: any) {
      setHistoryError(String(e?.message ?? e));
      setHistoryItems([]);
    } finally {
      setHistoryLoading(false);
    }
  };

  const deleteHistoryItem = async (id: number) => {
    setHistoryError(null);
    if (!confirm("이 기록을 삭제할까요?")) return;

    try {
      const res = await fetch(`/api/top3/history?id=${encodeURIComponent(String(id))}`, { method: "DELETE" });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.ok) {
        setHistoryError(json?.error ?? `삭제 실패 (${res.status})`);
        return;
      }
      await fetchHistory();
    } catch (e: any) {
      setHistoryError(String(e?.message ?? e));
    }
  };

  const openHistoryItem = (it: HistoryItem) => {
    const payload = it.payload;
    if (!payload?.top3) return;
    setDate(String(payload.date ?? it.date ?? yyyymmddLocal(1)));
    setTop3Data({ ok: true, result: payload });
    setTabTop3();
  };

  const historyGroups = useMemo(() => {
    const map = new Map<string, HistoryItem[]>();
    for (const it of historyItems) {
      const d = String(it.date ?? it.payload?.date ?? "");
      if (!map.has(d)) map.set(d, []);
      map.get(d)!.push(it);
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    }
    const keys = Array.from(map.keys()).sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
    return keys.map((k) => ({ date: k, items: map.get(k)! }));
  }, [historyItems]);

  return (
    <div className="mt-6">
      <div className="flex flex-wrap gap-2">
        <button
          onClick={saveTop3}
          disabled={!top3Data?.ok || !top3Data?.result?.top3?.length}
          className="rounded-xl bg-emerald-600 text-white px-4 py-2 text-sm font-medium disabled:opacity-50"
        >
          결과 저장
        </button>

        <button
          onClick={fetchHistory}
          disabled={historyLoading}
          className="rounded-xl bg-neutral-100 text-neutral-900 px-4 py-2 text-sm font-medium border border-neutral-200 disabled:opacity-50"
        >
          {historyLoading ? "기록 불러오는 중..." : "내 기록 불러오기"}
        </button>

        {saveMsg ? <span className="text-sm text-neutral-700 self-center">{saveMsg}</span> : null}
      </div>

      {historyError ? (
        <div className="mt-2 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">{historyError}</div>
      ) : null}

      {historyItems.length === 0 ? (
        <div className="mt-2 text-sm text-neutral-600">기록이 없습니다. (먼저 “결과 저장”을 눌러주세요)</div>
      ) : (
        <div className="mt-3 space-y-3">
          {historyGroups.map((grp) => {
            const open = historyOpen[grp.date] ?? true;
            return (
              <div key={grp.date} className="rounded-2xl border border-neutral-200 bg-white">
                <button
                  onClick={() => setHistoryOpen((prev) => ({ ...prev, [grp.date]: !open }))}
                  className="w-full flex items-center justify-between p-3"
                >
                  <div className="text-left">
                    <div className="font-medium text-neutral-900">date: {grp.date}</div>
                    <div className="mt-1 text-xs text-neutral-600">저장 {grp.items.length}건</div>
                  </div>
                  <div className="text-xs text-neutral-500">{open ? "접기 ▲" : "펼치기 ▼"}</div>
                </button>

                {open ? (
                  <div className="px-3 pb-3 space-y-2">
                    {grp.items.map((it) => (
                      <div key={it.id} className="w-full rounded-xl border border-neutral-200 bg-white p-3">
                        <div className="flex items-center justify-between gap-2">
                          <button onClick={() => openHistoryItem(it)} className="flex-1 text-left hover:underline">
                            <div className="font-medium text-neutral-900">저장본 보기</div>
                            <div className="mt-1 text-xs text-neutral-600">
                              {new Date(it.created_at).toLocaleString()} · id: {it.id}
                            </div>
                          </button>

                          <button
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              deleteHistoryItem(it.id);
                            }}
                            className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-medium text-red-700 hover:bg-red-100"
                          >
                            삭제
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

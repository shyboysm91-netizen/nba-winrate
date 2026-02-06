// src/components/top3/Top3Card.tsx
"use client";

import React from "react";
import { buildTop3Explain } from "@/lib/top3/explain";

type Top3Pick = {
  gameId: string;
  date?: string;
  type: "ML" | "SPREAD" | "TOTAL" | string;
  label?: string; // "Wizards @ Pistons"
  pick?: string;  // HOME/AWAY/OVER/UNDER
  confidence?: number;
  edgePct?: number;
  modelProb?: number;
  marketProb?: number;
  provider?: string;
  notes?: string;
  meta?: any;
  line?: string;
};

function badgeColor(conf?: number) {
  if (typeof conf !== "number") return "bg-zinc-700 text-white";
  if (conf >= 80) return "bg-emerald-600 text-white";
  if (conf >= 65) return "bg-blue-600 text-white";
  if (conf >= 50) return "bg-amber-500 text-black";
  return "bg-rose-600 text-white";
}

function typeBadge(t: string) {
  if (t === "ML") return "bg-zinc-900 text-white";
  if (t === "SPREAD") return "bg-purple-700 text-white";
  if (t === "TOTAL") return "bg-teal-700 text-white";
  return "bg-zinc-700 text-white";
}

export default function Top3Card({ rank, pick }: { rank: 1 | 2 | 3; pick: Top3Pick }) {
  const explain = buildTop3Explain(pick);

  return (
    <div className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs text-zinc-500">TOP {rank}</div>
          <div className="mt-1 text-base font-semibold text-zinc-900 truncate">
            {pick.label ?? "추천"}
          </div>
        </div>

        <div className="flex flex-col items-end gap-2">
          <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${typeBadge(String(pick.type))}`}>
            {pick.type}
          </span>
          <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${badgeColor(pick.confidence)}`}>
            신뢰도 {typeof pick.confidence === "number" ? pick.confidence : "-"}
          </span>
        </div>
      </div>

      <div className="mt-3 text-sm text-zinc-800 leading-relaxed">
        {explain}
      </div>

      {/* 선택적으로 원본 line도 노출(짧게) */}
      {pick.line ? (
        <div className="mt-3 rounded-xl bg-zinc-50 p-3 text-xs text-zinc-600 overflow-x-auto">
          {pick.line}
        </div>
      ) : null}
    </div>
  );
}

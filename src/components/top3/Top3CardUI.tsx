import { fmtSigned, fmtDateLabel, pct, prob } from "@/lib/ui/format";
import { teamNameKr } from "@/lib/nba/teamNames";

function typeBadgeClass(t?: string) {
  if (t === "ML") return "bg-neutral-900 text-white";
  if (t === "SPREAD") return "bg-purple-700 text-white";
  if (t === "TOTAL") return "bg-teal-700 text-white";
  return "bg-neutral-700 text-white";
}

function confidenceBadgeClass(conf?: number) {
  if (typeof conf !== "number") return "bg-neutral-700 text-white";
  if (conf >= 80) return "bg-emerald-600 text-white";
  if (conf >= 65) return "bg-blue-600 text-white";
  if (conf >= 50) return "bg-amber-500 text-black";
  return "bg-rose-600 text-white";
}

function makeResultText(p: any) {
  const type = String(p?.type ?? "").toUpperCase();
  const ui = p?.ui ?? null;
  const game = p?.game ?? null;

  const pickTeamNameFromId = teamNameKr(ui?.pickTeamId, ui?.pickTeamName);

  if (type === "TOTAL") {
    const pickTotal = String(ui?.pickTotal ?? "").toUpperCase();
    const totalLine =
      typeof ui?.totalLine === "number" && Number.isFinite(ui.totalLine) ? ui.totalLine : null;

    if (pickTotal === "OVER") return totalLine != null ? `오버 ${totalLine}` : "오버";
    if (pickTotal === "UNDER") return totalLine != null ? `언더 ${totalLine}` : "언더";
    return totalLine != null ? `언더/오버 ${totalLine}` : "언더/오버";
  }

  if (type === "SPREAD") {
    const pickLine =
      typeof ui?.pickLine === "number" && Number.isFinite(ui.pickLine) ? ui.pickLine : null;

    if (pickLine == null) return `${pickTeamNameFromId} 핸디캡`;

    const label = pickLine < 0 ? "마핸" : "플핸";
    return `${pickTeamNameFromId} ${label} ${fmtSigned(pickLine)}`;
  }

  if (type === "ML") {
    const side = String(ui?.pickSide ?? "").toUpperCase();
    const fallback =
      side === "HOME"
        ? teamNameKr(game?.homeTeamId, game?.homeTeamName)
        : side === "AWAY"
          ? teamNameKr(game?.awayTeamId, game?.awayTeamName)
          : "팀";

    const pickName = ui?.pickTeamId ? pickTeamNameFromId : fallback;
    return `${pickName} 승 (머니라인)`;
  }

  return "추천";
}

function buildExplain(p: any) {
  const conf = typeof p?.confidence === "number" ? `${p.confidence}` : null;
  const edge = pct(p?.edgePct);
  const mp = prob(p?.modelProb);
  const mk = prob(p?.marketProb);

  const stat: string[] = [];
  if (conf) stat.push(`신뢰도 ${conf}`);
  if (edge) stat.push(`엣지 ${edge}`);
  if (mp) stat.push(`모델 ${mp}`);
  if (mk) stat.push(`시장 ${mk}`);

  const parts: string[] = [];
  if (stat.length) parts.push(`(${stat.join(" · ")})`);

  const provider = p?.provider;
  if (provider) parts.push(`기준: ${provider}`);

  return parts.join(" · ");
}

export function Top3CardUI({ rank, p }: { rank: number; p: any }) {
  const game = p?.game ?? null;
  const meta = p?.meta ?? {};

  const homeId = game?.homeTeamId ?? meta?.homeTeamId ?? meta?.homeTeamID ?? meta?.homeId ?? null;
  const awayId = game?.awayTeamId ?? meta?.awayTeamId ?? meta?.awayTeamID ?? meta?.awayId ?? null;

  const homeName = teamNameKr(homeId, game?.homeTeamName ?? meta?.homeTeamName);
  const awayName = teamNameKr(awayId, game?.awayTeamName ?? meta?.awayTeamName);

  const label = awayId || homeId ? `${awayName} vs ${homeName}` : p?.label || p?.matchup || "추천";
  const resultText = makeResultText(p);
  const explain = buildExplain(p);

  return (
    <div className="rounded-2xl border border-neutral-200 bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs text-neutral-500">TOP {rank}</div>
          <div className="mt-1 text-base font-semibold text-neutral-900 truncate">{label}</div>
          {game?.date ? (
            <div className="mt-1 text-xs text-neutral-500">경기일: {fmtDateLabel(game.date)}</div>
          ) : null}
        </div>

        <div className="flex flex-col items-end gap-2">
          <span
            className={`rounded-full px-2.5 py-1 text-xs font-semibold ${typeBadgeClass(
              String(p?.type ?? "")
            )}`}
          >
            {p?.type ?? "-"}
          </span>
          <span
            className={`rounded-full px-2.5 py-1 text-xs font-semibold ${confidenceBadgeClass(
              p?.confidence
            )}`}
          >
            신뢰도 {typeof p?.confidence === "number" ? p.confidence : "-"}
          </span>
        </div>
      </div>

      <div className="mt-4 rounded-xl border border-neutral-200 bg-neutral-50 p-3">
        <div className="text-xs text-neutral-500">추천 결과</div>
        <div className="mt-1 text-lg font-semibold text-neutral-900">{resultText}</div>
      </div>

      {explain ? <div className="mt-3 text-sm text-neutral-700 leading-relaxed">{explain}</div> : null}
    </div>
  );
}

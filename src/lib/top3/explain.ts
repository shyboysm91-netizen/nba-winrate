// src/lib/top3/explain.ts
type AnyPick = {
  type?: "ML" | "SPREAD" | "TOTAL" | string;
  pick?: string; // HOME / AWAY / OVER / UNDER 등
  line?: string; // 예: "homeML 0.51, edgePct 41.8, confidence 100 ..."
  confidence?: number;
  edgePct?: number;
  modelProb?: number;
  marketProb?: number;
  provider?: string;
  notes?: string;
  meta?: any;
};

function pct(n?: number) {
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  return `${n.toFixed(1)}%`;
}

function prob(n?: number) {
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  return `${(n * 100).toFixed(1)}%`;
}

function pickLabel(p: AnyPick) {
  const t = p.type;
  const pk = (p.pick || "").toUpperCase();

  if (t === "ML") return pk === "HOME" ? "머니라인: 홈 승" : pk === "AWAY" ? "머니라인: 원정 승" : "머니라인";
  if (t === "SPREAD") return pk === "HOME" ? "핸디캡: 홈" : pk === "AWAY" ? "핸디캡: 원정" : "핸디캡";
  if (t === "TOTAL") return pk === "OVER" ? "언더/오버: 오버" : pk === "UNDER" ? "언더/오버: 언더" : "언더/오버";
  return t || "추천";
}

export function buildTop3Explain(p: AnyPick) {
  const parts: string[] = [];

  const title = pickLabel(p);
  parts.push(title);

  const conf = typeof p.confidence === "number" ? `${p.confidence}` : null;
  const edge = pct(p.edgePct);
  const mp = prob(p.modelProb);
  const mk = prob(p.marketProb);

  const stat: string[] = [];
  if (conf) stat.push(`신뢰도 ${conf}`);
  if (edge) stat.push(`엣지 ${edge}`);
  if (mp) stat.push(`모델 ${mp}`);
  if (mk) stat.push(`시장 ${mk}`);

  if (stat.length) parts.push(`(${stat.join(" · ")})`);

  // 라인/근거 문구(있으면 최대한 짧게)
  const note = (p.notes || "").trim();
  if (note) parts.push(`- ${note}`);

  // provider
  if (p.provider) parts.push(`· 기준: ${p.provider}`);

  return parts.join(" ");
}

export function yyyymmddLocal() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

export function fmtSigned(n: number) {
  return n > 0 ? `+${n}` : `${n}`;
}

export function fmtDateLabel(yyyymmdd?: string) {
  const s = String(yyyymmdd ?? "");
  if (!/^\d{8}$/.test(s)) return s || "-";
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

export function pct(n?: number) {
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  return `${n.toFixed(1)}%`;
}

export function prob(n?: number) {
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  return `${(n * 100).toFixed(1)}%`;
}

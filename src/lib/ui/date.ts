export function yyyymmddLocal(addDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + addDays);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

export function fmtDateLabel(yyyymmdd?: string) {
  const s = String(yyyymmdd ?? "");
  if (!/^\d{8}$/.test(s)) return s || "-";
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}


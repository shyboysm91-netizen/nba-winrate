export type Top3Response = {
  ok: boolean;
  result?: { date: string; totalGames: number; candidates: number; top3: any[]; note?: string; options?: any };
  error?: string;
};

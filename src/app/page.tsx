import LogoutButton from "@/components/LogoutButton";
import Dashboard from "@/components/Dashboard";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getSubscriptionStatus } from "@/lib/subscription/getSubscription";

export default async function HomePage() {
  const supabase = await createSupabaseServerClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const sub = await getSubscriptionStatus();

  return (
    // ✅ 전체 배경을 살짝 어둡게
    <main className="min-h-screen bg-neutral-950 text-neutral-100 p-8">
      <div className="max-w-5xl mx-auto">
        <h1 className="text-3xl font-bold text-white">승률 분석기</h1>

        <div className="mt-4 flex items-center gap-3">
          <LogoutButton />

          <div className="text-sm text-neutral-300">
            현재 로그인: <span className="font-medium">{user?.email}</span>
          </div>

          <div
            className={`ml-auto rounded-full px-3 py-1 text-xs font-semibold border ${
              sub.isPaid
                ? "bg-emerald-900/30 text-emerald-300 border-emerald-700"
                : "bg-neutral-800 text-neutral-300 border-neutral-700"
            }`}
          >
            {sub.isPaid ? "PRO (유료)" : "FREE (무료)"}
          </div>
        </div>

        {/* ✅ 카드 영역은 밝게 유지 */}
        <div className="mt-6 rounded-2xl border border-neutral-800 bg-neutral-900 p-5">
          <h2 className="text-lg font-semibold text-white">구독 상태</h2>

          <div className="mt-2 text-sm text-neutral-300 space-y-1">
            <div>active: {String(sub.active)}</div>
            <div>expires_at: {sub.expiresAt ?? "(없음)"}</div>
            <div>
              최종 판정:{" "}
              <span className="font-semibold text-white">
                {sub.isPaid ? "유료 사용 가능" : "무료(잠금)"}
              </span>
            </div>
          </div>

          {/* 고객 안내 문구 */}
          <div className="mt-4 text-xs text-neutral-400 leading-relaxed">
            📊 단순 승부 예측이 아닌, 최근 10경기 흐름을 중심으로 팀 컨디션과
            경기 맥락을 분석해 TOP3와 경기 분석을 제공합니다.
          </div>
        </div>

        {/* Dashboard는 내부 카드들이 이미 밝아서 그대로 */}
        <div className="mt-6">
          <Dashboard isPaid={sub.isPaid} />
        </div>
      </div>
    </main>
  );
}

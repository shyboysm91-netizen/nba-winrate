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
    <main className="min-h-screen bg-white text-neutral-900 p-8">
      <div className="max-w-5xl mx-auto">
        <h1 className="text-3xl font-bold">승률 분석기</h1>

        <div className="mt-4 flex items-center gap-3">
          <LogoutButton />
          <div className="text-sm text-neutral-700">
            현재 로그인: <span className="font-medium">{user?.email}</span>
          </div>

          <div
            className={`ml-auto rounded-full px-3 py-1 text-xs font-semibold border ${
              sub.isPaid
                ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                : "bg-neutral-50 text-neutral-700 border-neutral-200"
            }`}
          >
            {sub.isPaid ? "PRO (유료)" : "FREE (무료)"}
          </div>
        </div>

        <div className="mt-6 rounded-2xl border border-neutral-200 p-5">
          <h2 className="text-lg font-semibold">구독 상태</h2>
          <div className="mt-2 text-sm text-neutral-700 space-y-1">
            <div>active: {String(sub.active)}</div>
            <div>expires_at: {sub.expiresAt ?? "(없음)"}</div>
            <div>
              최종 판정:{" "}
              <span className="font-semibold">
                {sub.isPaid ? "유료 사용 가능" : "무료(잠금)"}
              </span>
            </div>
          </div>
        </div>

        <Dashboard isPaid={sub.isPaid} />
      </div>
    </main>
  );
}

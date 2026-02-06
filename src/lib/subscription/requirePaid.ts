import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getSubscriptionStatus } from "@/lib/subscription/getSubscription";

export type RequirePaidResult =
  | { ok: true; userId: string }
  | { ok: false; status: 401 | 403; message: string };

export async function requirePaid(): Promise<RequirePaidResult> {
  const supabase = await createSupabaseServerClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { ok: false, status: 401, message: "로그인이 필요합니다." };
  }

  const sub = await getSubscriptionStatus();

  if (!sub.isPaid) {
    return {
      ok: false,
      status: 403,
      message: "유료 구독이 필요합니다.",
    };
  }

  return { ok: true, userId: user.id };
}

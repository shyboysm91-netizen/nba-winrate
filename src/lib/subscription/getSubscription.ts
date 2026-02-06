import { createSupabaseServerClient } from "@/lib/supabase/server";

export type SubscriptionStatus = {
  isPaid: boolean;
  active: boolean;
  expiresAt: string | null;
};

export async function getSubscriptionStatus(): Promise<SubscriptionStatus> {
  const supabase = await createSupabaseServerClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { isPaid: false, active: false, expiresAt: null };
  }

  const { data } = await supabase
    .from("subscriptions")
    .select("active, expires_at")
    .eq("user_id", user.id)
    .maybeSingle();

  if (!data) {
    return { isPaid: false, active: false, expiresAt: null };
  }

  const active = !!data.active;
  const expiresAt = data.expires_at ?? null;

  const notExpired = !expiresAt || new Date(expiresAt).getTime() > Date.now();
  const isPaid = active && notExpired;

  return { isPaid, active, expiresAt };
}

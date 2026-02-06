import { createBrowserClient } from "@supabase/ssr";

export function createSupabaseBrowserClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error(
      "[supabase] Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local (restart pnpm dev)"
    );
  }

  return createBrowserClient(url, anonKey);
}

/**
 * 기존 코드 호환용 (혹시 다른 파일에서 supabase를 직접 import하는 경우 대비)
 * 기능 삭제가 아니라 '추가'로 유지.
 */
export const supabase = createSupabaseBrowserClient();

"use client";

import { useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

export default function LoginPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const normalizeError = (errMsg: string) => {
    const msg = String(errMsg ?? "");
    if (msg.toLowerCase().includes("failed to fetch")) {
      return [
        "Failed to fetch (브라우저가 Supabase에 접속 자체를 못함)",
        "",
        "원인 TOP 3:",
        "1) SUPABASE_URL 오타/DNS 문제",
        "2) .env.local 변경 후 pnpm dev 재시작 안 함",
        "3) 네트워크/확장프로그램이 supabase.co 호출 차단",
      ].join("\n");
    }
    return msg;
  };

  const onLogin = async () => {
    setMessage(null);
    setLoading(true);
    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (error) {
        setMessage(normalizeError(error.message));
        return;
      }

      if (!data.session) {
        setMessage("로그인 세션이 생성되지 않았어. 잠시 후 다시 시도해줘.");
        return;
      }

      const next = searchParams.get("next") || "/";
      router.replace(next);
      router.refresh();
    } catch (e: any) {
      setMessage(normalizeError(String(e?.message ?? e)));
    } finally {
      setLoading(false);
    }
  };

  const onSignup = async () => {
    setMessage(null);
    setLoading(true);
    try {
      const emailRedirectTo =
        typeof window !== "undefined"
          ? `${window.location.origin}/auth/callback`
          : undefined;

      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: emailRedirectTo ? { emailRedirectTo } : undefined,
      });

      if (error) {
        setMessage(normalizeError(error.message));
        return;
      }

      if (!data.session) {
        setMessage(
          "회원가입 요청 완료.\n메일함에서 인증 확인 후 자동으로 로그인 처리돼."
        );
        return;
      }

      router.replace("/");
      router.refresh();
    } catch (e: any) {
      setMessage(normalizeError(String(e?.message ?? e)));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-neutral-950 text-neutral-100 p-6">
      <div className="w-full max-w-md rounded-2xl border border-neutral-800 bg-neutral-900/60 p-6 shadow-lg">
        <h1 className="text-2xl font-semibold">승률 분석기 로그인</h1>

        <div className="mt-6 space-y-3">
          <div className="space-y-1">
            <label className="text-sm text-neutral-300">이메일</label>
            <input
              className="w-full rounded-xl bg-neutral-950 border border-neutral-800 px-3 py-2 outline-none focus:border-neutral-600"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              autoComplete="email"
            />
          </div>

          <div className="space-y-1">
            <label className="text-sm text-neutral-300">비밀번호</label>
            <input
              className="w-full rounded-xl bg-neutral-950 border border-neutral-800 px-3 py-2 outline-none focus:border-neutral-600"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="********"
              autoComplete="current-password"
            />
          </div>

          <div className="pt-2 grid grid-cols-2 gap-3">
            <button
              onClick={onLogin}
              disabled={loading || !email || !password}
              className="rounded-xl bg-neutral-100 text-neutral-900 px-4 py-2 font-medium disabled:opacity-50"
            >
              {loading ? "처리 중..." : "로그인"}
            </button>

            <button
              onClick={onSignup}
              disabled={loading || !email || !password}
              className="rounded-xl border border-neutral-700 bg-transparent px-4 py-2 font-medium disabled:opacity-50"
            >
              {loading ? "처리 중..." : "회원가입"}
            </button>
          </div>

          {message && (
            <pre className="mt-4 whitespace-pre-wrap rounded-xl border border-neutral-800 bg-neutral-950 p-3 text-sm text-neutral-200">
              {message}
            </pre>
          )}
        </div>

        <div className="mt-6 text-xs text-neutral-500">
          ⚠️ .env.local 바꾸면 반드시 <span className="text-neutral-300">pnpm dev 재시작</span>
        </div>
      </div>
    </div>
  );
}

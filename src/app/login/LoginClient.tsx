"use client";

import { useSearchParams } from "next/navigation";

export default function LoginClient() {
  const sp = useSearchParams();
  const redirectTo = sp.get("redirectTo") || "/";

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-md rounded-2xl border bg-white p-6 shadow">
        <h1 className="text-xl font-semibold">Login</h1>
        <p className="mt-2 text-sm text-gray-600">
          redirectTo: <span className="font-mono">{redirectTo}</span>
        </p>

        <div className="mt-6 text-sm text-gray-700">
          기존 로그인 폼 UI를 이 컴포넌트로 옮기면 됩니다.
        </div>
      </div>
    </div>
  );
}

import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";

function isPublicPath(pathname: string) {
  // 로그인/인증 콜백은 항상 열어둠
  if (pathname === "/login") return true;
  if (pathname.startsWith("/auth")) return true;

  // Next 내부/정적 파일
  if (pathname.startsWith("/_next")) return true;
  if (pathname === "/favicon.ico") return true;

  return false;
}

export async function middleware(req: NextRequest) {
  const res = NextResponse.next();

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return req.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => {
            res.cookies.set(name, value, options);
          });
        },
      },
    }
  );

  // ✅ 중요: 여기서 세션을 "갱신"해줘야 새로고침/이동 시 안정적임
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = req.nextUrl;

  if (!user && !isPublicPath(pathname)) {
    const loginUrl = req.nextUrl.clone();
    loginUrl.pathname = "/login";
    loginUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(loginUrl);
  }

  // 로그인 상태인데 /login 들어오면 홈으로
  if (user && pathname === "/login") {
    const url = req.nextUrl.clone();
    url.pathname = "/";
    url.search = "";
    return NextResponse.redirect(url);
  }

  return res;
}

export const config = {
  matcher: [
    /*
      API/정적 제외하고 앱 라우트만 보호
    */
    "/((?!api|_next/static|_next/image|favicon.ico).*)",
  ],
};

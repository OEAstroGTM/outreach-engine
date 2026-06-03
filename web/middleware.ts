import { NextRequest, NextResponse } from "next/server";

const PASSWORD = process.env.APP_PASSWORD ?? "outreach2026";

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Allow auth and digest (digest has its own secret) through
  if (pathname.startsWith("/api/auth")) return NextResponse.next();
  if (pathname.startsWith("/api/digest")) return NextResponse.next();

  // Check cookie
  const auth = req.cookies.get("auth")?.value;
  if (auth === PASSWORD) return NextResponse.next();

  // Redirect to login
  const loginUrl = req.nextUrl.clone();
  loginUrl.pathname = "/login";
  if (pathname !== "/login") return NextResponse.redirect(loginUrl);

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

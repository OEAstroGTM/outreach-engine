import { NextRequest, NextResponse } from "next/server";

const PASSWORD = process.env.APP_PASSWORD;
if (!PASSWORD) {
  throw new Error("APP_PASSWORD env var must be set — no default password is allowed.");
}

export async function POST(req: NextRequest) {
  const { password } = await req.json();
  if (password !== PASSWORD) {
    return NextResponse.json({ error: "Wrong password" }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set("auth", PASSWORD, {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    maxAge: 60 * 60 * 24 * 30, // 30 days
    path: "/",
  });
  return res;
}

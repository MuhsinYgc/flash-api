import { NextResponse } from "next/server";
import { connectMongo } from "@/lib/mongodb";
import { User } from "@/lib/models/User";
import { SESSION_COOKIE_NAME } from "@/lib/auth/constants";
import { signSessionToken } from "@/lib/auth/jwt";
import { verifyPassword } from "@/lib/auth/password";
import { sessionCookieOptions } from "@/lib/auth/session";

export const runtime = "nodejs";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid body." }, { status: 400 });
  }

  const { email: rawEmail, password } = body as {
    email?: string;
    password?: string;
  };

  const email =
    typeof rawEmail === "string" ? rawEmail.trim().toLowerCase() : "";
  const passwordStr = typeof password === "string" ? password : "";

  if (!email || !passwordStr) {
    return NextResponse.json(
      { error: "Email and password are required." },
      { status: 400 },
    );
  }

  try {
    await connectMongo();
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Database unavailable.";
    return NextResponse.json({ error: msg }, { status: 503 });
  }

  const user = (await User.findOne({ email }).lean()) as {
    _id: unknown;
    email: string;
    passwordHash?: string;
  } | null;
  if (!user || typeof user.passwordHash !== "string") {
    return NextResponse.json(
      { error: "Invalid email or password." },
      { status: 401 },
    );
  }

  const ok = await verifyPassword(passwordStr, user.passwordHash);
  if (!ok) {
    return NextResponse.json(
      { error: "Invalid email or password." },
      { status: 401 },
    );
  }

  const token = await signSessionToken(String(user._id), user.email);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE_NAME, token, sessionCookieOptions());
  return res;
}

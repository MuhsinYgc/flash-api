import { NextResponse } from "next/server";
import { connectMongo } from "@/lib/mongodb";
import { User } from "@/lib/models/User";
import { SESSION_COOKIE_NAME } from "@/lib/auth/constants";
import { signSessionToken } from "@/lib/auth/jwt";
import { hashPassword } from "@/lib/auth/password";
import { sessionCookieOptions } from "@/lib/auth/session";

export const runtime = "nodejs";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

  const { email: rawEmail, password, name: rawName } = body as {
    email?: string;
    password?: string;
    name?: string;
  };

  const email = typeof rawEmail === "string" ? rawEmail.trim().toLowerCase() : "";
  const passwordStr = typeof password === "string" ? password : "";
  const name =
    typeof rawName === "string" ? rawName.trim().slice(0, 120) : "";

  if (!email || !EMAIL_RE.test(email)) {
    return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
  }
  if (passwordStr.length < 8) {
    return NextResponse.json(
      { error: "Password must be at least 8 characters." },
      { status: 400 },
    );
  }

  try {
    await connectMongo();
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Database unavailable.";
    return NextResponse.json({ error: msg }, { status: 503 });
  }

  const existing = await User.findOne({ email }).lean();
  if (existing) {
    return NextResponse.json(
      { error: "An account with this email already exists." },
      { status: 409 },
    );
  }

  const passwordHash = await hashPassword(passwordStr);
  const user = await User.create({ email, passwordHash, name });

  const token = await signSessionToken(String(user._id), user.email);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE_NAME, token, sessionCookieOptions());
  return res;
}

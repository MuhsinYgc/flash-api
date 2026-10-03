import { NextResponse } from "next/server";
import { connectMongo } from "@/lib/mongodb";
import { User } from "@/lib/models/User";
import { getSession } from "@/lib/auth/session";

export const runtime = "nodejs";

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ user: null });
  }

  try {
    await connectMongo();
  } catch {
    return NextResponse.json({ user: { email: session.email, name: "" } });
  }

  const doc = await User.findById(session.userId)
    .select("email name")
    .lean<{ email: string; name?: string } | null>();

  if (!doc) {
    return NextResponse.json({ user: null });
  }

  return NextResponse.json({
    user: { email: doc.email, name: doc.name ?? "" },
  });
}

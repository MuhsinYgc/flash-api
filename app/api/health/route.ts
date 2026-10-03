import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({
    ok: true,
    service: "flask-web-api",
    time: new Date().toISOString(),
  });
}

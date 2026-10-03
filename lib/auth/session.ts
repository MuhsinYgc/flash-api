import { cookies } from "next/headers";
import { SESSION_COOKIE_NAME } from "@/lib/auth/constants";
import { verifySessionToken } from "@/lib/auth/jwt";

export async function getSession(): Promise<{
  userId: string;
  email: string;
} | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE_NAME)?.value;
  if (!token) return null;
  try {
    return await verifySessionToken(token);
  } catch {
    return null;
  }
}

export function sessionCookieOptions(): {
  httpOnly: boolean;
  secure: boolean;
  sameSite: "lax";
  path: string;
  maxAge: number;
} {
  const secureOverride = process.env.SESSION_COOKIE_SECURE?.trim().toLowerCase();
  const siteUrl = process.env.SITE_URL?.trim() ?? "";
  const secure =
    secureOverride === "true" || secureOverride === "1"
      ? true
      : secureOverride === "false" || secureOverride === "0"
        ? false
        : siteUrl
          ? siteUrl.startsWith("https://")
          : process.env.NODE_ENV === "production";
  return {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  };
}

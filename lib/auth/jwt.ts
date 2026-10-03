import { SignJWT, jwtVerify } from "jose";

const DEV_FALLBACK =
  process.env.NODE_ENV === "development"
    ? "dev-only-min-32-chars-secret-change-in-production!"
    : undefined;

export function getJwtSecretKey(): Uint8Array {
  const raw = process.env.JWT_SECRET ?? DEV_FALLBACK;
  if (!raw || raw.length < 32) {
    throw new Error(
      "JWT_SECRET must be set to at least 32 characters in .env.local (production).",
    );
  }
  return new TextEncoder().encode(raw);
}

export async function signSessionToken(
  userId: string,
  email: string,
): Promise<string> {
  return new SignJWT({ email })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(getJwtSecretKey());
}

export async function verifySessionToken(
  token: string,
): Promise<{ userId: string; email: string }> {
  const { payload } = await jwtVerify(token, getJwtSecretKey());
  const sub = typeof payload.sub === "string" ? payload.sub : null;
  const email = typeof payload.email === "string" ? payload.email : null;
  if (!sub || !email) {
    throw new Error("Invalid session token");
  }
  return { userId: sub, email };
}

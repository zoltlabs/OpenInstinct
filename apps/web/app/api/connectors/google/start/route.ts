import { createGoogleAuthorization } from "@openinstinct/connectors";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { googleConfig } from "../../../../../src/lib/google-config";
import { requireOwner } from "../../../../../src/lib/owner";

export async function GET() {
  const { workspace } = await requireOwner();
  if (!workspace)
    return NextResponse.redirect(new URL("/", process.env.NEXT_PUBLIC_APP_URL));
  const authorization = createGoogleAuthorization(googleConfig());
  const cookieStore = await cookies();
  const options = {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    maxAge: 600,
    path: "/",
  };
  cookieStore.set("oi_google_state", authorization.state, options);
  cookieStore.set("oi_google_verifier", authorization.codeVerifier, options);
  return NextResponse.redirect(authorization.url);
}

import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "../../../../src/lib/supabase/server";
import { isSameOrigin } from "../../../../src/lib/request-security";

export async function POST(request: Request) {
  if (!isSameOrigin(request))
    return NextResponse.json({ error: "Invalid origin." }, { status: 403 });
  const form = await request.formData();
  const email = String(form.get("email") ?? "").trim();
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  const ownerEmail = process.env.OWNER_EMAIL?.trim().toLowerCase();
  if (!email || !appUrl || !ownerEmail)
    return NextResponse.json(
      { error: "Invalid configuration." },
      { status: 400 },
    );
  if (email.toLowerCase() !== ownerEmail)
    return NextResponse.json(
      { error: "Sign-in is not available." },
      { status: 403 },
    );
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: new URL("/api/auth/callback", appUrl).toString(),
    },
  });
  if (error)
    return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.redirect(new URL("/?check-email=1", request.url), 303);
}

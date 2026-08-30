import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "../../../../src/lib/supabase/server";
import { isSameOrigin } from "../../../../src/lib/request-security";
import { feedbackUrl } from "../../../../src/lib/feedback";

export async function POST(request: Request) {
  if (!isSameOrigin(request))
    return NextResponse.json({ error: "Invalid origin." }, { status: 403 });
  const form = await request.formData();
  const email = String(form.get("email") ?? "").trim();
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  const ownerEmail = process.env.OWNER_EMAIL?.trim().toLowerCase();
  if (!email || !appUrl || !ownerEmail)
    return NextResponse.redirect(
      feedbackUrl(request.url, "configuration-incomplete"),
      303,
    );
  if (email.toLowerCase() !== ownerEmail)
    return NextResponse.redirect(
      feedbackUrl(request.url, "signin-unavailable"),
      303,
    );
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: new URL("/api/auth/callback", appUrl).toString(),
    },
  });
  if (error)
    return NextResponse.redirect(
      feedbackUrl(request.url, "signin-failed"),
      303,
    );
  return NextResponse.redirect(feedbackUrl(request.url, "check-email"), 303);
}

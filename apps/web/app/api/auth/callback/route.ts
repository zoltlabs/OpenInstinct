import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "../../../../src/lib/supabase/server";
import { feedbackUrl } from "../../../../src/lib/feedback";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  if (!code)
    return NextResponse.redirect(
      feedbackUrl(url.toString(), "auth-missing-code"),
    );
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  return error
    ? NextResponse.redirect(feedbackUrl(url.toString(), "auth-exchange-failed"))
    : NextResponse.redirect(new URL("/", url));
}

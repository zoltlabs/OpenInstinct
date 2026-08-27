import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "../../../../src/lib/supabase/server";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  if (!code)
    return NextResponse.redirect(new URL("/?auth-error=missing-code", url));
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  return NextResponse.redirect(
    new URL(error ? "/?auth-error=exchange" : "/", url),
  );
}

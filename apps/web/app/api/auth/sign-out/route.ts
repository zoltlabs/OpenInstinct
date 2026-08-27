import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "../../../../src/lib/supabase/server";
import { isSameOrigin } from "../../../../src/lib/request-security";

export async function POST(request: Request) {
  if (!isSameOrigin(request))
    return NextResponse.json({ error: "Invalid origin." }, { status: 403 });
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  return NextResponse.redirect(new URL("/", request.url), 303);
}

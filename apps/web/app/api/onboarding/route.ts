import { OpenInstinctStore } from "@openinstinct/db";
import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "../../../src/lib/supabase/server";
import { isSameOrigin } from "../../../src/lib/request-security";
import { feedbackUrl } from "../../../src/lib/feedback";
import { isValidTimeZone } from "../../../src/lib/validation";

export async function POST(request: Request) {
  if (!isSameOrigin(request))
    return NextResponse.json({ error: "Invalid origin." }, { status: 403 });
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.redirect(
      feedbackUrl(request.url, "session-expired"),
      303,
    );
  const form = await request.formData();
  const displayName = String(form.get("displayName") ?? "").trim();
  const phone = String(form.get("phone") ?? "").trim();
  const timezone = String(form.get("timezone") ?? "UTC").trim();
  if (
    !displayName ||
    !/^\+[1-9][0-9]{7,14}$/u.test(phone) ||
    !isValidTimeZone(timezone)
  ) {
    return NextResponse.redirect(
      feedbackUrl(request.url, "onboarding-invalid"),
      303,
    );
  }
  if (phone !== process.env.BLOOIO_OWNER_PHONE) {
    return NextResponse.redirect(
      feedbackUrl(request.url, "onboarding-phone-mismatch"),
      303,
    );
  }
  if (
    user.email?.toLowerCase() !== process.env.OWNER_EMAIL?.trim().toLowerCase()
  ) {
    return NextResponse.redirect(
      feedbackUrl(request.url, "session-expired"),
      303,
    );
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl)
    return NextResponse.redirect(
      feedbackUrl(request.url, "configuration-incomplete"),
      303,
    );
  const store = new OpenInstinctStore(databaseUrl);
  try {
    await store.bootstrapOwner({
      ownerUserId: user.id,
      displayName,
      timezone,
      phoneE164: phone,
    });
  } catch (error) {
    return NextResponse.redirect(
      feedbackUrl(request.url, "onboarding-failed"),
      303,
    );
  } finally {
    await store.close();
  }
  return NextResponse.redirect(
    feedbackUrl(request.url, "onboarding-complete"),
    303,
  );
}

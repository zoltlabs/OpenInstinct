import { OpenInstinctStore } from "@openinstinct/db";
import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "../../../src/lib/supabase/server";
import { isSameOrigin } from "../../../src/lib/request-security";

export async function POST(request: Request) {
  if (!isSameOrigin(request))
    return NextResponse.json({ error: "Invalid origin." }, { status: 403 });
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const form = await request.formData();
  const displayName = String(form.get("displayName") ?? "").trim();
  const phone = String(form.get("phone") ?? "").trim();
  const timezone = String(form.get("timezone") ?? "UTC").trim();
  if (!displayName || !/^\+[1-9][0-9]{7,14}$/u.test(phone)) {
    return NextResponse.json(
      { error: "Invalid onboarding data." },
      { status: 400 },
    );
  }
  if (phone !== process.env.BLOOIO_OWNER_PHONE) {
    return NextResponse.json(
      { error: "Phone must match BLOOIO_OWNER_PHONE." },
      { status: 400 },
    );
  }
  if (
    user.email?.toLowerCase() !== process.env.OWNER_EMAIL?.trim().toLowerCase()
  ) {
    return NextResponse.json({ error: "Unauthorized owner." }, { status: 403 });
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl)
    return NextResponse.json(
      { error: "Database is not configured." },
      { status: 503 },
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
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Could not create workspace.",
      },
      { status: 409 },
    );
  } finally {
    await store.close();
  }
  return NextResponse.redirect(new URL("/", request.url), 303);
}

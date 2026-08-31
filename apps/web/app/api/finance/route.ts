import { NextResponse } from "next/server";
import { OpenInstinctStore } from "@openinstinct/db";
import { z } from "zod";
import { createSupabaseServerClient } from "../../../src/lib/supabase/server";
import { isSameOrigin } from "../../../src/lib/request-security";
import { feedbackUrl } from "../../../src/lib/feedback";

export async function POST(request: Request) {
  if (!isSameOrigin(request))
    return NextResponse.json({ error: "Invalid origin." }, { status: 403 });
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.redirect(
      feedbackUrl(request.url, "session-expired", "/finance"),
      303,
    );
  const { data: workspace } = await supabase
    .from("workspaces")
    .select("id")
    .eq("owner_user_id", user.id)
    .maybeSingle();
  if (!workspace)
    return NextResponse.redirect(
      feedbackUrl(request.url, "session-expired", "/finance"),
      303,
    );
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl)
    return NextResponse.redirect(
      feedbackUrl(request.url, "configuration-incomplete", "/finance"),
      303,
    );
  const form = await request.formData();
  const action = String(form.get("action") ?? "");
  const store = new OpenInstinctStore(databaseUrl);
  try {
    await store.ensureFinancialPilot(workspace.id);
    if (action === "settings") {
      const value = z
        .object({
          currency: z.string().regex(/^[A-Z]{3}$/u),
          perTransactionLimit: z.string().regex(/^(0|[1-9][0-9]{0,17})$/u),
          dailyLimit: z.string().regex(/^(0|[1-9][0-9]{0,17})$/u),
          monthlyLimit: z.string().regex(/^(0|[1-9][0-9]{0,17})$/u),
        })
        .parse(Object.fromEntries(form));
      await store.updateFinancialSettings({
        workspaceId: workspace.id,
        enabled: form.get("enabled") === "on",
        ...value,
      });
    } else if (action === "merchant") {
      const value = z
        .object({
          merchantId: z.string().uuid(),
          perTransactionLimit: z.string().regex(/^(0|[1-9][0-9]{0,17})$/u),
        })
        .parse(Object.fromEntries(form));
      await store.updateFinancialMerchant({
        workspaceId: workspace.id,
        enabled: form.get("enabled") === "on",
        ...value,
      });
    } else if (action === "payment-alias") {
      const value = z
        .object({
          paymentAliasId: z.string().uuid(),
          status: z.enum(["active", "disabled", "revoked"]),
        })
        .parse(Object.fromEntries(form));
      await store.updatePaymentAliasStatus({
        workspaceId: workspace.id,
        ...value,
      });
    } else throw new Error("Unsupported financial control action.");
  } catch {
    return NextResponse.redirect(
      feedbackUrl(request.url, "approval-failed", "/finance"),
      303,
    );
  } finally {
    await store.close();
  }
  return NextResponse.redirect(
    feedbackUrl(request.url, "approval-recorded", "/finance"),
    303,
  );
}

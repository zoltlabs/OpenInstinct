import { OpenInstinctStore } from "@openinstinct/db";
import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "../../../../src/lib/supabase/server";
import { isSameOrigin } from "../../../../src/lib/request-security";
import { feedbackUrl } from "../../../../src/lib/feedback";
import {
  financialAdjustmentActionInputSchema,
  financialAdjustmentConfirmationPhrase,
  financialConfirmationPhrase,
  financialPurchaseActionInputSchema,
} from "@openinstinct/core";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
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
  const { data: workspace } = await supabase
    .from("workspaces")
    .select("id")
    .eq("owner_user_id", user.id)
    .maybeSingle();
  if (!workspace)
    return NextResponse.redirect(
      feedbackUrl(request.url, "session-expired"),
      303,
    );
  const { id } = await context.params;
  const form = await request.formData();
  const approved = form.get("decision") === "approve";
  const inputHash = String(form.get("inputHash") ?? "");
  const semanticIntentHash = String(form.get("semanticIntentHash") ?? "");
  const guardConditionsHash = String(form.get("guardConditionsHash") ?? "");
  let typedConfirmation = false;
  if (approved) {
    const { data: action } = await supabase
      .from("action_requests")
      .select("risk,semantic_intent,input")
      .eq("id", id)
      .eq("workspace_id", workspace.id)
      .maybeSingle();
    if (
      (action?.risk === "destructive" ||
        ["delete", "cancel"].includes(
          String(
            (action?.semantic_intent as Record<string, unknown> | null)
              ?.effect ?? "",
          ),
        )) &&
      form.get("destructiveConfirmation") !== "CONFIRM DESTRUCTIVE ACTION"
    )
      return NextResponse.redirect(
        feedbackUrl(
          request.url,
          "approval-confirmation-mismatch",
          `/approvals/${id}`,
        ),
        303,
      );
    const financial =
      action?.risk === "financial"
        ? financialPurchaseActionInputSchema.safeParse(action.input)
        : undefined;
    if (financial?.success) {
      const requiredPhrase = financialConfirmationPhrase({
        totalAmount: financial.data.preflight.totalAmount,
        merchantId: financial.data.preflight.merchantId,
        paymentAliasId: financial.data.preflight.paymentAliasId,
      });
      if (form.get("financialConfirmation") !== requiredPhrase)
        return NextResponse.redirect(
          feedbackUrl(
            request.url,
            "approval-confirmation-mismatch",
            `/approvals/${id}`,
          ),
          303,
        );
    }
    const financialAdjustment =
      action?.risk === "financial"
        ? financialAdjustmentActionInputSchema.safeParse(action.input)
        : undefined;
    if (financialAdjustment?.success) {
      const requiredPhrase = financialAdjustmentConfirmationPhrase(
        financialAdjustment.data,
      );
      if (form.get("financialConfirmation") !== requiredPhrase)
        return NextResponse.redirect(
          feedbackUrl(
            request.url,
            "approval-confirmation-mismatch",
            `/approvals/${id}`,
          ),
          303,
        );
    }
    typedConfirmation =
      Boolean(financial?.success || financialAdjustment?.success) ||
      action?.risk === "destructive" ||
      ["delete", "cancel"].includes(
        String(
          (action?.semantic_intent as Record<string, unknown> | null)?.effect ??
            "",
        ),
      );
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl)
    return NextResponse.redirect(
      feedbackUrl(request.url, "configuration-incomplete", `/approvals/${id}`),
      303,
    );
  const store = new OpenInstinctStore(databaseUrl);
  try {
    await store.decideAction({
      actionId: id,
      workspaceId: workspace.id,
      approved,
      inputHash,
      semanticIntentHash: semanticIntentHash || undefined,
      guardConditionsHash: guardConditionsHash || undefined,
      typedConfirmation,
      channel: "web",
    });
  } catch {
    return NextResponse.redirect(
      feedbackUrl(request.url, "approval-failed", `/approvals/${id}`),
      303,
    );
  } finally {
    await store.close();
  }
  return NextResponse.redirect(
    feedbackUrl(request.url, "approval-recorded"),
    303,
  );
}

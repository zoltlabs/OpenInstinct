import {
  authorityGrantConfigurationVersion,
  authorityGrantSchema,
  canonicalOrigin,
} from "@openinstinct/core";
import { OpenInstinctStore } from "@openinstinct/db";
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "../../../../src/lib/supabase/server";
import { isSameOrigin } from "../../../../src/lib/request-security";

function redirect(request: Request, status: "saved" | "revoked" | "failed") {
  return NextResponse.redirect(
    new URL(`/authority?status=${status}`, request.url),
    303,
  );
}

export async function POST(request: Request) {
  if (!isSameOrigin(request))
    return NextResponse.json({ error: "Invalid origin." }, { status: 403 });
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return redirect(request, "failed");
  const { data: workspace } = await supabase
    .from("workspaces")
    .select("id")
    .eq("owner_user_id", user.id)
    .maybeSingle();
  const databaseUrl = process.env.DATABASE_URL;
  if (!workspace || !databaseUrl) return redirect(request, "failed");
  const form = await request.formData();
  const store = new OpenInstinctStore(databaseUrl);
  try {
    if (form.get("operation") === "revoke") {
      await store.revokeAuthorityGrant({
        workspaceId: workspace.id,
        grantId: String(form.get("grantId") ?? ""),
      });
      return redirect(request, "revoked");
    }
    const effect = String(form.get("effect") ?? "");
    if (!(["create", "update", "send"] as const).includes(effect as never))
      throw new Error("Unsupported grant effect.");
    const originValue = String(form.get("origin") ?? "").trim();
    const split = (name: string) =>
      String(form.get(name) ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    const startsAt = new Date();
    const expiryDays = Number(form.get("expiryDays") ?? 30);
    const configuration = {
      id: randomUUID(),
      workspaceId: workspace.id,
      version: 1,
      name: String(form.get("name") ?? ""),
      effects: [effect] as ("create" | "update" | "send")[],
      resourceClasses: [String(form.get("resourceClass") ?? "")],
      providers: [String(form.get("provider") ?? "")],
      origins: originValue ? [canonicalOrigin(originValue)] : [],
      accountIds: split("accountIds"),
      counterpartyIds: split("counterpartyIds"),
      recipientIds: split("recipientIds"),
      perActionLimit: null,
      rollingLimit: null,
      maxUses: Number(form.get("maxUses") ?? 1),
      minimumIntervalSeconds: Number(form.get("minimumIntervalSeconds") ?? 0),
      quietHours: null,
      startsAt: startsAt.toISOString(),
      expiresAt: new Date(
        startsAt.getTime() + expiryDays * 86_400_000,
      ).toISOString(),
      revokedAt: null,
      alwaysRequireFreshApproval: false,
      alwaysRequireHumanTakeover: false,
    };
    const grant = authorityGrantSchema.parse({
      ...configuration,
      configurationVersion: authorityGrantConfigurationVersion(configuration),
    });
    await store.createAuthorityGrant(grant);
    return redirect(request, "saved");
  } catch {
    return redirect(request, "failed");
  } finally {
    await store.close();
  }
}

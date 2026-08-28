import { OpenInstinctStore } from "@openinstinct/db";
import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "../../../../src/lib/supabase/server";
import { isSameOrigin } from "../../../../src/lib/request-security";

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
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data: workspace } = await supabase
    .from("workspaces")
    .select("id")
    .eq("owner_user_id", user.id)
    .maybeSingle();
  if (!workspace)
    return NextResponse.json(
      { error: "Workspace not found." },
      { status: 404 },
    );
  const { id } = await context.params;
  const form = await request.formData();
  const approved = form.get("decision") === "approve";
  const inputHash = String(form.get("inputHash") ?? "");
  if (approved) {
    const { data: action } = await supabase
      .from("action_requests")
      .select("risk")
      .eq("id", id)
      .eq("workspace_id", workspace.id)
      .maybeSingle();
    if (
      action?.risk === "destructive" &&
      form.get("destructiveConfirmation") !== "CONFIRM DESTRUCTIVE ACTION"
    )
      return NextResponse.json(
        { error: "Destructive confirmation phrase did not match." },
        { status: 400 },
      );
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not configured.");
  const store = new OpenInstinctStore(databaseUrl);
  try {
    await store.decideAction({
      actionId: id,
      workspaceId: workspace.id,
      approved,
      inputHash,
      channel: "web",
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Decision failed." },
      { status: 409 },
    );
  } finally {
    await store.close();
  }
  return NextResponse.redirect(new URL("/", request.url), 303);
}

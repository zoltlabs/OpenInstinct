import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "./supabase/server";

export async function requireOwner() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const { data: workspace } = await supabase
    .from("workspaces")
    .select("id,owner_user_id")
    .eq("owner_user_id", user.id)
    .maybeSingle();
  return { supabase, user, workspace };
}

export async function requireFreshOwner(maxAgeSeconds = 300) {
  const owner = await requireOwner();
  const { data, error } = await owner.supabase.auth.getClaims();
  const authTime = Number(data?.claims?.auth_time ?? 0);
  if (
    error ||
    !Number.isFinite(authTime) ||
    Date.now() / 1_000 - authTime > maxAgeSeconds
  )
    throw new Error("Fresh owner authentication is required.");
  return owner;
}

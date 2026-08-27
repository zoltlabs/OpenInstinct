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

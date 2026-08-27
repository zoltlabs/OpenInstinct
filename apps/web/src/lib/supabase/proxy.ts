import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export async function refreshSupabaseSession(
  request: NextRequest,
): Promise<NextResponse> {
  let response = NextResponse.next({ request });
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (items) => {
          for (const item of items) request.cookies.set(item.name, item.value);
          response = NextResponse.next({ request });
          for (const item of items)
            response.cookies.set(item.name, item.value, item.options);
        },
      },
    },
  );
  await supabase.auth.getUser();
  return response;
}

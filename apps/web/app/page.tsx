import Link from "next/link";
import { createSupabaseServerClient } from "../src/lib/supabase/server";

export default async function Home() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return (
      <main>
        <h1>OpenInstinct</h1>
        <p className="lede">
          An open personal assistant that lives in iMessage, remembers context,
          and asks before it takes consequential action.
        </p>
        <section className="card" style={{ maxWidth: 420, marginTop: 40 }}>
          <h2>Owner sign in</h2>
          <p>
            One owner per deployment. We’ll email you a passwordless sign-in
            link.
          </p>
          <form action="/api/auth/sign-in" method="post">
            <input
              type="email"
              name="email"
              placeholder="you@example.com"
              required
            />
            <button type="submit">Send sign-in link</button>
          </form>
        </section>
      </main>
    );
  }

  const { data: workspace } = await supabase
    .from("workspaces")
    .select(
      "id,display_name,timezone,owner_phone_numbers(phone_e164,verified_at)",
    )
    .maybeSingle();

  if (!workspace) {
    return (
      <main>
        <h1>Make it yours.</h1>
        <p className="lede">
          This deployment belongs to one person. The phone must match{" "}
          <code>BLOOIO_OWNER_PHONE</code>.
        </p>
        <section className="card" style={{ maxWidth: 480, marginTop: 40 }}>
          <form action="/api/onboarding" method="post">
            <input name="displayName" placeholder="My OpenInstinct" required />
            <input
              name="phone"
              type="tel"
              placeholder="+15555550123"
              pattern="\+[1-9][0-9]{7,14}"
              required
            />
            <input name="timezone" defaultValue="UTC" required />
            <button type="submit">Create owner workspace</button>
          </form>
        </section>
      </main>
    );
  }

  const [{ data: connections }, { data: actions }, { data: runs }] =
    await Promise.all([
      supabase
        .from("connection_summaries")
        .select("id,provider,display_name,status,updated_at")
        .order("updated_at", { ascending: false }),
      supabase
        .from("action_requests")
        .select("id,summary,risk,status,input_hash,created_at")
        .eq("status", "pending")
        .order("created_at", { ascending: false }),
      supabase
        .from("agent_runs")
        .select("id,status,created_at,last_error")
        .order("created_at", { ascending: false })
        .limit(8),
    ]);

  return (
    <main>
      <h1>{workspace.display_name}</h1>
      <p className="lede">
        The dashboard is only a control plane. Talk to your assistant through
        iMessage.
      </p>
      <div className="grid">
        <section className="card">
          <h2>Google</h2>
          <p>
            Direct OAuth for Gmail and Calendar. Writes always require approval.
          </p>
          <Link className="button" href="/api/connectors/google/start">
            Connect Google
          </Link>
          <p className="status">
            {connections?.some(
              (c) => c.provider === "google" && c.status === "active",
            )
              ? "Connected"
              : "Not connected"}
          </p>
        </section>
        <section className="card">
          <h2>Remote MCP</h2>
          <p>
            Add any trusted HTTPS MCP server. Unknown tools default to
            approval-required.
          </p>
          <form action="/api/connectors/mcp" method="post">
            <input name="name" placeholder="Connector name" required />
            <input
              name="url"
              type="url"
              placeholder="https://mcp.example.com"
              required
            />
            <input
              name="bearerToken"
              type="password"
              placeholder="Bearer token (optional)"
            />
            <button type="submit">Connect MCP</button>
          </form>
        </section>
        <section className="card wide">
          <h2>Pending approvals</h2>
          {actions?.length ? (
            actions.map((action) => (
              <p key={action.id}>
                <Link href={`/approvals/${action.id}`}>{action.summary}</Link> ·{" "}
                {action.risk}
              </p>
            ))
          ) : (
            <p className="muted">Nothing waiting.</p>
          )}
        </section>
        <section className="card wide">
          <h2>Recent runs</h2>
          {runs?.length ? (
            runs.map((run) => (
              <p key={run.id}>
                <code>{run.status}</code> ·{" "}
                {new Date(run.created_at).toLocaleString()}{" "}
                {run.last_error ? `— ${run.last_error}` : ""}
              </p>
            ))
          ) : (
            <p className="muted">Text the Blooio number to start.</p>
          )}
        </section>
        <section className="card wide actions">
          <form action="/api/auth/sign-out" method="post">
            <button className="secondary">Sign out</button>
          </form>
        </section>
      </div>
    </main>
  );
}

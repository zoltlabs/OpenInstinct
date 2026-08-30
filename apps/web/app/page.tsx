import Link from "next/link";
import { createSupabaseServerClient } from "../src/lib/supabase/server";
import { feedbackForCode } from "../src/lib/feedback";
import { isValidTimeZone } from "../src/lib/validation";

function Feedback({ code }: { code?: string }) {
  const feedback = feedbackForCode(code);
  return feedback ? (
    <p className={`notice ${feedback.tone}`} role="status" aria-live="polite">
      {feedback.message}
    </p>
  ) : null;
}

function formatInterval(seconds: number): string {
  if (seconds % 86_400 === 0)
    return `${seconds / 86_400} ${seconds === 86_400 ? "day" : "days"}`;
  if (seconds % 3_600 === 0)
    return `${seconds / 3_600} ${seconds === 3_600 ? "hour" : "hours"}`;
  if (seconds % 60 === 0)
    return `${seconds / 60} ${seconds === 60 ? "minute" : "minutes"}`;
  return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
}

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ feedback?: string }>;
}) {
  const { feedback } = await searchParams;
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
        <Feedback code={feedback} />
        <section className="card" style={{ maxWidth: 420, marginTop: 40 }}>
          <h2>Owner sign in</h2>
          <p>
            One owner per deployment. We’ll email you a passwordless sign-in
            link.
          </p>
          <form action="/api/auth/sign-in" method="post">
            <label className="field" htmlFor="owner-email">
              <span>Email</span>
              <input
                id="owner-email"
                type="email"
                name="email"
                placeholder="you@example.com"
                required
              />
            </label>
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
        <Feedback code={feedback} />
        <section className="card" style={{ maxWidth: 480, marginTop: 40 }}>
          <form action="/api/onboarding" method="post">
            <label className="field" htmlFor="display-name">
              <span>Assistant name</span>
              <input
                id="display-name"
                name="displayName"
                placeholder="My OpenInstinct"
                required
              />
            </label>
            <label className="field" htmlFor="owner-phone">
              <span>Owner iMessage phone</span>
              <small>Use exact E.164 format, such as +15555550123.</small>
              <input
                id="owner-phone"
                name="phone"
                type="tel"
                placeholder="+15555550123"
                pattern="\+[1-9][0-9]{7,14}"
                required
              />
            </label>
            <label className="field" htmlFor="owner-timezone">
              <span>Time zone</span>
              <small>Use an IANA name, such as America/Mexico_City.</small>
              <input
                id="owner-timezone"
                name="timezone"
                defaultValue="UTC"
                required
              />
            </label>
            <button type="submit">Create owner workspace</button>
          </form>
        </section>
      </main>
    );
  }

  const timeZone = isValidTimeZone(workspace.timezone)
    ? workspace.timezone
    : "UTC";
  const formatDate = (value: string) =>
    new Intl.DateTimeFormat("en", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone,
    }).format(new Date(value));

  const [
    { data: connections },
    { data: actions },
    { data: runs },
    { data: schedules },
    { data: memories },
  ] = await Promise.all([
    supabase
      .from("connection_summaries")
      .select("id,provider,display_name,status,scopes,updated_at")
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
    supabase
      .from("scheduled_triggers")
      .select("id,kind,run_at,recurrence_seconds,status")
      .in("status", ["scheduled", "queued"])
      .order("run_at", { ascending: true })
      .limit(12),
    supabase
      .from("memories")
      .select("id,kind,content,sensitivity,updated_at")
      .order("updated_at", { ascending: false })
      .limit(12),
  ]);

  return (
    <main>
      <h1>{workspace.display_name}</h1>
      <p className="lede">
        The dashboard is only a control plane. Talk to your assistant through
        iMessage. Times are shown in {timeZone}.
      </p>
      <Feedback code={feedback} />
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
            <label className="field" htmlFor="mcp-name">
              <span>Connector name</span>
              <input id="mcp-name" name="name" required />
            </label>
            <label className="field" htmlFor="mcp-url">
              <span>Server URL</span>
              <small>
                Public HTTPS only; redirects and private networks are blocked.
              </small>
              <input
                id="mcp-url"
                name="url"
                type="url"
                placeholder="https://mcp.example.com"
                required
              />
            </label>
            <label className="field" htmlFor="mcp-token">
              <span>Bearer token</span>
              <small>Optional. Stored encrypted and never shown again.</small>
              <input
                id="mcp-token"
                name="bearerToken"
                type="password"
                placeholder="Bearer token (optional)"
              />
            </label>
            <button type="submit">Connect MCP</button>
          </form>
          {connections
            ?.filter((connection) => connection.provider === "mcp")
            .map((connection) => (
              <p className="status" key={connection.id}>
                {connection.display_name ?? "MCP"}:{" "}
                {connection.scopes.join(", ")}
              </p>
            ))}
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
          <h2>Reminders and routines</h2>
          {schedules?.length ? (
            schedules.map((schedule) => (
              <p key={schedule.id}>
                <code>{schedule.kind}</code> · {formatDate(schedule.run_at)}
                {schedule.recurrence_seconds
                  ? ` · every ${formatInterval(schedule.recurrence_seconds)}`
                  : ""}
              </p>
            ))
          ) : (
            <p className="muted">No active schedules.</p>
          )}
        </section>
        <section className="card wide">
          <h2>Memory</h2>
          {memories?.length ? (
            memories.map((memory) => (
              <p key={memory.id}>
                <code>{memory.kind}</code> · {memory.content} ·{" "}
                <span className="muted">{memory.sensitivity}</span>
              </p>
            ))
          ) : (
            <p className="muted">No owner-approved durable memories.</p>
          )}
        </section>
        <section className="card wide">
          <h2>Recent runs</h2>
          {runs?.length ? (
            runs.map((run) => (
              <p key={run.id}>
                <code>{run.status}</code> · {formatDate(run.created_at)}{" "}
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

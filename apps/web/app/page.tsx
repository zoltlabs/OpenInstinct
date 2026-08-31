import Link from "next/link";
import { listMcpConnectorCatalog } from "@openinstinct/connectors";
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
  const connectorCatalog = listMcpConnectorCatalog();
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
    { data: browserProfiles },
  ] = await Promise.all([
    supabase
      .from("connection_summaries")
      .select("id,provider,account_id,display_name,status,scopes,updated_at")
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
    supabase
      .from("browser_profile_summaries")
      .select("id,label,provider,status,allowed_origins,updated_at")
      .order("updated_at", { ascending: false }),
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
        <section className="card wide connector-hub">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Connectors</p>
              <h2>Connect the apps you use</h2>
            </div>
            <p className="section-copy">
              Choose an app here, or text your assistant “connect Granola.” If
              the service uses OAuth, you’ll finish securely in your browser.
            </p>
          </div>

          <div className="connector-options">
            <article className="connector-option">
              <div>
                <h3>Google</h3>
                <p>Gmail and Calendar through Google OAuth.</p>
              </div>
              <Link className="button" href="/api/connectors/google/start">
                {connections?.some(
                  (connection) =>
                    connection.provider === "google" &&
                    connection.status === "active",
                )
                  ? "Reconnect"
                  : "Connect"}
              </Link>
              <p className="connector-status">
                <span
                  className={`status-dot ${
                    connections?.some(
                      (connection) =>
                        connection.provider === "google" &&
                        connection.status === "active",
                    )
                      ? "active"
                      : ""
                  }`}
                />
                {connections?.some(
                  (connection) =>
                    connection.provider === "google" &&
                    connection.status === "active",
                )
                  ? "Connected"
                  : "Not connected"}
              </p>
            </article>

            {connectorCatalog.map((connector) => {
              const connection = connections?.find(
                (candidate) =>
                  candidate.provider === "mcp" &&
                  candidate.account_id === connector.url,
              );
              return (
                <article className="connector-option" key={connector.id}>
                  <div>
                    <h3>{connector.name}</h3>
                    <p>{connector.description}</p>
                  </div>
                  <Link
                    className="button"
                    href={`/api/connectors/mcp/start?catalog=${encodeURIComponent(connector.id)}`}
                  >
                    {connection?.status === "active" ? "Reconnect" : "Connect"}
                  </Link>
                  <p className="connector-status">
                    <span
                      className={`status-dot ${
                        connection?.status === "active"
                          ? "active"
                          : connection?.status === "pending"
                            ? "pending"
                            : connection?.status === "error"
                              ? "error"
                              : ""
                      }`}
                    />
                    {connection?.status === "active"
                      ? "Connected"
                      : connection?.status === "pending"
                        ? "Authorization pending"
                        : connection?.status === "error"
                          ? "Needs attention"
                          : "Not connected"}
                  </p>
                </article>
              );
            })}
          </div>

          <details className="custom-connector">
            <summary>Add a custom MCP server</summary>
            <p>
              For a server not listed above, enter its public HTTPS endpoint.
              OpenInstinct will discover OAuth automatically when supported.
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
                  placeholder="https://mcp.example.com/mcp"
                  required
                />
              </label>
              <label className="field" htmlFor="mcp-token">
                <span>Bearer token</span>
                <small>
                  Optional for legacy servers. Prefer browser OAuth when the
                  server supports it.
                </small>
                <input
                  id="mcp-token"
                  name="bearerToken"
                  type="password"
                  placeholder="Bearer token (optional)"
                />
              </label>
              <button type="submit">Connect custom MCP</button>
            </form>
          </details>

          {connections?.some((connection) => connection.provider === "mcp") ? (
            <div className="configured-connectors">
              <h3>Configured MCP servers</h3>
              {connections
                .filter((connection) => connection.provider === "mcp")
                .map((connection) => (
                  <p key={connection.id}>
                    <span
                      className={`status-dot ${
                        connection.status === "active"
                          ? "active"
                          : connection.status === "pending"
                            ? "pending"
                            : connection.status === "error"
                              ? "error"
                              : ""
                      }`}
                    />
                    {connection.display_name ?? "MCP"} · {connection.status}
                    {connection.scopes.length
                      ? ` · ${connection.scopes.length} tools`
                      : ""}
                  </p>
                ))}
            </div>
          ) : null}
        </section>
        <section className="card wide">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Browser identity</p>
              <h2>Authenticated websites</h2>
            </div>
            <p className="section-copy">
              Login happens in a private browser. OpenInstinct stores the
              profile reference and allowed origin, never cookies or passwords.
            </p>
          </div>
          <form action="/api/browser/profiles" method="post">
            <label className="field" htmlFor="browser-label">
              <span>Account label</span>
              <input
                id="browser-label"
                name="label"
                required
                maxLength={200}
                placeholder="Work travel"
              />
            </label>
            <label className="field" htmlFor="browser-origin">
              <span>Exact website origin</span>
              <input
                id="browser-origin"
                name="origin"
                type="url"
                required
                placeholder="https://example.com"
              />
            </label>
            <button type="submit">Connect browser account</button>
          </form>
          {browserProfiles?.length ? (
            <div className="configured-connectors">
              {browserProfiles.map((profile) => (
                <div key={profile.id}>
                  <p>
                    <span
                      className={`status-dot ${profile.status === "active" ? "active" : profile.status === "error" ? "error" : "pending"}`}
                    />
                    {profile.label} · {profile.status} ·{" "}
                    {(profile.allowed_origins as string[]).join(", ")}
                  </p>
                  <form
                    action={`/api/browser/profiles/${profile.id}`}
                    method="post"
                  >
                    {profile.status === "provisioning" ||
                    profile.status === "error" ? (
                      <button name="action" value="cleanup">
                        Reconcile and remove
                      </button>
                    ) : null}
                    {["needs_login", "active", "needs_reauth"].includes(
                      profile.status,
                    ) ? (
                      <>
                        <button
                          className="secondary"
                          name="action"
                          value="health"
                        >
                          Check health
                        </button>
                        <button
                          className="secondary"
                          name="action"
                          value="reauth"
                        >
                          Reauthenticate
                        </button>
                        <button
                          className="secondary"
                          name="action"
                          value="revoke"
                        >
                          Revoke
                        </button>
                      </>
                    ) : null}
                    {profile.status === "revoked" ? (
                      <button name="action" value="delete">
                        Delete permanently
                      </button>
                    ) : null}
                  </form>
                </div>
              ))}
            </div>
          ) : (
            <p className="muted">No browser identities enrolled.</p>
          )}
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

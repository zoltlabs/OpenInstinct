import { requireOwner } from "../../src/lib/owner";

export default async function AuthorityPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { supabase, workspace } = await requireOwner();
  const status = (await searchParams).status;
  const { data: grants } = workspace
    ? await supabase
        .from("authority_grants")
        .select(
          "id,name,effects,resource_classes,providers,origins,recipient_ids,max_uses,starts_at,expires_at,revoked_at",
        )
        .eq("workspace_id", workspace.id)
        .order("created_at", { ascending: false })
    : { data: [] };
  return (
    <main>
      <h1>Authority grants</h1>
      <p>
        Grants permit only the exact bounded semantic scope below. Financial,
        security, destructive, password, OTP, and payment actions remain
        unavailable.
      </p>
      {status ? (
        <p className={`notice ${status === "failed" ? "error" : "success"}`}>
          {status === "saved"
            ? "Grant created."
            : status === "revoked"
              ? "Grant revoked."
              : "The grant change could not be completed."}
        </p>
      ) : null}
      <section className="card" style={{ maxWidth: 760, marginTop: 24 }}>
        <h2>Create a bounded grant</h2>
        <form action="/api/authority/grants" method="post">
          <input type="hidden" name="operation" value="create" />
          <label>
            Name
            <input name="name" required maxLength={200} />
          </label>
          <label>
            Effect
            <select name="effect" defaultValue="create">
              <option value="create">Create</option>
              <option value="update">Update</option>
              <option value="send">Send communication</option>
            </select>
          </label>
          <label>
            Resource class
            <input name="resourceClass" required placeholder="calendar_event" />
          </label>
          <label>
            Provider
            <input name="provider" required placeholder="google" />
          </label>
          <label>
            Exact HTTPS origin (blank only for OpenInstinct resources)
            <input
              name="origin"
              type="url"
              placeholder="https://www.googleapis.com"
            />
          </label>
          <label>
            Account IDs (comma separated)
            <input name="accountIds" />
          </label>
          <label>
            Counterparty IDs (comma separated)
            <input name="counterpartyIds" />
          </label>
          <label>
            Recipient IDs (required for send; comma separated)
            <input name="recipientIds" />
          </label>
          <label>
            Maximum uses
            <input
              name="maxUses"
              type="number"
              min={1}
              max={1000}
              defaultValue={1}
              required
            />
          </label>
          <label>
            Minimum seconds between uses
            <input
              name="minimumIntervalSeconds"
              type="number"
              min={0}
              max={31557600}
              defaultValue={0}
              required
            />
          </label>
          <label>
            Expiry in days
            <input
              name="expiryDays"
              type="number"
              min={1}
              max={365}
              defaultValue={30}
              required
            />
          </label>
          <button type="submit">Create grant</button>
        </form>
      </section>
      <section style={{ marginTop: 32 }}>
        <h2>Existing grants</h2>
        {(grants ?? []).length === 0 ? <p>No grants yet.</p> : null}
        {(grants ?? []).map((grant) => (
          <article className="card" key={grant.id} style={{ marginTop: 16 }}>
            <h3>{grant.name}</h3>
            <p>
              <code>{grant.effects.join(", ")}</code> on{" "}
              <code>{grant.resource_classes.join(", ")}</code> via{" "}
              <code>{grant.providers.join(", ")}</code>
            </p>
            <p>
              Uses: at most {grant.max_uses ?? "unbounded"} · Expires{" "}
              {new Date(grant.expires_at).toLocaleString()} ·{" "}
              {grant.revoked_at ? "Revoked" : "Active"}
            </p>
            {!grant.revoked_at ? (
              <form action="/api/authority/grants" method="post">
                <input type="hidden" name="operation" value="revoke" />
                <input type="hidden" name="grantId" value={grant.id} />
                <button className="secondary" type="submit">
                  Revoke
                </button>
              </form>
            ) : null}
          </article>
        ))}
      </section>
    </main>
  );
}

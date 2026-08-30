import { notFound } from "next/navigation";
import { requireOwner } from "../../../src/lib/owner";
import { feedbackForCode } from "../../../src/lib/feedback";

export default async function ApprovalPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ feedback?: string }>;
}) {
  const { id } = await params;
  const feedback = feedbackForCode((await searchParams).feedback);
  const { supabase, workspace } = await requireOwner();
  if (!workspace) notFound();
  const { data: action } = await supabase
    .from("action_requests")
    .select("id,summary,risk,input,input_hash,status,expires_at")
    .eq("id", id)
    .eq("workspace_id", workspace.id)
    .maybeSingle();
  if (!action) notFound();
  return (
    <main>
      <h1>Review action</h1>
      {feedback ? (
        <p className={`notice ${feedback.tone}`} role="status">
          {feedback.message}
        </p>
      ) : null}
      <section className="card" style={{ maxWidth: 680, marginTop: 32 }}>
        <h2>{action.summary}</h2>
        <p>
          Risk: <code>{action.risk}</code> · Status:{" "}
          <code>{action.status}</code>
        </p>
        <pre
          style={{
            overflow: "auto",
            padding: 14,
            background: "#090c10",
            borderRadius: 10,
          }}
        >
          {JSON.stringify(action.input, null, 2)}
        </pre>
        {action.status === "pending" ? (
          <div className="actions">
            <form action={`/api/approvals/${action.id}`} method="post">
              <input type="hidden" name="decision" value="approve" />
              <input type="hidden" name="inputHash" value={action.input_hash} />
              {action.risk === "destructive" ? (
                <label>
                  Type <code>CONFIRM DESTRUCTIVE ACTION</code> to continue.
                  <input
                    name="destructiveConfirmation"
                    required
                    pattern="CONFIRM DESTRUCTIVE ACTION"
                    autoComplete="off"
                  />
                </label>
              ) : null}
              <button type="submit">Approve exactly this</button>
            </form>
            <form action={`/api/approvals/${action.id}`} method="post">
              <input type="hidden" name="decision" value="deny" />
              <input type="hidden" name="inputHash" value={action.input_hash} />
              <button className="secondary" type="submit">
                Deny
              </button>
            </form>
          </div>
        ) : (
          <p>This request has already been decided.</p>
        )}
      </section>
    </main>
  );
}

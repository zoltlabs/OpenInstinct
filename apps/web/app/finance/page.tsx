import Link from "next/link";
import { notFound } from "next/navigation";
import { OpenInstinctStore } from "@openinstinct/db";
import { requireOwner } from "../../src/lib/owner";
import { feedbackForCode } from "../../src/lib/feedback";

export default async function FinancePage({
  searchParams,
}: {
  searchParams: Promise<{ feedback?: string }>;
}) {
  const feedback = feedbackForCode((await searchParams).feedback);
  const { supabase, workspace } = await requireOwner();
  if (!workspace) notFound();
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required.");
  const store = new OpenInstinctStore(databaseUrl);
  const pilot = await store.listFinancialPilot(workspace.id);
  await store.close();
  const { data: transactions } = await supabase
    .from("financial_transactions")
    .select(
      "id,kind,status,amount_minor_units,currency,provider_transaction_id,committed_at,created_at",
    )
    .eq("workspace_id", workspace.id)
    .order("created_at", { ascending: false })
    .limit(50);

  return (
    <main>
      <p>
        <Link href="/">← Dashboard</Link>
      </p>
      <h1>Financial pilot</h1>
      <p>
        Sandbox only. Every purchase requires a fresh typed approval of the
        exact merchant, total, recurring terms, and payment alias.
      </p>
      {feedback ? (
        <p className={`notice ${feedback.tone}`}>{feedback.message}</p>
      ) : null}

      <section className="card" style={{ maxWidth: 760, marginTop: 24 }}>
        <h2>Global kill switch and limits</h2>
        <form action="/api/finance" method="post">
          <input type="hidden" name="action" value="settings" />
          <label>
            <input
              type="checkbox"
              name="enabled"
              defaultChecked={pilot.settings?.enabled}
            />
            Enable sandbox financial commits
          </label>
          <label>
            Currency{" "}
            <input
              name="currency"
              required
              pattern="[A-Z]{3}"
              defaultValue={pilot.settings?.currency ?? "USD"}
            />
          </label>
          <label>
            Per transaction (minor units){" "}
            <input
              name="perTransactionLimit"
              required
              inputMode="numeric"
              defaultValue={pilot.settings?.perTransactionLimit ?? "0"}
            />
          </label>
          <label>
            Daily (minor units){" "}
            <input
              name="dailyLimit"
              required
              inputMode="numeric"
              defaultValue={pilot.settings?.dailyLimit ?? "0"}
            />
          </label>
          <label>
            Monthly (minor units){" "}
            <input
              name="monthlyLimit"
              required
              inputMode="numeric"
              defaultValue={pilot.settings?.monthlyLimit ?? "0"}
            />
          </label>
          <button type="submit">Save global controls</button>
        </form>
      </section>

      <section className="card" style={{ maxWidth: 760, marginTop: 24 }}>
        <h2>Canary merchants</h2>
        {pilot.merchants.map((merchant) => (
          <form action="/api/finance" method="post" key={merchant.id}>
            <input type="hidden" name="action" value="merchant" />
            <input type="hidden" name="merchantId" value={merchant.id} />
            <p>
              <strong>{merchant.displayName}</strong>
              <br />
              <code>{merchant.exactOrigin}</code>
            </p>
            <label>
              <input
                type="checkbox"
                name="enabled"
                defaultChecked={merchant.enabled}
              />{" "}
              Enable merchant
            </label>
            <label>
              Per transaction (minor units){" "}
              <input
                name="perTransactionLimit"
                required
                inputMode="numeric"
                defaultValue={merchant.perTransactionLimit}
              />
            </label>
            <button type="submit">Save merchant</button>
          </form>
        ))}
      </section>

      <section className="card" style={{ maxWidth: 760, marginTop: 24 }}>
        <h2>Payment aliases</h2>
        {pilot.paymentAliases.map((paymentAlias) => (
          <form action="/api/finance" method="post" key={paymentAlias.id}>
            <input type="hidden" name="action" value="payment-alias" />
            <input
              type="hidden"
              name="paymentAliasId"
              value={paymentAlias.id}
            />
            <p>
              <strong>{paymentAlias.label}</strong>
              {paymentAlias.lastFour ? ` •••• ${paymentAlias.lastFour}` : ""}
            </p>
            <label>
              Status{" "}
              <select
                name="status"
                defaultValue={paymentAlias.status}
                disabled={paymentAlias.status === "revoked"}
              >
                <option value="active">Active</option>
                <option value="disabled">Disabled</option>
                <option value="revoked">Revoked permanently</option>
              </select>
            </label>
            <button type="submit" disabled={paymentAlias.status === "revoked"}>
              Save alias
            </button>
          </form>
        ))}
      </section>

      <section className="card" style={{ maxWidth: 760, marginTop: 24 }}>
        <h2>Orders and receipts</h2>
        {(transactions ?? []).length ? (
          <ul>
            {(transactions ?? []).map((transaction) => (
              <li key={transaction.id}>
                <code>{transaction.status}</code>{" "}
                {transaction.amount_minor_units} {transaction.currency} ·{" "}
                {transaction.provider_transaction_id ??
                  "provider outcome pending"}
              </li>
            ))}
          </ul>
        ) : (
          <p>No sandbox transactions yet.</p>
        )}
      </section>
    </main>
  );
}

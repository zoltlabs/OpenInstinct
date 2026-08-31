import Link from "next/link";
import type { Metadata } from "next";
import { requireOwner } from "../../../src/lib/owner";
import { browserStore } from "../../../src/lib/browser-service";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { referrer: "no-referrer" };

export default async function BrowserHandoffPage() {
  const { workspace } = await requireOwner();
  if (!workspace) return <main>Workspace not found.</main>;
  const store = browserStore();
  const credentials = await store
    .listCredentialItems(workspace.id)
    .finally(() => store.close());
  return (
    <main>
      <h1>Finish browser login</h1>
      <p className="lede">
        Open the private browser, complete login yourself, then return here.
        Stored passwords can be injected without displaying them. Passkeys,
        CAPTCHA, OTP, and recovery steps remain owner-only.
      </p>
      <div className="card">
        <Link
          className="button"
          target="_blank"
          rel="noreferrer"
          prefetch={false}
          href="/api/browser/takeover"
        >
          Open private browser
        </Link>
        <form action="/api/browser/complete" method="post">
          <button type="submit">I finished login</button>
        </form>
      </div>
      {credentials.some((item) =>
        ["active", "needs_verification"].includes(item.status),
      ) ? (
        <section className="card" style={{ marginTop: 20 }}>
          <h2>Model-blind credential injection</h2>
          <p>
            Open the private browser first and leave it on the exact login
            origin. Selectors describe trusted form controls; the secret never
            appears in this page or request.
          </p>
          <form action="/api/credentials/inject" method="post">
            <label className="field">
              <span>Credential</span>
              <select name="credentialItemId" required>
                {credentials
                  .filter((item) =>
                    ["active", "needs_verification"].includes(item.status),
                  )
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label} — {item.allowedOrigins[0]}
                    </option>
                  ))}
              </select>
            </label>
            <label className="field">
              <span>Username selector</span>
              <input
                name="usernameSelector"
                placeholder='input[type="email"]'
                required
              />
            </label>
            <label className="field">
              <span>Password selector</span>
              <input
                name="passwordSelector"
                placeholder='input[type="password"]'
                required
              />
            </label>
            <label className="field">
              <span>Submit selector (optional)</span>
              <input
                name="submitSelector"
                placeholder='button[type="submit"]'
              />
            </label>
            <button type="submit">Inject without showing me</button>
          </form>
        </section>
      ) : null}
    </main>
  );
}

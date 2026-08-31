import Link from "next/link";
import { requireOwner } from "../../src/lib/owner";
import { browserStore } from "../../src/lib/browser-service";

export const dynamic = "force-dynamic";

export default async function CredentialsPage({
  searchParams,
}: {
  searchParams: Promise<{ feedback?: string }>;
}) {
  const { workspace } = await requireOwner();
  if (!workspace) return <main>Workspace not found.</main>;
  const store = browserStore();
  const items = await store
    .listCredentialItems(workspace.id)
    .finally(() => store.close());
  const { feedback } = await searchParams;
  return (
    <main>
      <p>
        <Link href="/">← Control plane</Link>
      </p>
      <h1>Credential vault</h1>
      <p className="lede">
        Passwords are envelope-encrypted and injected only into an exact-origin
        private browser. They never enter model messages or action JSON.
      </p>
      {feedback ? (
        <p className="notice" role="status">
          Credential operation: {feedback}.
        </p>
      ) : null}
      <section className="card">
        <h2>Add website credential</h2>
        <form action="/api/credentials" method="post" autoComplete="off">
          <input type="hidden" name="action" value="create" />
          <label className="field">
            <span>Label</span>
            <input name="label" maxLength={200} required />
          </label>
          <label className="field">
            <span>Exact HTTPS origin</span>
            <input
              name="origin"
              type="url"
              placeholder="https://example.com"
              required
            />
          </label>
          <label className="field">
            <span>Username</span>
            <input name="username" autoComplete="off" required />
          </label>
          <label className="field">
            <span>Password</span>
            <input
              name="password"
              type="password"
              autoComplete="new-password"
              required
            />
          </label>
          <button type="submit">Encrypt and save</button>
        </form>
      </section>
      <div className="grid">
        {items.map((item) => (
          <section className="card" key={item.id}>
            <h2>{item.label}</h2>
            <p>{item.usernameHint ?? "No username hint"}</p>
            <p>
              <code>{item.allowedOrigins.join(", ")}</code>
            </p>
            <p>
              Status: {item.status} · record v{item.recordVersion} · key v
              {item.encryptionKeyVersion}
            </p>
            {item.status === "active" ||
            item.status === "needs_verification" ? (
              <>
                <details>
                  <summary>Replace secret</summary>
                  <form
                    action="/api/credentials"
                    method="post"
                    autoComplete="off"
                  >
                    <input type="hidden" name="action" value="replace" />
                    <input
                      type="hidden"
                      name="credentialItemId"
                      value={item.id}
                    />
                    <label className="field">
                      <span>Label</span>
                      <input name="label" defaultValue={item.label} required />
                    </label>
                    <label className="field">
                      <span>Exact origin</span>
                      <input
                        name="origin"
                        defaultValue={item.allowedOrigins[0]}
                        required
                      />
                    </label>
                    <label className="field">
                      <span>New username</span>
                      <input name="username" autoComplete="off" required />
                    </label>
                    <label className="field">
                      <span>New password</span>
                      <input
                        type="password"
                        name="password"
                        autoComplete="new-password"
                        required
                      />
                    </label>
                    <button type="submit">Replace</button>
                  </form>
                </details>
                <details>
                  <summary>Fresh-auth reveal or encrypted export</summary>
                  <p>
                    Sign in again first. Then type <code>REVEAL {item.id}</code>
                    .
                  </p>
                  <form
                    action="/api/credentials"
                    method="post"
                    target="_blank"
                    autoComplete="off"
                  >
                    <input
                      type="hidden"
                      name="credentialItemId"
                      value={item.id}
                    />
                    <label className="field">
                      <span>Exact confirmation</span>
                      <input name="confirmation" required />
                    </label>
                    <label className="field">
                      <span>
                        Export passphrase (16+ characters; export only)
                      </span>
                      <input
                        type="password"
                        name="exportPassphrase"
                        minLength={16}
                        autoComplete="new-password"
                      />
                    </label>
                    <button name="action" value="reveal" type="submit">
                      Reveal once
                    </button>{" "}
                    <button name="action" value="export" type="submit">
                      Download encrypted export
                    </button>
                  </form>
                </details>
                <form action="/api/credentials" method="post">
                  <input type="hidden" name="action" value="revoke" />
                  <input
                    type="hidden"
                    name="credentialItemId"
                    value={item.id}
                  />
                  <button type="submit">Revoke</button>
                </form>
              </>
            ) : item.status === "revoked" ? (
              <form action="/api/credentials" method="post">
                <input type="hidden" name="action" value="delete" />
                <input type="hidden" name="credentialItemId" value={item.id} />
                <button type="submit">Verify ciphertext deletion</button>
              </form>
            ) : null}
          </section>
        ))}
      </div>
    </main>
  );
}

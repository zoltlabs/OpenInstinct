import Link from "next/link";
import type { Metadata } from "next";
import { requireOwner } from "../../../src/lib/owner";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { referrer: "no-referrer" };

export default async function BrowserHandoffPage() {
  await requireOwner();
  return (
    <main>
      <h1>Finish browser login</h1>
      <p className="lede">
        Open the private browser, complete login yourself, then return here.
        Passwords, passkeys, CAPTCHA, and recovery steps remain owner-only.
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
    </main>
  );
}

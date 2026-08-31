import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import {
  encryptEmergencyCredentialExport,
  withDecryptedCredential,
} from "@openinstinct/credentials";
import { requireFreshOwner, requireOwner } from "../../../src/lib/owner";
import { isSameOrigin } from "../../../src/lib/request-security";
import {
  createCredential,
  credentialEnvelopeContext,
  credentialKeyring,
  replaceCredential,
} from "../../../src/lib/credential-service";
import {
  browserProvider,
  browserStore,
} from "../../../src/lib/browser-service";

export async function POST(request: Request) {
  if (!isSameOrigin(request))
    return new NextResponse("Forbidden", { status: 403 });
  const form = await request.formData();
  const action = String(form.get("action") ?? "");
  let owner = await requireOwner();
  if (["reveal", "export"].includes(action)) {
    try {
      owner = await requireFreshOwner();
    } catch {
      return new NextResponse("Fresh owner authentication is required.", {
        status: 403,
        headers: {
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
        },
      });
    }
  }
  if (!owner.workspace) return new NextResponse("Not found", { status: 404 });
  const workspaceId = owner.workspace.id;
  const credentialItemId = String(form.get("credentialItemId") ?? "");
  const store = browserStore();
  try {
    if (action === "create" || action === "replace") {
      const values = {
        workspaceId,
        label: String(form.get("label") ?? "").trim(),
        origin: String(form.get("origin") ?? "").trim(),
        username: String(form.get("username") ?? ""),
        password: String(form.get("password") ?? ""),
      };
      if (
        !values.label ||
        values.label.length > 200 ||
        !values.username ||
        !values.password
      )
        throw new Error("Credential form is incomplete.");
      if (action === "create") await createCredential(values);
      else await replaceCredential({ ...values, credentialItemId });
      return NextResponse.redirect(
        new URL("/credentials?feedback=saved", request.url),
        303,
      );
    }
    if (action === "revoke") {
      const sessions = await store.revokeCredentialItem({
        workspaceId,
        credentialItemId,
      });
      const provider = browserProvider();
      for (const session of sessions) {
        const closed = await provider
          .closeSession(session.providerSessionId)
          .then(() => true)
          .catch(() => false);
        if (closed)
          await store.closeBrowserControlSession({
            id: session.id,
            workspaceId,
          });
      }
      return NextResponse.redirect(
        new URL("/credentials?feedback=revoked", request.url),
        303,
      );
    }
    if (action === "delete") {
      await store.deleteRevokedCredentialItem({
        workspaceId,
        credentialItemId,
      });
      return NextResponse.redirect(
        new URL("/credentials?feedback=deleted", request.url),
        303,
      );
    }
    if (action === "reveal" || action === "export") {
      if (
        String(form.get("confirmation") ?? "") !== `REVEAL ${credentialItemId}`
      )
        return new NextResponse("Exact confirmation phrase required.", {
          status: 409,
        });
      const recovered = await store.getCredentialForOwnerRecovery({
        workspaceId,
        credentialItemId,
        purpose: action,
      });
      const body = await withDecryptedCredential({
        envelope: recovered.envelope,
        context: credentialEnvelopeContext(recovered.item),
        keyring: credentialKeyring(),
        use: (secret) => {
          if (action === "export")
            return encryptEmergencyCredentialExport({
              credentialItemId,
              allowedOrigins: recovered.item.allowedOrigins,
              secret,
              passphrase: String(form.get("exportPassphrase") ?? ""),
            });
          return `Username: ${Buffer.from(secret.username).toString("utf8")}\nPassword: ${Buffer.from(secret.password).toString("utf8")}\n`;
        },
      });
      await store.recordCredentialOwnerRecovery({
        workspaceId,
        credentialItemId,
        purpose: action,
      });
      return new NextResponse(body, {
        headers: {
          "Cache-Control": "no-store",
          "Content-Type":
            action === "export"
              ? "application/json"
              : "text/plain; charset=utf-8",
          "Content-Disposition": `${action === "export" ? "attachment" : "inline"}; filename="openinstinct-${action}-${randomUUID()}.txt"`,
          "Referrer-Policy": "no-referrer",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
    return new NextResponse("Unsupported action", { status: 400 });
  } catch {
    return NextResponse.redirect(
      new URL("/credentials?feedback=error", request.url),
      303,
    );
  } finally {
    await store.close();
  }
}

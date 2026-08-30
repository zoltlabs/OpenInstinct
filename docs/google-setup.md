# Google Gmail and Calendar setup

This runbook configures the Google OAuth application used by OpenInstinct's Gmail and Calendar connector. It is written for a local coding agent with `gcloud`, shell access, and optional computer control.

Use `gcloud` for authentication, project discovery or creation, API enablement, and verification. Use the Google Cloud Console only for Google Auth Platform settings and OAuth client creation: `gcloud` has no supported general-purpose command for those operations. Its IAP OAuth commands are unrelated, deprecated, and must not be used here.

## Safety and handoffs

- Never print, narrate, paste into chat, or pass a client secret as a command argument.
- Read-only discovery does not require confirmation.
- Ask immediately before creating a Google Cloud project, accepting terms or billing, creating an OAuth client, publishing an external app, or granting persistent OAuth access.
- The owner must review and complete Google account consent personally. Hand off CAPTCHA, password, security-warning, account-recovery, and unexpected-permission screens.
- Re-read the visible page before every browser action. Google changes the console frequently; labels in this runbook describe the current flow rather than a license to click by coordinates.
- Discover existing resources before every retry. A timeout is not evidence that creation failed.

OpenInstinct currently requests these scopes from `packages/connectors/src/google.ts`:

```text
openid
email
profile
https://www.googleapis.com/auth/gmail.readonly
https://www.googleapis.com/auth/gmail.compose
https://www.googleapis.com/auth/calendar
```

The Gmail scopes are restricted. The Calendar scope permits broad calendar access. Do not add scopes beyond this exact list; reducing the Calendar scope requires a code change and regression testing first.

## 1. Derive the exact configuration

Start from the final public HTTPS application URL. Do not use a preview URL for a production client.

```bash
export OPENINSTINCT_APP_URL="https://assistant.example.com"
export OPENINSTINCT_GOOGLE_REDIRECT_URI="${OPENINSTINCT_APP_URL}/api/connectors/google/callback"
```

Choose an existing Google Cloud project where possible. For a new project, choose an immutable, globally unique project ID of 6–30 lowercase letters, digits, or hyphens. Keep test and production OAuth clients in separate projects.

## 2. Authenticate and discover with `gcloud`

Check local state without changing Google Cloud:

```bash
gcloud --version
gcloud auth list --filter=status:ACTIVE --format='value(account)'
gcloud config get-value project
gcloud projects list --format='table(projectId,name,lifecycleState)'
```

Do not repeat account addresses from command output in chat or logs. If no suitable account is authenticated, ask the owner to complete:

```bash
gcloud auth login
```

The owner handles the Google sign-in page. After the flow returns, rerun the discovery commands.

### Use an existing project

Verify the selected project, then set it explicitly:

```bash
export OPENINSTINCT_GOOGLE_PROJECT_ID="existing-project-id"
gcloud projects describe "$OPENINSTINCT_GOOGLE_PROJECT_ID" \
  --format='yaml(projectId,name,lifecycleState)'
gcloud config set project "$OPENINSTINCT_GOOGLE_PROJECT_ID"
```

### Create a project only when needed

Ask for confirmation immediately before this command. If the project belongs under an organization or folder, discover that parent and include the appropriate flag.

```bash
export OPENINSTINCT_GOOGLE_PROJECT_ID="openinstinct-unique-id"
gcloud projects create "$OPENINSTINCT_GOOGLE_PROJECT_ID" \
  --name="OpenInstinct" \
  --set-as-default
```

Do not attach or upgrade billing unless Google requires it for an intended feature and the owner separately approves the choice.

## 3. Enable and verify the APIs with `gcloud`

First inspect what is already enabled:

```bash
gcloud services list --enabled \
  --project "$OPENINSTINCT_GOOGLE_PROJECT_ID" \
  --filter='config.name:(gmail.googleapis.com OR calendar-json.googleapis.com)' \
  --format='value(config.name)'
```

After confirming the project ID with the owner, enable any missing APIs:

```bash
gcloud services enable \
  gmail.googleapis.com \
  calendar-json.googleapis.com \
  --project "$OPENINSTINCT_GOOGLE_PROJECT_ID"
```

Rerun the list command and require both service names before continuing. If Google requests terms, billing, or a permission escalation, stop for owner review rather than improvising around it.

## 4. Configure Google Auth Platform in the browser

There is no supported general OAuth-app/client workflow in `gcloud`. Open the Google Auth Platform for the exact project:

```text
https://console.cloud.google.com/auth/overview?project=OPENINSTINCT_GOOGLE_PROJECT_ID
```

Computer control may navigate and fill ordinary non-secret fields. If computer control is unavailable or the UI differs, give the owner the same instructions manually.

### Branding

Open **Google Auth Platform → Branding** and configure:

- App name: `OpenInstinct`, or the owner's recognizable deployment name.
- User support email and developer contact email: an address the owner monitors.
- Home page, privacy policy, terms, logo, and authorized domains only when they are accurate and hosted on domains the owner controls.

Do not invent public policy URLs or claim a domain that the owner cannot verify.

### Audience

Open **Audience** and choose deliberately:

- **Internal** is appropriate only when the owner uses a Google Workspace organization and the app should be available solely inside it.
- **External / Testing** is useful for short practice. Add the owner's Google account as a test user. Testing authorizations, including offline refresh tokens for these scopes, expire after seven days.
- **External / In production** avoids the seven-day testing expiry for a durable personal deployment, but publishing and restricted scopes can introduce warnings, user caps, or Google verification requirements. Personal-use and limited-known-user exceptions may apply; they do not remove Google's policies. Ask before publishing.

For a personal Gmail account, `Internal` is not available. Do not promise that an unverified external app will be warning-free.

### Data Access

Open **Data Access**, choose **Add or remove scopes**, and add only the six scopes listed at the top of this runbook. Verify the saved list. Gmail read and compose are restricted scopes, so a broadly distributed application has additional verification obligations.

### Clients

Open **Clients** and first inspect existing clients. Reuse a correctly configured production web client rather than creating a duplicate.

If none is suitable, choose **Create client → Web application**, give it a recognizable name, and add this exact authorized redirect URI:

```text
https://assistant.example.com/api/connectors/google/callback
```

Use the value derived in step 1, including scheme, host, path, and any non-default port. A server-side authorization-code flow does not need an authorized JavaScript origin for this connector.

Creating the client creates a persistent credential. Ask for confirmation immediately before the final create action.

## 5. Capture credentials without exposing the secret

After creation, the agent may copy the non-secret client ID. The owner must transfer the client secret directly into OpenInstinct's loopback-only setup form or deployment secret store. The agent must not read the secret from the screen, clipboard, page source, or terminal history.

Preferred local capture:

```bash
pnpm run openinstinct -- setup-ui
```

The owner opens the printed `127.0.0.1` URL and enters:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REDIRECT_URI`

All three must be present together. The redirect value must exactly match the Google client. The form does not redisplay an existing secret and writes `.env.local` with owner-only permissions.

For a Vercel deployment, send the allowlisted values through stdin and redeploy:

```bash
pnpm run openinstinct -- push-vercel-env --environment production
vercel deploy --prod
```

For another host, use its secret store and restart or redeploy the web and worker processes. Never commit `.env.local`.

## 6. Connect the owner's account

1. Sign in to the deployed OpenInstinct control plane as the configured owner.
2. Start **Connect Google**.
3. Hand control to the owner for account selection, warning review, scope review, and consent.
4. Return only after Google redirects to `/api/connectors/google/callback` and OpenInstinct shows the connection.

OAuth uses authorization code flow with PKCE and requests offline access. OpenInstinct encrypts the resulting connector credentials before storing them in Supabase.

If Google offers fewer scopes than requested, do not treat the connection as fully configured merely because the callback succeeded. Record the omitted scopes and verify each intended Gmail and Calendar capability; the current connector does not yet provide a dedicated partial-grant health check.

## 7. Verify safely

Run repository diagnostics first:

```bash
pnpm --silent run doctor -- --target vercel --phase ready --json
pnpm --silent run smoke -- --url "$OPENINSTINCT_APP_URL" --json
```

Then verify from the owner conversation or control plane:

1. Search Gmail with a narrow query and inspect a known message. Reads may execute automatically.
2. List Calendar events in a small known time range. Reads may execute automatically.
3. Ask OpenInstinct to propose a Gmail draft. Confirm that it waits for approval; approve only if the owner wants the draft created.
4. Ask it to propose a harmless Calendar event. Confirm the exact calendar, time zone, guests, and text before approval. Remove the test event manually afterward if desired.

Do not send email or create an event merely to prove setup without the owner's approval. Gmail drafts and Calendar writes must cross OpenInstinct's durable approval boundary.

## Troubleshooting

- `redirect_uri_mismatch`: compare the runtime `GOOGLE_REDIRECT_URI` and the client's authorized redirect URI character for character, then redeploy after changing the secret store.
- `access_denied` or app unavailable: for External/Testing, verify that the owner is a listed test user; for Internal, verify that the account belongs to the project organization.
- Connection fails after about seven days: an External project left in Testing expires test authorizations and offline refresh tokens. Reconnect for practice or deliberately choose the production path.
- `access_not_configured` / API disabled: rerun the enabled-services check for both API service names in the selected project.
- Workspace policy blocks restricted scopes: an organization administrator must review the app. Do not bypass the policy with another identity or a service-account key.
- No refresh token: revoke the app's existing Google Account grant if appropriate, then reconnect and consent again; do not edit encrypted token records directly.
- Consent or verification warning: hand control to the owner. Do not click through or characterize the warning as harmless.

Official references: [Google OAuth web-server flow](https://developers.google.com/identity/protocols/oauth2/web-server), [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes), [Calendar scopes](https://developers.google.com/workspace/calendar/api/auth), [app audience and testing expiry](https://support.google.com/cloud/answer/15549945), and [restricted-scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification).

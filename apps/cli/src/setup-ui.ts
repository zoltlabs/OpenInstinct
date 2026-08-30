import { randomBytes } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readFile } from "node:fs/promises";
import { environmentFieldSchemas } from "@openinstinct/runtime";
import { envFileValues, pathExists, setEnvValues } from "./env-file";
import { configureBlooio, ensureBlooioWebhook } from "./blooio-setup";
import { setupActions } from "./setup-plan";

const MAX_BODY_BYTES = 64 * 1024;

const fields = [
  {
    name: "OWNER_EMAIL",
    label: "Owner email",
    type: "email",
    help: "The only address allowed to sign in.",
  },
  {
    name: "BLOOIO_OWNER_PHONE",
    label: "Owner iMessage phone",
    type: "tel",
    help: "Exact E.164 format, for example +15551234567.",
  },
  {
    name: "BLOOIO_API_KEY",
    label: "Blooio API key",
    type: "password",
    help: "Stored locally and never redisplayed.",
  },
  {
    name: "BLOOIO_CHANNEL_ID",
    label: "Blooio channel ID",
    type: "password",
    help: "Optional until Blooio provisions the number.",
  },
  {
    name: "DATABASE_URL",
    label: "Supabase database URL",
    type: "password",
    help: "The Postgres URL containing the generated database password.",
  },
  {
    name: "AI_PROVIDER",
    label: "AI provider",
    type: "text",
    displayStored: true,
    help: "openai, anthropic, google, openrouter, vercel-gateway, or openai-compatible.",
  },
  {
    name: "AI_MODEL",
    label: "AI model",
    type: "text",
    displayStored: true,
    help: "The provider-native model ID.",
  },
  {
    name: "OPENAI_API_KEY",
    label: "OpenAI API key",
    type: "password",
    help: "Required only when AI_PROVIDER is openai.",
  },
  {
    name: "ANTHROPIC_API_KEY",
    label: "Anthropic API key",
    type: "password",
    help: "Required only when AI_PROVIDER is anthropic.",
  },
  {
    name: "GOOGLE_GENERATIVE_AI_API_KEY",
    label: "Google Generative AI API key",
    type: "password",
    help: "Required only when AI_PROVIDER is google.",
  },
  {
    name: "OPENROUTER_API_KEY",
    label: "OpenRouter API key",
    type: "password",
    help: "Required only when AI_PROVIDER is openrouter.",
  },
  {
    name: "AI_GATEWAY_API_KEY",
    label: "Vercel AI Gateway API key",
    type: "password",
    help: "Needed for local previews; deployed Vercel functions can use OIDC instead.",
  },
  {
    name: "AI_COMPATIBLE_BASE_URL",
    label: "OpenAI-compatible base URL",
    type: "url",
    help: "Required only when AI_PROVIDER is openai-compatible.",
  },
  {
    name: "AI_COMPATIBLE_API_KEY",
    label: "OpenAI-compatible API key",
    type: "password",
    help: "Optional when the compatible endpoint does not require authentication.",
  },
  {
    name: "GOOGLE_CLIENT_ID",
    label: "Google OAuth client ID",
    type: "password",
    help: "Web application OAuth client.",
  },
  {
    name: "GOOGLE_CLIENT_SECRET",
    label: "Google OAuth client secret",
    type: "password",
    help: "Stored locally and never redisplayed.",
  },
  {
    name: "GOOGLE_REDIRECT_URI",
    label: "Google redirect URL",
    type: "url",
    help: "Your public app URL plus /api/connectors/google/callback.",
  },
  {
    name: "NEXT_PUBLIC_APP_URL",
    label: "Public app URL",
    type: "url",
    displayStored: true,
    help: "The final Vercel HTTPS URL. It can be added after deployment.",
  },
  {
    name: "KERNEL_API_KEY",
    label: "Cloud browser API key",
    type: "password",
    help: "Kernel browser access. Connect it after deployment.",
  },
] as const;

type FieldName = (typeof fields)[number]["name"];

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function hasPublicAppUrl(configured: Set<string>, value: string | undefined) {
  if (!configured.has("NEXT_PUBLIC_APP_URL") || !value) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !["localhost", "127.0.0.1", "::1"].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

function page(input: {
  csrfToken: string;
  values: Record<string, string | undefined>;
  message?: string;
  errors?: string[];
}): string {
  const configured = new Set(
    Object.entries(input.values)
      .filter(([, value]) => Boolean(value))
      .map(([name]) => name),
  );
  const infrastructureLinks = [
    [
      "Supabase",
      "Create the free database project",
      "https://supabase.com/dashboard/new",
    ],
    [
      "Vercel",
      "Import OpenInstinct from GitHub",
      "https://vercel.com/new/import?s=https%3A%2F%2Fgithub.com%2Fzoltlabs%2FOpenInstinct",
    ],
  ];
  const integrationLinks = [
    [
      "Google Cloud",
      "Create Gmail and Calendar OAuth credentials",
      "https://console.cloud.google.com/apis/credentials",
    ],
    ["Blooio", "Start the 20-message free trial", "https://app.blooio.com"],
    ["Kernel", "Enable cloud browser tasks", "https://dashboard.onkernel.com"],
  ];
  const renderLinks = (links: string[][]) =>
    links
      .map(
        ([name, description, url]) =>
          `<a class="provider" href="${url}" target="_blank" rel="noreferrer"><strong>${name}</strong><span>${description}</span><b>Open ↗</b></a>`,
      )
      .join("");
  const renderFields = (names: readonly FieldName[]) =>
    fields
      .filter((field) => names.includes(field.name))
      .map((field) => {
        const isConfigured = configured.has(field.name);
        const displayStored = "displayStored" in field && field.displayStored;
        const storedValue = displayStored
          ? input.values[field.name]
          : undefined;
        const help =
          isConfigured && !displayStored
            ? "Configured — leave blank to keep it"
            : escapeHtml(field.help);
        return `<label><span>${escapeHtml(field.label)}</span><small>${help}</small><input name="${field.name}" type="${field.type}" autocomplete="off"${storedValue ? ` value="${escapeHtml(storedValue)}"` : ""} placeholder="${isConfigured && !displayStored ? "••••••••" : "Not configured"}"></label>`;
      })
      .join("");
  const ownerFields = renderFields(["OWNER_EMAIL"]);
  const providerFields = renderFields([
    "DATABASE_URL",
    "NEXT_PUBLIC_APP_URL",
    "AI_PROVIDER",
    "AI_MODEL",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GOOGLE_GENERATIVE_AI_API_KEY",
    "OPENROUTER_API_KEY",
    "AI_GATEWAY_API_KEY",
    "AI_COMPATIBLE_BASE_URL",
    "AI_COMPATIBLE_API_KEY",
  ]);
  const integrationFields = renderFields([
    "BLOOIO_OWNER_PHONE",
    "BLOOIO_API_KEY",
    "BLOOIO_CHANNEL_ID",
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "GOOGLE_REDIRECT_URI",
    "KERNEL_API_KEY",
  ]);
  const progress = [
    [
      "Local security",
      ["SECRET_ENCRYPTION_KEY", "INTERNAL_API_SECRET"].every((name) =>
        configured.has(name),
      ),
      "Generated automatically",
    ],
    [
      "Database",
      [
        "DATABASE_URL",
        "NEXT_PUBLIC_SUPABASE_URL",
        "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
      ].every((name) => configured.has(name)),
      "Supabase",
    ],
    [
      "Deployment",
      hasPublicAppUrl(configured, input.values.NEXT_PUBLIC_APP_URL),
      "Create the Vercel project, then capture its assigned URL",
    ],
    [
      "iMessage",
      ["BLOOIO_OWNER_PHONE", "BLOOIO_API_KEY", "BLOOIO_WEBHOOK_SECRET"].every(
        (name) => configured.has(name),
      ),
      "Connect after deployment",
    ],
    [
      "Gmail + Calendar",
      ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI"].every(
        (name) => configured.has(name),
      ),
      "Connect after deployment",
    ],
    [
      "Cloud browser",
      configured.has("KERNEL_API_KEY"),
      "Connect after deployment",
    ],
  ] as const;
  const progressHtml = progress
    .map(
      ([label, complete, detail]) =>
        `<div class="step ${complete ? "done" : "pending"}"><i>${complete ? "✓" : ""}</i><span><strong>${label}</strong><small>${complete ? "Ready" : detail}</small></span></div>`,
    )
    .join("");
  const notice = input.message
    ? `<p class="notice success">${escapeHtml(input.message)}</p>`
    : input.errors?.length
      ? `<div class="notice error"><strong>Nothing was saved.</strong><ul>${input.errors.map((error) => `<li>${escapeHtml(error)}</li>`).join("")}</ul></div>`
      : `<p class="notice">Enter whatever is available now. Blank fields preserve their current values, so this page is safe to use in stages.</p>`;
  const phaseLabels = {
    infrastructure: "Infrastructure",
    deployment: "Deployment",
    imessage: "iMessage",
    verify: "Verification",
  } as const;
  const actionPlan = setupActions("vercel", input.values);
  const actionPlanHtml = Object.entries(phaseLabels)
    .map(([phase, label]) => {
      const actions = actionPlan.filter((item) => item.phase === phase);
      return `<section class="phase"><h3>${label}</h3>${actions
        .map(
          (item) =>
            `<div class="action ${item.status}"><i>${item.status === "complete" ? "✓" : item.status === "blocked" ? "·" : "→"}</i><span><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.status === "complete" ? "Complete" : item.status === "blocked" ? "Waiting for an earlier step" : (item.description ?? item.command ?? "Ready"))}</small></span>${item.browserUrl ? `<a href="${escapeHtml(item.browserUrl)}" target="_blank" rel="noreferrer">Open ↗</a>` : ""}</div>`,
        )
        .join("")}</section>`;
    })
    .join("");
  const canVerifyBlooio = configured.has("BLOOIO_API_KEY");
  const canRegisterBlooio =
    canVerifyBlooio &&
    hasPublicAppUrl(configured, input.values.NEXT_PUBLIC_APP_URL);
  const webhookReady = configured.has("BLOOIO_WEBHOOK_SECRET");
  const blooioActions = `<section class="blooio"><h2>Finish Blooio</h2><p>You manage the Blooio account directly. Complete account verification and billing, provision a number, create an API key assigned to it, then save that key and your personal owner phone above.</p><ol><li><a href="https://app.blooio.com" target="_blank" rel="noreferrer">Open Blooio ↗</a> and provision the assistant number.</li><li>Save the API key and owner phone in this wizard.</li><li>Verify the key, then register the production webhook.</li></ol><div class="buttonrow"><form method="post" action="/verify-blooio"><input type="hidden" name="csrf" value="${escapeHtml(input.csrfToken)}"><button type="submit" ${canVerifyBlooio ? "" : "disabled"}>Verify Blooio</button></form><form method="post" action="/register-blooio-webhook"><input type="hidden" name="csrf" value="${escapeHtml(input.csrfToken)}"><button type="submit" ${canRegisterBlooio && !webhookReady ? "" : "disabled"}>${webhookReady ? "Webhook registered" : "Register webhook"}</button></form></div><small>${!canVerifyBlooio ? "Save the API key first." : !canRegisterBlooio ? "Add the final public app URL before webhook registration." : webhookReady ? "The signing secret is stored locally and never displayed." : "Registering the webhook changes Blooio and captures its one-time signing secret."}</small></section>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OpenInstinct setup</title><style>
  :root{color-scheme:dark;font-family:ui-sans-serif,system-ui,sans-serif;background:#09090b;color:#fafafa}body{margin:0}.shell{max-width:760px;margin:0 auto;padding:48px 20px 80px}h1{font-size:clamp(2rem,6vw,4rem);letter-spacing:-.05em;margin:0 0 12px}h2{margin:38px 0 8px}p{color:#a1a1aa;line-height:1.6}.notice,details{border:1px solid #3f3f46;background:#18181b;border-radius:14px;padding:14px 16px;margin:28px 0}.success{border-color:#166534;color:#bbf7d0}.error{border-color:#991b1b;color:#fecaca}.providers,.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px}.provider,label{display:flex;flex-direction:column;gap:7px;background:#18181b;border:1px solid #27272a;border-radius:14px;padding:16px}.provider{color:#fafafa;text-decoration:none}.provider span,small{color:#a1a1aa;line-height:1.35}.provider b{color:#c4b5fd;margin-top:5px}.provider:hover{border-color:#7c3aed}label span{font-weight:650}small{min-height:2.5em}input{font:inherit;color:#fafafa;background:#09090b;border:1px solid #3f3f46;border-radius:9px;padding:12px}input:focus{outline:2px solid #a78bfa;border-color:transparent}button{margin-top:22px;border:0;border-radius:10px;padding:13px 20px;font:inherit;font-weight:700;background:#fafafa;color:#09090b;cursor:pointer}.foot{font-size:.85rem;margin-top:20px}.steps{display:grid;gap:10px;margin:20px 0}.step{display:flex;gap:12px;align-items:center;padding:12px 4px;border-bottom:1px solid #27272a}.step i{width:24px;height:24px;border-radius:50%;border:1px solid #52525b;display:grid;place-items:center;font-style:normal}.step.done i{background:#166534;border-color:#22c55e}.step span{display:flex;flex:1;justify-content:space-between;gap:12px}.step small{min-height:0}summary{cursor:pointer;font-weight:700}details .grid,details .providers{margin-top:16px}.advanced{color:#c4b5fd}
  .phase{margin:20px 0 30px}.phase h3{margin:12px 0}.action{display:flex;gap:12px;align-items:center;padding:13px;border:1px solid #27272a;border-radius:12px;margin:8px 0;background:#111113}.action i{width:24px;height:24px;border-radius:50%;border:1px solid #52525b;display:grid;place-items:center;font-style:normal}.action.complete i{background:#166534;border-color:#22c55e}.action span{display:flex;flex:1;flex-direction:column;gap:4px}.action small{min-height:0}.action>a,.blooio a{color:#c4b5fd}.action.blocked{opacity:.62}.blooio{border:1px solid #4c1d95;background:#18112b;border-radius:16px;padding:18px;margin:32px 0}.blooio ol{color:#d4d4d8;line-height:1.7}.buttonrow{display:flex;gap:10px;flex-wrap:wrap}.buttonrow button{margin:0}.buttonrow button:disabled{cursor:not-allowed;opacity:.45}
  </style></head><body><main class="shell"><h1>Set up your assistant</h1><p>The default uses Supabase and Vercel Hobby. Scheduling is handled inside Supabase, so there is no Cloudflare account to create.</p>${notice}<h2>Progress</h2><div class="steps">${progressHtml}</div><h2>Setup plan</h2>${actionPlanHtml}<h2>Private configuration</h2><p>Your existing values are never rendered. Save this form in stages; blank fields preserve what is already configured.</p><form method="post" action="/save"><input type="hidden" name="csrf" value="${escapeHtml(input.csrfToken)}"><div class="grid">${ownerFields}</div><details><summary>Provider credentials</summary><p>Open the two infrastructure accounts when prompted, then paste private values here. Existing values are never displayed.</p><div class="providers">${renderLinks(infrastructureLinks)}</div><div class="grid">${providerFields}</div></details><details><summary>Gmail, Calendar, iMessage, and browser</summary><p>These are connected after the app has a public URL, so they never block deployment.</p><div class="providers">${renderLinks(integrationLinks)}</div><div class="grid">${integrationFields}</div></details><details><summary>Advanced deployment options</summary><p>The default is the fewest-account path. Choose <code>vercel-pro</code> for native Vercel cron or <code>vercel-cloudflare</code> for the legacy free Cloudflare scheduler.</p><a class="advanced" href="https://dash.cloudflare.com/login" target="_blank" rel="noreferrer">Open Cloudflare ↗</a></details><button type="submit">Save and continue</button></form>${blooioActions}<p class="foot">Bound to 127.0.0.1 · no analytics · no external assets · values are written only to <code>.env.local</code> with owner-only permissions.</p></main></body></html>`;
}

function sendHtml(
  response: ServerResponse,
  status: number,
  html: string,
): void {
  response.writeHead(status, {
    "Cache-Control": "no-store, max-age=0",
    "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    "Content-Type": "text/html; charset=utf-8",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  });
  response.end(html);
}

async function readBody(request: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of request) {
    body += String(chunk);
    if (Buffer.byteLength(body) > MAX_BODY_BYTES)
      throw new Error("The submitted form is too large.");
  }
  return body;
}

export async function validateSetupWizardValues(
  submitted: URLSearchParams,
  current: Record<string, string | undefined>,
): Promise<{ values: Record<string, string>; errors: string[] }> {
  const values: Record<string, string> = {};
  const errors: string[] = [];
  for (const field of fields) {
    const raw = submitted.get(field.name)?.trim() ?? "";
    if (!raw) continue;
    const result = environmentFieldSchemas[field.name].safeParse(raw);
    if (!result.success) errors.push(`${field.label}: invalid value.`);
    else values[field.name] = result.data;
  }
  const merged = { ...current, ...values };
  const google = [
    merged.GOOGLE_CLIENT_ID,
    merged.GOOGLE_CLIENT_SECRET,
    merged.GOOGLE_REDIRECT_URI,
  ].filter(Boolean).length;
  if (google > 0 && google < 3)
    errors.push(
      "Google OAuth requires the client ID, client secret, and redirect URL together.",
    );
  return { values, errors };
}

export async function startSetupUi(input: {
  envPath: string;
  port: number;
  fetch?: typeof fetch;
}): Promise<{ url: string; close: () => Promise<void> }> {
  const csrfToken = randomBytes(32).toString("base64url");
  let origin = "";
  const readCurrent = async () =>
    (await pathExists(input.envPath))
      ? envFileValues(await readFile(input.envPath, "utf8"))
      : {};
  const renderPage = async (
    response: ServerResponse,
    status: number,
    feedback: { message?: string; errors?: string[] } = {},
  ) =>
    sendHtml(
      response,
      status,
      page({
        csrfToken,
        values: await readCurrent(),
        ...feedback,
      }),
    );
  const readLocalPost = async (
    request: IncomingMessage,
  ): Promise<URLSearchParams> => {
    if (request.headers.origin !== origin)
      throw new Error("Invalid request origin.");
    if (
      !request.headers["content-type"]?.startsWith(
        "application/x-www-form-urlencoded",
      )
    )
      throw new Error("Unsupported form encoding.");
    const submitted = new URLSearchParams(await readBody(request));
    if (submitted.get("csrf") !== csrfToken)
      throw new Error("The setup session expired. Refresh and try again.");
    return submitted;
  };
  const server = createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/") {
        await renderPage(response, 200);
        return;
      }
      if (request.method === "POST" && request.url === "/save") {
        const submitted = await readLocalPost(request);
        const current = await readCurrent();
        const result = await validateSetupWizardValues(submitted, current);
        if (result.errors.length) {
          await renderPage(response, 400, { errors: result.errors });
          return;
        }
        if (Object.keys(result.values).length)
          await setEnvValues(input.envPath, result.values);
        await renderPage(response, 200, {
          message: `Saved ${Object.keys(result.values).length} value${Object.keys(result.values).length === 1 ? "" : "s"}.`,
        });
        return;
      }
      if (request.method === "POST" && request.url === "/verify-blooio") {
        await readLocalPost(request);
        const current = await readCurrent();
        const apiKey = current.BLOOIO_API_KEY;
        if (!apiKey) throw new Error("Save the Blooio API key first.");
        const result = await configureBlooio({
          envPath: input.envPath,
          apiKey,
          ...(current.BLOOIO_CHANNEL_ID
            ? { channelId: current.BLOOIO_CHANNEL_ID }
            : {}),
          ...(input.fetch ? { fetch: input.fetch } : {}),
        });
        await renderPage(response, 200, {
          message: result.selectedChannelId
            ? `Verified Blooio and selected the active channel ${result.selectedChannelId}.`
            : `Verified Blooio with ${result.channels.length} active channels. Blooio will use the API key's configured routing priority.`,
        });
        return;
      }
      if (
        request.method === "POST" &&
        request.url === "/register-blooio-webhook"
      ) {
        await readLocalPost(request);
        const current = await readCurrent();
        if (!current.NEXT_PUBLIC_APP_URL)
          throw new Error("Save the final public app URL first.");
        const result = await ensureBlooioWebhook({
          envPath: input.envPath,
          appUrl: current.NEXT_PUBLIC_APP_URL,
          ...(input.fetch ? { fetch: input.fetch } : {}),
        });
        await renderPage(response, 200, {
          message:
            result.operation === "reused"
              ? "Verified the existing Blooio webhook and preserved its stored signing secret."
              : `${result.operation === "created" ? "Registered" : "Recovered"} the Blooio webhook and stored its signing secret privately.`,
        });
        return;
      }
      response.writeHead(404, { "Cache-Control": "no-store" });
      response.end("Not found");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = message === "Invalid request origin." ? 403 : 400;
      await renderPage(response, status, { errors: [message] });
    }
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(input.port, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Could not determine the setup UI address.");
  origin = `http://127.0.0.1:${address.port}`;
  return {
    url: origin,
    close: () =>
      new Promise<void>((resolveClose, rejectClose) =>
        server.close((error) => (error ? rejectClose(error) : resolveClose())),
      ),
  };
}

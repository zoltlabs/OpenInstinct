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
    label: "Your phone number",
    type: "tel",
    help: "The personal number you will text from — not the Blooio assistant number. Use E.164 format, for example +15551234567.",
  },
  {
    name: "BLOOIO_API_KEY",
    label: "Blooio API key",
    type: "password",
    help: "Paste the key from Blooio → API keys. It is stored in .env.local and never shown again.",
  },
  {
    name: "BLOOIO_CHANNEL_ID",
    label: "Blooio channel ID",
    type: "text",
    help: "Optional. Verify fills this in automatically when your account has one active number.",
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
  focusStep?: string;
  submitted?: URLSearchParams;
  fieldErrors?: Partial<Record<FieldName, string>>;
  actionError?: boolean;
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
  const renderLinks = (links: string[][]) =>
    links
      .map(
        ([name, description, url]) =>
          `<a class="provider" href="${url}" target="_blank" rel="noreferrer"><strong>${name}</strong><span>${description}</span><b>Open ↗</b></a>`,
      )
      .join("");
  const placeholders: Partial<Record<FieldName, string>> = {
    OWNER_EMAIL: "you@example.com",
    BLOOIO_OWNER_PHONE: "+15551234567",
    BLOOIO_API_KEY: "Paste your Blooio key",
    BLOOIO_CHANNEL_ID: "Filled automatically after verification",
    DATABASE_URL: "postgresql://…",
    NEXT_PUBLIC_APP_URL: "https://your-app.vercel.app",
    AI_PROVIDER: "openai",
    AI_MODEL: "Provider model ID",
    GOOGLE_REDIRECT_URI:
      "https://your-app.vercel.app/api/connectors/google/callback",
  };
  const renderFields = (names: readonly FieldName[]) =>
    names
      .map((name) => fields.find((field) => field.name === name))
      .filter((field): field is (typeof fields)[number] => Boolean(field))
      .map((field) => {
        const isConfigured = configured.has(field.name);
        const isSecret = field.type === "password";
        const displayStored = !isSecret;
        const submittedValue =
          displayStored && input.submitted?.has(field.name)
            ? (input.submitted.get(field.name) ?? "")
            : undefined;
        const storedValue = displayStored
          ? (submittedValue ?? input.values[field.name])
          : undefined;
        const fieldError = input.fieldErrors?.[field.name];
        const helpId = `help-${field.name}`;
        const errorId = `error-${field.name}`;
        const help =
          isConfigured && isSecret
            ? "Saved. Leave blank to keep it, or paste a new value to replace it."
            : escapeHtml(field.help);
        const describedBy = fieldError ? `${helpId} ${errorId}` : helpId;
        const inputMode =
          field.type === "tel"
            ? ' inputmode="tel"'
            : field.type === "url"
              ? ' inputmode="url"'
              : "";
        return `<label id="field-${field.name}" class="field${fieldError ? " invalid" : ""}"><span>${escapeHtml(field.label)}</span><small id="${helpId}">${help}</small><input id="input-${field.name}" name="${field.name}" type="${field.type}" autocomplete="${field.type === "email" ? "email" : "off"}" autocapitalize="off" spellcheck="false" aria-describedby="${describedBy}"${fieldError ? ' aria-invalid="true"' : ""}${inputMode}${storedValue ? ` value="${escapeHtml(storedValue)}"` : ""} placeholder="${isConfigured && isSecret ? "••••••••" : escapeHtml(placeholders[field.name] ?? "")}">${fieldError ? `<small class="field-error" id="${errorId}">${escapeHtml(fieldError)}</small>` : ""}</label>`;
      })
      .join("");
  const notice = input.message
    ? `<p class="notice success" role="status" aria-live="polite">${escapeHtml(input.message)}</p>`
    : input.errors?.length
      ? `<div class="notice error" role="alert" aria-live="assertive"><strong>${input.actionError ? "That step didn't complete." : "We couldn't save that yet."}</strong><ul>${input.errors.map((error) => `<li>${escapeHtml(error)}</li>`).join("")}</ul></div>`
      : "";
  const phaseLabels = {
    infrastructure: "Infrastructure",
    deployment: "Deployment",
    imessage: "iMessage",
    verify: "Verification",
  } as const;
  const actionPlan = setupActions("vercel", input.values);
  const actionById = new Map(actionPlan.map((action) => [action.id, action]));
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
  const ownerReady = actionById.get("configure-owner")?.status === "complete";
  const coreReady =
    actionById.get("capture-supabase")?.status === "complete" &&
    actionById.get("capture-app-url")?.status === "complete" &&
    configured.has("AI_PROVIDER") &&
    configured.has("AI_MODEL");
  const iMessageReady = actionById.get("verify-ready")?.status === "complete";
  const essentialSteps = [
    ["owner", "You", ownerReady],
    ["core", "Core", coreReady],
    ["imessage", "iMessage", iMessageReady],
  ] as const;
  const completedSteps = essentialSteps.filter(([, , ready]) => ready).length;
  const requestedStep = [
    "owner",
    "core",
    "imessage",
    "google",
    "browser",
  ].includes(input.focusStep ?? "")
    ? input.focusStep
    : undefined;
  const activeStep =
    requestedStep ??
    essentialSteps.find(([, , ready]) => !ready)?.[0] ??
    "imessage";
  const journey = essentialSteps
    .map(
      ([id, label, ready], index) =>
        `<a href="/?step=${id}#${id}" class="journey-step ${ready ? "done" : activeStep === id ? "active" : ""}"><i aria-hidden="true">${ready ? "✓" : index + 1}</i><span><strong>${label}</strong><small>${ready ? "Ready" : activeStep === id ? "Next" : "Later"}</small></span></a>`,
    )
    .join("");
  const open = (id: string) => (activeStep === id ? " open" : "");
  const status = (ready: boolean, id: string, optional = false) =>
    ready
      ? '<span class="badge ready">Ready</span>'
      : optional
        ? '<span class="badge">Optional</span>'
        : activeStep === id
          ? '<span class="badge next">Do this next</span>'
          : '<span class="badge">Not finished</span>';
  const hidden = (step: string) =>
    `<input type="hidden" name="csrf" value="${escapeHtml(input.csrfToken)}"><input type="hidden" name="step" value="${step}">`;
  const selectedProviderFields: Partial<Record<string, readonly FieldName[]>> =
    {
      openai: ["OPENAI_API_KEY"],
      anthropic: ["ANTHROPIC_API_KEY"],
      google: ["GOOGLE_GENERATIVE_AI_API_KEY"],
      openrouter: ["OPENROUTER_API_KEY"],
      "vercel-gateway": ["AI_GATEWAY_API_KEY"],
      "openai-compatible": ["AI_COMPATIBLE_BASE_URL", "AI_COMPATIBLE_API_KEY"],
    };
  const allProviderFields = [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GOOGLE_GENERATIVE_AI_API_KEY",
    "OPENROUTER_API_KEY",
    "AI_GATEWAY_API_KEY",
    "AI_COMPATIBLE_BASE_URL",
    "AI_COMPATIBLE_API_KEY",
  ] as const;
  const primaryProviderFields =
    selectedProviderFields[input.values.AI_PROVIDER ?? ""] ?? [];
  const otherProviderFields = allProviderFields.filter(
    (name) => !primaryProviderFields.includes(name),
  );
  const canVerifyBlooio = configured.has("BLOOIO_API_KEY");
  const canRegisterBlooio =
    canVerifyBlooio &&
    hasPublicAppUrl(configured, input.values.NEXT_PUBLIC_APP_URL);
  const webhookReady = configured.has("BLOOIO_WEBHOOK_SECRET");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OpenInstinct setup</title><style>
  :root{color-scheme:dark;font-family:ui-sans-serif,system-ui,sans-serif;--bg:#09090b;--panel:#18181b;--panel-2:#111113;--text:#fafafa;--muted:#a1a1aa;--border:#3f3f46;--soft-border:#27272a;--accent:#a78bfa;--accent-soft:#18112b;--good:#22c55e;--good-bg:#166534;--danger:#fecaca;--danger-border:#991b1b;background:var(--bg);color:var(--text)}*{box-sizing:border-box}body{margin:0;background:var(--bg)}.shell{max-width:820px;margin:0 auto;padding:42px 20px 80px}.skip{position:absolute;left:12px;top:-60px;background:var(--text);color:var(--bg);padding:10px 14px;border-radius:8px;z-index:2}.skip:focus{top:12px}.eyebrow{color:var(--accent);font-weight:750;letter-spacing:.08em;text-transform:uppercase;font-size:.78rem}h1{font-size:clamp(2.25rem,7vw,4.5rem);letter-spacing:-.055em;line-height:.95;margin:10px 0 16px}h2{font-size:1.15rem;margin:0}h3{margin:12px 0}p{color:var(--muted);line-height:1.6}.intro{font-size:1.08rem;max-width:640px}.counter{display:inline-flex;border:1px solid var(--border);border-radius:999px;padding:7px 11px;color:var(--muted);font-size:.9rem;margin-top:6px}.notice{border:1px solid var(--border);background:var(--panel);border-radius:14px;padding:14px 16px;margin:22px 0}.success{border-color:var(--good-bg);color:#bbf7d0}.error{border-color:var(--danger-border);color:var(--danger)}.journey{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:28px 0}.journey-step{display:flex;align-items:center;gap:10px;color:var(--text);text-decoration:none;border:1px solid var(--soft-border);background:var(--panel-2);border-radius:14px;padding:12px}.journey-step i,.step-number{width:28px;height:28px;flex:0 0 28px;border-radius:50%;border:1px solid #52525b;display:grid;place-items:center;font-style:normal;font-size:.85rem}.journey-step span{display:flex;flex-direction:column}.journey-step small{color:var(--muted)}.journey-step.done i{background:var(--good-bg);border-color:var(--good)}.journey-step.active{border-color:var(--accent)}.card{scroll-margin-top:18px;margin:14px 0}.card>details{border:1px solid var(--border);background:var(--panel);border-radius:18px;overflow:hidden}.card>details[open]{border-color:#6d4bc3}.card summary{cursor:pointer;display:flex;align-items:center;gap:12px;padding:18px;list-style:none}.card summary::-webkit-details-marker{display:none}.card summary h2{flex:1}.card-body{border-top:1px solid var(--soft-border);padding:6px 18px 20px}.badge{font-size:.75rem;color:var(--muted);border:1px solid var(--border);border-radius:999px;padding:5px 8px;white-space:nowrap}.badge.ready{color:#bbf7d0;border-color:var(--good-bg)}.badge.next{color:#ddd6fe;border-color:#6d4bc3}.callout{border-left:3px solid var(--accent);background:var(--accent-soft);padding:10px 13px;border-radius:0 10px 10px 0;color:#ddd6fe}.how{color:#d4d4d8;line-height:1.65;padding-left:22px}.providers,.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:14px}.provider,.field{display:flex;flex-direction:column;gap:7px;background:var(--panel-2);border:1px solid var(--soft-border);border-radius:13px;padding:15px}.provider{color:var(--text);text-decoration:none}.provider span,.field small,.action small,.button-help{color:var(--muted);line-height:1.4}.provider b{color:#c4b5fd;margin-top:3px}.provider:hover{border-color:#7c3aed}.field>span{font-weight:680}.field.invalid{border-color:var(--danger-border)}.field-error{color:var(--danger)!important}input{font:inherit;color:var(--text);background:var(--bg);border:1px solid var(--border);border-radius:9px;padding:12px;min-width:0}button{border:0;border-radius:10px;padding:13px 18px;font:inherit;font-weight:750;background:var(--text);color:var(--bg);cursor:pointer}button.secondary{background:#6d28d9;color:#fff}button:disabled{cursor:not-allowed;opacity:.45}.save{margin-top:16px}.buttonrow{display:flex;gap:10px;flex-wrap:wrap;margin-top:8px}.button-help{display:block;margin:18px 0 7px}.action-zone{scroll-margin-top:18px}.subdetails,.technical{border:1px solid var(--soft-border);border-radius:12px;padding:12px 14px;margin:16px 0}.subdetails summary,.technical summary{cursor:pointer;font-weight:700}.extras{margin-top:32px}.extras>h2{margin-bottom:8px}.phase{margin:20px 0 30px}.action{display:flex;gap:12px;align-items:center;padding:13px;border:1px solid var(--soft-border);border-radius:12px;margin:8px 0;background:var(--panel-2)}.action i{width:24px;height:24px;border-radius:50%;border:1px solid #52525b;display:grid;place-items:center;font-style:normal}.action.complete i{background:var(--good-bg);border-color:var(--good)}.action span{display:flex;flex:1;flex-direction:column;gap:4px}.action>a,.advanced{color:#c4b5fd;padding:6px}.action.blocked{color:#8b8b93}.foot{font-size:.85rem;margin-top:24px;color:var(--muted)}a:focus-visible,button:focus-visible,summary:focus-visible,input:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
  @media(max-width:640px){.shell{padding-top:28px}.journey{grid-template-columns:1fr}.journey-step{padding:10px 12px}.grid,.providers{grid-template-columns:1fr}.buttonrow{flex-direction:column}.buttonrow form,.buttonrow button,.save{width:100%}.card summary{align-items:flex-start}.badge{margin-left:auto}}
  @media(prefers-color-scheme:light){:root{color-scheme:light;--bg:#fafafa;--panel:#fff;--panel-2:#f4f4f5;--text:#18181b;--muted:#52525b;--border:#d4d4d8;--soft-border:#e4e4e7;--accent:#6d28d9;--accent-soft:#f5f3ff;--danger:#991b1b;--danger-border:#dc2626}.success{color:#166534}.callout{color:#4c1d95}.how{color:#3f3f46}.provider b,.action>a,.advanced{color:#6d28d9}}
  </style></head><body><a class="skip" href="#steps">Skip to setup steps</a><main class="shell"><span class="eyebrow">OpenInstinct setup</span><h1>Set up your assistant</h1><p class="intro">Fill in what you have now. Blank fields keep their saved value, so you can stop and come back.</p><span class="counter">${completedSteps} of ${essentialSteps.length} essential steps ready</span>${notice}<nav class="journey" aria-label="Essential setup steps">${journey}</nav><div id="steps">
  <section class="card" id="owner" aria-labelledby="owner-title"><details${open("owner")}><summary><span class="step-number" aria-hidden="true">${ownerReady ? "✓" : "1"}</span><h2 id="owner-title">You</h2>${status(ownerReady, "owner")}</summary><div class="card-body"><p>Choose the one email address allowed to sign in to this assistant.</p><form method="post" action="/save#owner">${hidden("owner")}<div class="grid">${renderFields(["OWNER_EMAIL"])}</div><button class="save" type="submit">Save owner</button></form></div></details></section>
  <section class="card" id="core" aria-labelledby="core-title"><details${open("core")}><summary><span class="step-number" aria-hidden="true">${coreReady ? "✓" : "2"}</span><h2 id="core-title">Core services</h2>${status(coreReady, "core")}</summary><div class="card-body"><p>Connect the database, deployed app, and AI model that run your assistant. Scheduling is handled inside Supabase.</p><div class="providers">${renderLinks(infrastructureLinks)}</div><form method="post" action="/save#core">${hidden("core")}<div class="grid">${renderFields(["DATABASE_URL", "NEXT_PUBLIC_APP_URL", "AI_PROVIDER", "AI_MODEL", ...primaryProviderFields])}</div>${otherProviderFields.length ? `<details class="subdetails"><summary>${primaryProviderFields.length ? "Use a different AI provider" : "AI provider credentials"}</summary><p>Only add the key for the provider you chose. Deployed Vercel functions can use OIDC for AI Gateway.</p><div class="grid">${renderFields(otherProviderFields)}</div></details>` : ""}<button class="save" type="submit">Save core settings</button></form></div></details></section>
  <section class="card" id="imessage" aria-labelledby="imessage-title"><details${open("imessage")}><summary><span class="step-number" aria-hidden="true">${iMessageReady ? "✓" : "3"}</span><h2 id="imessage-title">iMessage (Blooio)</h2>${status(iMessageReady, "imessage")}</summary><div class="card-body"><p>Blooio gives your assistant a phone number so you can text it from iMessage. You manage verification, billing, and the assistant number in Blooio.</p><a class="provider" href="https://app.blooio.com" target="_blank" rel="noreferrer"><strong>Blooio</strong><span>Provision a number and create an API key</span><b>Open Blooio ↗</b></a><ol class="how"><li>In Blooio, finish verification and billing, then provision the assistant number.</li><li>Create an API key assigned to that number and paste it here.</li><li>Save, verify the key, then register the webhook.</li></ol><p class="callout"><strong>Which phone goes here?</strong><br>Enter your personal iPhone number—the one that will text the assistant. Do not enter the Blooio assistant number.</p><form id="imessage-settings" method="post" action="/save#imessage-settings">${hidden("imessage")}<div class="grid">${renderFields(["BLOOIO_API_KEY", "BLOOIO_OWNER_PHONE"])}</div><details class="subdetails"><summary>Advanced: pin a specific Blooio channel</summary><div class="grid">${renderFields(["BLOOIO_CHANNEL_ID"])}</div></details><button class="save" type="submit">Save iMessage settings</button></form><div class="action-zone" id="imessage-actions"><small class="button-help" id="verify-help">${canVerifyBlooio ? "Check that the saved key can access an active Blooio number." : "Save your Blooio API key first."}</small><div class="buttonrow"><form method="post" action="/verify-blooio#imessage-actions">${hidden("imessage")}<button class="secondary" type="submit" aria-describedby="verify-help" ${canVerifyBlooio ? "" : "disabled"}>Verify key</button></form><form method="post" action="/register-blooio-webhook#imessage-actions">${hidden("imessage")}<button type="submit" aria-describedby="webhook-help" ${canRegisterBlooio && !webhookReady ? "" : "disabled"}>${webhookReady ? "Webhook registered" : "Register webhook"}</button></form></div><small class="button-help" id="webhook-help">${!canVerifyBlooio ? "Save your API key before registering the webhook." : !canRegisterBlooio ? "Add the public app URL in Core services first." : webhookReady ? "The signing secret is stored locally and never shown." : "This creates the webhook in Blooio and stores its one-time signing secret."}</small></div></div></details></section>
  </div><section class="extras" aria-labelledby="extras-title"><h2 id="extras-title">Optional connections</h2><p>Add these whenever you are ready. They do not block iMessage.</p><section class="card" id="google" aria-labelledby="google-title"><details${open("google")}><summary><span class="step-number" aria-hidden="true">+</span><h2 id="google-title">Gmail + Calendar</h2>${status(
    ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI"].every(
      (name) => configured.has(name),
    ),
    "google",
    true,
  )}</summary><div class="card-body"><a class="provider" href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer"><strong>Google Cloud</strong><span>Create Gmail and Calendar OAuth credentials</span><b>Open Google Cloud ↗</b></a><form method="post" action="/save#google">${hidden("google")}<div class="grid">${renderFields(["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI"])}</div><button class="save" type="submit">Save Google settings</button></form></div></details></section><section class="card" id="browser" aria-labelledby="browser-title"><details${open("browser")}><summary><span class="step-number" aria-hidden="true">+</span><h2 id="browser-title">Cloud browser</h2>${status(configured.has("KERNEL_API_KEY"), "browser", true)}</summary><div class="card-body"><a class="provider" href="https://dashboard.onkernel.com" target="_blank" rel="noreferrer"><strong>Kernel</strong><span>Enable cloud browser tasks</span><b>Open Kernel ↗</b></a><form method="post" action="/save#browser">${hidden("browser")}<div class="grid">${renderFields(["KERNEL_API_KEY"])}</div><button class="save" type="submit">Save browser settings</button></form></div></details></section></section><details class="technical"><summary>Technical setup plan</summary><p>This is the detailed infrastructure runbook. Most people do not need it while entering credentials.</p>${actionPlanHtml}<details class="subdetails"><summary>Advanced deployment options</summary><p>The default uses Vercel Hobby and the Supabase scheduler. Choose <code>vercel-pro</code> for native Vercel cron or <code>vercel-cloudflare</code> for the legacy Cloudflare scheduler.</p><a class="advanced" href="https://dash.cloudflare.com/login" target="_blank" rel="noreferrer">Open Cloudflare ↗</a></details></details><p class="foot">Bound to 127.0.0.1 · no analytics · no external assets · values are written only to <code>.env.local</code> with owner-only permissions.</p></main></body></html>`;
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
): Promise<{
  values: Record<string, string>;
  errors: string[];
  fieldErrors: Partial<Record<FieldName, string>>;
}> {
  const values: Record<string, string> = {};
  const errors: string[] = [];
  const fieldErrors: Partial<Record<FieldName, string>> = {};
  for (const field of fields) {
    const raw = submitted.get(field.name)?.trim() ?? "";
    if (!raw) continue;
    const result = environmentFieldSchemas[field.name].safeParse(raw);
    if (!result.success) {
      const message =
        field.name === "BLOOIO_OWNER_PHONE"
          ? "Your phone number needs a country code. Use E.164, like +15551234567."
          : field.type === "url"
            ? `${field.label} must be a complete URL beginning with https://.`
            : field.type === "email"
              ? `${field.label} must be a complete email address, like you@example.com.`
              : `${field.label} is not in the expected format. Check the value and try again.`;
      errors.push(message);
      fieldErrors[field.name] = message;
    } else values[field.name] = result.data;
  }
  const merged = { ...current, ...values };
  const google = [
    merged.GOOGLE_CLIENT_ID,
    merged.GOOGLE_CLIENT_SECRET,
    merged.GOOGLE_REDIRECT_URI,
  ].filter(Boolean).length;
  if (google > 0 && google < 3) {
    const message =
      "Google OAuth requires the client ID, client secret, and redirect URL together.";
    errors.push(message);
    for (const name of [
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
      "GOOGLE_REDIRECT_URI",
    ] as const)
      if (!merged[name]) fieldErrors[name] = message;
  }
  return { values, errors, fieldErrors };
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
    feedback: {
      message?: string;
      errors?: string[];
      focusStep?: string;
      submitted?: URLSearchParams;
      fieldErrors?: Partial<Record<FieldName, string>>;
      actionError?: boolean;
    } = {},
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
    const sameOriginInAppBrowser =
      request.headers.origin === "null" &&
      request.headers["sec-fetch-site"] === "same-origin" &&
      request.headers.host === new URL(origin).host;
    if (request.headers.origin !== origin && !sameOriginInAppBrowser)
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
    let focusStep =
      request.url === "/verify-blooio" ||
      request.url === "/register-blooio-webhook"
        ? "imessage"
        : undefined;
    try {
      const requestUrl = new URL(request.url ?? "/", origin);
      if (request.method === "GET" && requestUrl.pathname === "/") {
        await renderPage(response, 200, {
          focusStep: requestUrl.searchParams.get("step") ?? undefined,
        });
        return;
      }
      if (request.method === "POST" && requestUrl.pathname === "/save") {
        const submitted = await readLocalPost(request);
        focusStep = submitted.get("step") ?? undefined;
        const current = await readCurrent();
        const result = await validateSetupWizardValues(submitted, current);
        if (result.errors.length) {
          await renderPage(response, 400, {
            errors: result.errors,
            fieldErrors: result.fieldErrors,
            submitted,
            focusStep,
          });
          return;
        }
        if (Object.keys(result.values).length)
          await setEnvValues(input.envPath, result.values);
        await renderPage(response, 200, {
          message: `Saved ${Object.keys(result.values).length} value${Object.keys(result.values).length === 1 ? "" : "s"}.`,
          focusStep,
        });
        return;
      }
      if (
        request.method === "POST" &&
        requestUrl.pathname === "/verify-blooio"
      ) {
        const submitted = await readLocalPost(request);
        focusStep = submitted.get("step") ?? "imessage";
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
          focusStep,
        });
        return;
      }
      if (
        request.method === "POST" &&
        requestUrl.pathname === "/register-blooio-webhook"
      ) {
        const submitted = await readLocalPost(request);
        focusStep = submitted.get("step") ?? "imessage";
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
          focusStep,
        });
        return;
      }
      response.writeHead(404, { "Cache-Control": "no-store" });
      response.end("Not found");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = message === "Invalid request origin." ? 403 : 400;
      await renderPage(response, status, {
        errors: [
          message === "Invalid request origin."
            ? "This request did not come from this local setup tab. Refresh the page and try again."
            : message,
        ],
        focusStep,
        actionError: request.url !== "/save",
      });
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

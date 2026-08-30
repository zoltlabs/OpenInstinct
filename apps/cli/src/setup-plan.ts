import type { DeploymentTarget } from "@openinstinct/runtime";

export type SetupActionStatus = "complete" | "available" | "blocked";

export interface SetupAction {
  readonly id: string;
  readonly phase: "infrastructure" | "deployment" | "imessage" | "verify";
  readonly title: string;
  readonly description?: string;
  readonly command?: string;
  readonly browserUrl?: string;
  readonly preferredTool?: string;
  readonly fallbackTool?: string;
  readonly mutatesExternalState: boolean;
  readonly confirmation?: string;
  readonly secretInput?: string;
  readonly requires?: readonly string[];
  readonly completeWhen?: readonly string[];
  readonly status: SetupActionStatus;
}

function hasAll(
  values: Record<string, string | undefined>,
  names: readonly string[] | undefined,
): boolean {
  if (!names?.length) return false;
  return names.every((name) => Boolean(values[name]));
}

function action(
  values: Record<string, string | undefined>,
  input: Omit<SetupAction, "status">,
): SetupAction {
  const complete = hasAll(values, input.completeWhen);
  const blocked =
    !complete &&
    Boolean(input.requires?.some((name) => !Boolean(values[name])));
  return {
    ...input,
    status: complete ? "complete" : blocked ? "blocked" : "available",
  };
}

export function setupActions(
  target: DeploymentTarget,
  values: Record<string, string | undefined> = {},
): SetupAction[] {
  const vercel = ["vercel", "vercel-pro", "vercel-cloudflare"].includes(target);
  const actions: SetupAction[] = [
    action(values, {
      id: "provision-supabase",
      phase: "infrastructure",
      title: "Create or select Supabase",
      description:
        "Use an authorized account-scoped Supabase integration when available. Open the dashboard only when the integration or CLI cannot complete the step.",
      browserUrl: "https://supabase.com/dashboard/new",
      preferredTool: "supabase-mcp",
      fallbackTool: "computer-use",
      mutatesExternalState: true,
      confirmation: "required-before-project-or-credential-creation",
      completeWhen: ["NEXT_PUBLIC_SUPABASE_URL"],
    }),
    action(values, {
      id: "capture-supabase",
      phase: "infrastructure",
      title: "Link the Supabase project",
      command:
        "pnpm run openinstinct -- configure-supabase --project-ref <project-ref> --use-env-database-url",
      mutatesExternalState: false,
      secretInput: "hidden prompt or stdin",
      completeWhen: [
        "DATABASE_URL",
        "NEXT_PUBLIC_SUPABASE_URL",
        "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
        "SUPABASE_SECRET_KEY",
      ],
    }),
    action(values, {
      id: "push-schema",
      phase: "infrastructure",
      title: "Apply the database schema",
      command: "pnpm exec supabase db push --linked",
      mutatesExternalState: true,
      requires: ["DATABASE_URL", "NEXT_PUBLIC_SUPABASE_URL"],
    }),
  ];

  if (vercel) {
    actions.push(
      action(values, {
        id: "link-vercel",
        phase: "deployment",
        title: "Create or link Vercel",
        command: "vercel link",
        browserUrl:
          "https://vercel.com/new/import?s=https%3A%2F%2Fgithub.com%2Fzoltlabs%2FOpenInstinct",
        preferredTool: "vercel-mcp",
        fallbackTool: "vercel-cli",
        mutatesExternalState: true,
        confirmation: "required-before-project-creation-if-missing",
      }),
      action(values, {
        id: "capture-app-url",
        phase: "deployment",
        title: "Capture the production URL",
        description:
          "Read the default domain assigned to the Vercel project and store its HTTPS origin.",
        command: "pnpm run openinstinct -- set-app-url --url <production-url>",
        preferredTool: "vercel-mcp",
        fallbackTool: "vercel-cli",
        mutatesExternalState: false,
        completeWhen: ["NEXT_PUBLIC_APP_URL"],
      }),
      action(values, {
        id: "configure-supabase-auth",
        phase: "deployment",
        title: "Configure Supabase Auth",
        description:
          "Set the Site URL to NEXT_PUBLIC_APP_URL and allow NEXT_PUBLIC_APP_URL/api/auth/callback.",
        browserUrl:
          "https://supabase.com/dashboard/project/_/auth/url-configuration",
        preferredTool: "supabase-mcp",
        fallbackTool: "computer-use",
        mutatesExternalState: true,
        confirmation: "required-before-production-auth-change",
        requires: ["NEXT_PUBLIC_APP_URL", "NEXT_PUBLIC_SUPABASE_URL"],
      }),
      action(values, {
        id: "verify-bootstrap",
        phase: "deployment",
        title: "Verify bootstrap configuration",
        command: `pnpm run doctor -- --target ${target} --phase bootstrap --json`,
        mutatesExternalState: false,
      }),
      action(values, {
        id: "sync-final-environment",
        phase: "deployment",
        title: "Store the production environment",
        command:
          "pnpm run openinstinct -- push-vercel-env --environment production",
        mutatesExternalState: true,
        secretInput: "read from .env.local and sent over stdin",
        confirmation: "required-before-credential-storage",
        requires: [
          "DATABASE_URL",
          "NEXT_PUBLIC_APP_URL",
          "NEXT_PUBLIC_SUPABASE_URL",
        ],
      }),
      action(values, {
        id: "deploy-final",
        phase: "deployment",
        title: "Deploy OpenInstinct",
        command:
          target === "vercel-pro"
            ? "vercel deploy --prod --local-config vercel.pro.json"
            : "vercel deploy --prod",
        preferredTool: "vercel-mcp",
        fallbackTool: "vercel-cli",
        mutatesExternalState: true,
        confirmation: "required-before-public-deployment",
        requires: ["NEXT_PUBLIC_APP_URL", "NEXT_PUBLIC_SUPABASE_URL"],
      }),
    );
  }

  if (target === "vercel")
    actions.push(
      action(values, {
        id: "configure-scheduler",
        phase: "deployment",
        title: "Configure the scheduler",
        command: "pnpm run openinstinct -- configure-supabase-scheduler --json",
        mutatesExternalState: true,
        secretInput: "read from .env.local and stored in Supabase Vault",
        requires: ["DATABASE_URL", "NEXT_PUBLIC_APP_URL"],
      }),
    );

  if (target === "vercel-cloudflare")
    actions.push(
      action(values, {
        id: "deploy-scheduler",
        phase: "deployment",
        title: "Deploy the Cloudflare scheduler",
        command: "pnpm --dir infra/cloudflare-scheduler deploy",
        browserUrl: "https://dash.cloudflare.com/login",
        mutatesExternalState: true,
        requires: ["NEXT_PUBLIC_APP_URL"],
      }),
    );

  actions.push(
    action(values, {
      id: "setup-blooio-account",
      phase: "imessage",
      title: "Set up Blooio",
      description:
        "The owner creates the Blooio account, completes any KYC and billing, provisions a number, and creates an API key assigned to that number.",
      browserUrl: "https://app.blooio.com",
      preferredTool: "user",
      fallbackTool: "computer-use",
      mutatesExternalState: true,
      confirmation: "performed-by-user-in-blooio",
      completeWhen: ["BLOOIO_API_KEY"],
    }),
    action(values, {
      id: "verify-blooio",
      phase: "imessage",
      title: "Verify Blooio access",
      description:
        "Read the active Blooio channels and capture the channel automatically when exactly one is available.",
      command:
        "pnpm run openinstinct -- configure-blooio --use-env-api-key --json",
      mutatesExternalState: false,
      requires: ["BLOOIO_API_KEY"],
      completeWhen: ["BLOOIO_API_KEY", "BLOOIO_CHANNEL_ID"],
    }),
    action(values, {
      id: "register-blooio-webhook",
      phase: "imessage",
      title: "Register the production webhook",
      command:
        "pnpm run openinstinct -- create-blooio-webhook --url <production-url> --env-file .env.local",
      mutatesExternalState: true,
      confirmation: "required-before-webhook-registration",
      requires: ["BLOOIO_API_KEY", "NEXT_PUBLIC_APP_URL"],
      completeWhen: ["BLOOIO_WEBHOOK_SECRET"],
    }),
    action(values, {
      id: "verify-ready",
      phase: "verify",
      title: "Verify the ready deployment",
      command: `pnpm run doctor -- --target ${target} --phase ready --json`,
      mutatesExternalState: false,
      requires: [
        "BLOOIO_API_KEY",
        "BLOOIO_OWNER_PHONE",
        "BLOOIO_WEBHOOK_SECRET",
        "NEXT_PUBLIC_APP_URL",
      ],
      completeWhen: [
        "BLOOIO_API_KEY",
        "BLOOIO_OWNER_PHONE",
        "BLOOIO_WEBHOOK_SECRET",
        "NEXT_PUBLIC_APP_URL",
      ],
    }),
  );

  return actions;
}

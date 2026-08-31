#!/usr/bin/env node
import { copyFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { Command } from "commander";
import { z } from "zod";
import { configureSupabaseScheduler } from "@openinstinct/db";
import {
  deploymentTargetSchema,
  environmentFieldSchemas,
  requiredCli,
  runCommand,
  type DeploymentTarget,
} from "@openinstinct/runtime";
import {
  envFileValues,
  pathExists as exists,
  setEnvValue,
  setEnvValues,
} from "./env-file";
import { startSetupUi } from "./setup-ui";
import { setupActions } from "./setup-plan";
import { configureBlooio, ensureBlooioWebhook } from "./blooio-setup";
import {
  createAssistantModel,
  previewAssistantMessage,
  type ModelEnvironment,
} from "@openinstinct/worker";

export { envFileValues } from "./env-file";
export { isPublicDeploymentUrl, setupActions } from "./setup-plan";

export type Check = { name: string; ok: boolean; detail: string };
const setupPhaseSchema = z.enum(["bootstrap", "ready"]);
type SetupPhase = z.infer<typeof setupPhaseSchema>;

export function normalizePublicAppUrl(input: string): string {
  const parsedUrl = environmentFieldSchemas.NEXT_PUBLIC_APP_URL.parse(input);
  const value = new URL(parsedUrl);
  if (
    value.protocol !== "https:" ||
    ["localhost", "127.0.0.1", "::1"].includes(value.hostname)
  )
    throw new Error("The final application URL must be public HTTPS.");
  return value.origin;
}

function emit(value: unknown, json: boolean): void {
  process.stdout.write(
    `${json ? JSON.stringify(value, null, 2) : String(value)}\n`,
  );
}

async function commandAvailable(
  command: string,
  root: string,
): Promise<boolean> {
  const result =
    command === "wrangler"
      ? await runCommand(
          "pnpm",
          [
            "--dir",
            "infra/cloudflare-scheduler",
            "exec",
            "wrangler",
            "--version",
          ],
          { cwd: root },
        )
      : await runCommand(command, ["--version"], { cwd: root });
  return result.code === 0;
}

async function readSecretInput(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    let value = "";
    for await (const chunk of process.stdin) value += String(chunk);
    return value.trim();
  }
  process.stdout.write(prompt);
  return new Promise((resolveSecret, rejectSecret) => {
    let value = "";
    const finish = (error?: Error) => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
      if (error) rejectSecret(error);
      else resolveSecret(value);
    };
    const onData = (chunk: Buffer) => {
      for (const byte of chunk) {
        if (byte === 3) return finish(new Error("Input cancelled."));
        if (byte === 10 || byte === 13) return finish();
        if (byte === 8 || byte === 127) value = value.slice(0, -1);
        else value += String.fromCharCode(byte);
      }
    };
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

async function readMessageInput(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    let value = "";
    for await (const chunk of process.stdin) value += String(chunk);
    return value.trim();
  }
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    return (await readline.question(prompt)).trim();
  } finally {
    readline.close();
  }
}

function previewModelEnvironment(
  values: Record<string, string | undefined>,
): ModelEnvironment {
  const provider = environmentFieldSchemas.AI_PROVIDER.parse(
    values.AI_PROVIDER,
  );
  const model = environmentFieldSchemas.AI_MODEL.parse(values.AI_MODEL);
  const appUrl = environmentFieldSchemas.NEXT_PUBLIC_APP_URL.parse(
    values.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
  );
  const fallbackProvider = values.AI_FALLBACK_PROVIDER
    ? environmentFieldSchemas.AI_FALLBACK_PROVIDER.parse(
        values.AI_FALLBACK_PROVIDER,
      )
    : undefined;
  const fallbackModel = values.AI_FALLBACK_MODEL
    ? environmentFieldSchemas.AI_FALLBACK_MODEL.parse(values.AI_FALLBACK_MODEL)
    : undefined;
  if (Boolean(fallbackProvider) !== Boolean(fallbackModel))
    throw new Error(
      "AI_FALLBACK_PROVIDER and AI_FALLBACK_MODEL must be configured together.",
    );
  if (provider === "vercel-gateway" && !values.AI_GATEWAY_API_KEY)
    throw new Error(
      "The local preview needs AI_GATEWAY_API_KEY. Vercel OIDC is only available after deployment, or select a direct provider locally.",
    );
  return {
    NEXT_PUBLIC_APP_URL: appUrl,
    AI_PROVIDER: provider,
    AI_MODEL: model,
    ...(fallbackProvider ? { AI_FALLBACK_PROVIDER: fallbackProvider } : {}),
    ...(fallbackModel ? { AI_FALLBACK_MODEL: fallbackModel } : {}),
    ...(values.AI_GATEWAY_API_KEY
      ? { AI_GATEWAY_API_KEY: values.AI_GATEWAY_API_KEY }
      : {}),
    ...(values.OPENAI_API_KEY ? { OPENAI_API_KEY: values.OPENAI_API_KEY } : {}),
    ...(values.ANTHROPIC_API_KEY
      ? { ANTHROPIC_API_KEY: values.ANTHROPIC_API_KEY }
      : {}),
    ...(values.GOOGLE_GENERATIVE_AI_API_KEY
      ? { GOOGLE_GENERATIVE_AI_API_KEY: values.GOOGLE_GENERATIVE_AI_API_KEY }
      : {}),
    ...(values.OPENROUTER_API_KEY
      ? { OPENROUTER_API_KEY: values.OPENROUTER_API_KEY }
      : {}),
    ...(values.AI_COMPATIBLE_BASE_URL
      ? {
          AI_COMPATIBLE_BASE_URL:
            environmentFieldSchemas.AI_COMPATIBLE_BASE_URL.parse(
              values.AI_COMPATIBLE_BASE_URL,
            ),
        }
      : {}),
    ...(values.AI_COMPATIBLE_API_KEY
      ? { AI_COMPATIBLE_API_KEY: values.AI_COMPATIBLE_API_KEY }
      : {}),
  };
}

async function openBrowser(url: string, root: string): Promise<boolean> {
  const command =
    process.platform === "darwin"
      ? { name: "open", args: [url] }
      : process.platform === "win32"
        ? { name: "cmd", args: ["/c", "start", "", url] }
        : { name: "xdg-open", args: [url] };
  const result = await runCommand(command.name, command.args, { cwd: root });
  return result.code === 0;
}

export function parseSupabaseApiKeys(value: unknown): {
  publishableKey: string;
  secretKey: string;
} {
  const candidate =
    value && typeof value === "object" && !Array.isArray(value)
      ? ((value as Record<string, unknown>).api_keys ??
        (value as Record<string, unknown>).keys ??
        (value as Record<string, unknown>).data)
      : value;
  if (!Array.isArray(candidate))
    throw new Error("Unexpected Supabase key response.");
  const keys = candidate.filter(
    (item): item is Record<string, unknown> =>
      Boolean(item) && typeof item === "object" && !Array.isArray(item),
  );
  const keyValue = (item: Record<string, unknown> | undefined) => {
    const value = item?.api_key ?? item?.apiKey ?? item?.key;
    return typeof value === "string" && value ? value : undefined;
  };
  const publishable = keys.find(
    (item) =>
      item.type === "publishable" ||
      item.name === "publishable" ||
      item.name === "anon",
  );
  const secret = keys.find(
    (item) =>
      item.type === "secret" ||
      item.name === "secret" ||
      item.name === "service_role",
  );
  const publishableKey = keyValue(publishable);
  const secretKey = keyValue(secret);
  if (!publishableKey || !secretKey)
    throw new Error(
      "Supabase did not return both publishable and secret keys.",
    );
  return { publishableKey, secretKey };
}

const commonEnvironmentNames = [
  "NEXT_PUBLIC_APP_URL",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SECRET_KEY",
  "DATABASE_URL",
  "SECRET_ENCRYPTION_KEY",
  "OWNER_EMAIL",
  "AI_PROVIDER",
  "AI_MODEL",
  "INTERNAL_API_SECRET",
] as const;

const deployableEnvironmentNames = [
  "NEXT_PUBLIC_APP_URL",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_URL",
  "SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SECRET_KEY",
  "DATABASE_URL",
  "SECRET_ENCRYPTION_KEY",
  "BLOOIO_API_KEY",
  "BLOOIO_WEBHOOK_SECRET",
  "BLOOIO_CHANNEL_ID",
  "BLOOIO_OWNER_PHONE",
  "OWNER_EMAIL",
  "AI_PROVIDER",
  "AI_GATEWAY_API_KEY",
  "AI_MODEL",
  "AI_FALLBACK_PROVIDER",
  "AI_FALLBACK_MODEL",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "OPENROUTER_API_KEY",
  "AI_COMPATIBLE_BASE_URL",
  "AI_COMPATIBLE_API_KEY",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REDIRECT_URI",
  "KERNEL_API_KEY",
  "INTERNAL_API_SECRET",
  "CRON_SECRET",
  "WORKER_URL",
  "WORKER_MODE",
  "WORKER_POLL_INTERVAL_MS",
  "INTERACTIVE_MAX_QUEUE_LATENCY_MS",
] as const;

function addProviderEnvironmentNames(
  names: Array<keyof typeof environmentFieldSchemas>,
  provider: string | undefined,
  target: DeploymentTarget,
): void {
  const parsed = environmentFieldSchemas.AI_PROVIDER.safeParse(provider);
  if (!parsed.success) return;
  switch (parsed.data) {
    case "openai":
      names.push("OPENAI_API_KEY");
      break;
    case "anthropic":
      names.push("ANTHROPIC_API_KEY");
      break;
    case "google":
      names.push("GOOGLE_GENERATIVE_AI_API_KEY");
      break;
    case "openrouter":
      names.push("OPENROUTER_API_KEY");
      break;
    case "vercel-gateway":
      if (!["vercel", "vercel-pro", "vercel-cloudflare"].includes(target))
        names.push("AI_GATEWAY_API_KEY");
      break;
    case "openai-compatible":
      names.push("AI_COMPATIBLE_BASE_URL");
      break;
  }
}

export function checkEnvironment(input: {
  values: Record<string, string | undefined>;
  target: DeploymentTarget;
  phase: SetupPhase;
}): Check[] {
  const names: Array<keyof typeof environmentFieldSchemas> = [
    ...commonEnvironmentNames,
  ];
  if (input.phase === "ready")
    names.push("BLOOIO_API_KEY", "BLOOIO_OWNER_PHONE", "BLOOIO_WEBHOOK_SECRET");
  if (input.target === "vercel-pro") names.push("CRON_SECRET");
  addProviderEnvironmentNames(names, input.values.AI_PROVIDER, input.target);
  if (input.values.AI_FALLBACK_PROVIDER || input.values.AI_FALLBACK_MODEL) {
    names.push("AI_FALLBACK_PROVIDER", "AI_FALLBACK_MODEL");
    addProviderEnvironmentNames(
      names,
      input.values.AI_FALLBACK_PROVIDER,
      input.target,
    );
  }

  const checks = [...new Set(names)].map((name) => {
    const value = input.values[name];
    if (!value) return { name: `env:${name}`, ok: false, detail: "missing" };
    const result = environmentFieldSchemas[name].safeParse(value);
    return {
      name: `env:${name}`,
      ok: result.success,
      detail: result.success ? "valid" : "invalid",
    };
  });

  if (
    input.values.AI_FALLBACK_PROVIDER === input.values.AI_PROVIDER &&
    input.values.AI_FALLBACK_MODEL === input.values.AI_MODEL
  )
    checks.push({
      name: "env:ai-fallback",
      ok: false,
      detail: "fallback must differ from the primary model",
    });

  if (input.target !== "docker") {
    const deploymentUrlNames = [
      "NEXT_PUBLIC_SUPABASE_URL",
      ...(input.phase === "ready" ? (["NEXT_PUBLIC_APP_URL"] as const) : []),
    ] as const;
    for (const name of deploymentUrlNames) {
      const value = input.values[name];
      if (!value) continue;
      let isPublicHttps = false;
      try {
        const url = new URL(value);
        isPublicHttps =
          url.protocol === "https:" &&
          !["localhost", "127.0.0.1", "::1"].includes(url.hostname);
      } catch {
        // The field-level check reports the malformed URL.
      }
      checks.push({
        name: `env:${name}:deployment`,
        ok: isPublicHttps,
        detail: isPublicHttps
          ? "public HTTPS URL"
          : "must be a public HTTPS URL for this target",
      });
    }
  }

  const googleNames = [
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "GOOGLE_REDIRECT_URI",
  ] as const;
  const configuredGoogle = googleNames.filter((name) => input.values[name]);
  if (configuredGoogle.length > 0) {
    checks.push({
      name: "env:google-oauth",
      ok: configuredGoogle.length === googleNames.length,
      detail:
        configuredGoogle.length === googleNames.length
          ? "complete"
          : "set all three Google OAuth variables or none",
    });
  }
  const kernelConfigured = Boolean(input.values.KERNEL_API_KEY);
  checks.push({
    name: "browser:provider-config",
    ok:
      !kernelConfigured ||
      environmentFieldSchemas.KERNEL_API_KEY.safeParse(
        input.values.KERNEL_API_KEY,
      ).success,
    detail: kernelConfigured ? "configured" : "optional; disabled",
  });
  checks.push({
    name: "browser:capabilities",
    ok: true,
    detail: kernelConfigured
      ? "profiles,reconnect,observation,screenshot,files,takeover,replay"
      : "not checked while provider is disabled",
  });
  const workerMode = input.values.WORKER_MODE ?? "scheduled";
  const pollInterval = Number(input.values.WORKER_POLL_INTERVAL_MS ?? 1_000);
  const maxInteractiveLatency = Number(
    input.values.INTERACTIVE_MAX_QUEUE_LATENCY_MS ?? 10_000,
  );
  checks.push({
    name: "browser:queue-latency",
    ok:
      !kernelConfigured ||
      (workerMode === "continuous" &&
        Number.isFinite(pollInterval) &&
        pollInterval <= maxInteractiveLatency),
    detail: !kernelConfigured
      ? "not required while browser provider is disabled"
      : workerMode === "continuous"
        ? `continuous poll ${pollInterval}ms; interactive budget ${maxInteractiveLatency}ms`
        : "scheduled consumption cannot satisfy interactive browser latency; use WORKER_MODE=continuous",
  });
  return checks;
}

export async function doctor(
  root: string,
  target: DeploymentTarget,
  phase: SetupPhase = "bootstrap",
  envFile = ".env.local",
): Promise<Check[]> {
  const checks: Check[] = [];
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  checks.push({ name: "node", ok: major >= 22, detail: process.versions.node });
  for (const command of requiredCli(target)) {
    const ok = await commandAvailable(command, root).catch(() => false);
    checks.push({
      name: `cli:${command}`,
      ok,
      detail: ok ? "installed" : "not found",
    });
  }
  const envPath = resolve(root, envFile);
  const hasEnv = await exists(envPath);
  checks.push({ name: "env-file", ok: hasEnv, detail: envPath });
  if (hasEnv) {
    const values = {
      ...envFileValues(await readFile(envPath, "utf8")),
      ...Object.fromEntries(
        Object.entries(process.env).filter((entry): entry is [string, string] =>
          Boolean(entry[1]),
        ),
      ),
    };
    checks.push(...checkEnvironment({ values, target, phase }));
  }
  return checks;
}

const program = new Command()
  .name("openinstinct")
  .description("Agent-friendly OpenInstinct setup and operations CLI")
  .option("--json", "emit machine-readable JSON", false)
  .option("--root <path>", "repository root", process.cwd());

program
  .command("setup")
  .description("prepare local configuration and report remaining actions")
  .option(
    "--target <target>",
    "vercel|vercel-pro|vercel-cloudflare|aws|gcp|docker",
    "vercel",
  )
  .option("--database <database>", "hosted|local", "hosted")
  .option("--env-file <path>", "environment file", ".env.local")
  .action(
    async ({
      target,
      database,
      envFile,
    }: {
      target: string;
      database: string;
      envFile: string;
    }) => {
      const options = program.opts<{ json: boolean; root: string }>();
      const root = resolve(options.root);
      const envPath = resolve(root, envFile);
      const parsedTarget = deploymentTargetSchema.parse(target);
      const createdEnv = !(await exists(envPath));
      if (createdEnv) await copyFile(resolve(root, ".env.example"), envPath);
      const generatedValues = envFileValues(await readFile(envPath, "utf8"));
      if (!generatedValues.SECRET_ENCRYPTION_KEY) {
        await setEnvValue(
          envPath,
          "SECRET_ENCRYPTION_KEY",
          randomBytes(32).toString("base64"),
        );
      }
      if (!generatedValues.INTERNAL_API_SECRET) {
        await setEnvValue(
          envPath,
          "INTERNAL_API_SECRET",
          randomBytes(32).toString("base64url"),
        );
      }
      if (parsedTarget === "vercel-pro" && !generatedValues.CRON_SECRET) {
        await setEnvValue(
          envPath,
          "CRON_SECRET",
          randomBytes(32).toString("base64url"),
        );
      }
      if (
        ["vercel", "vercel-pro", "vercel-cloudflare"].includes(parsedTarget) &&
        (!generatedValues.AI_PROVIDER ||
          generatedValues.AI_PROVIDER === "openai") &&
        !generatedValues.OPENAI_API_KEY
      ) {
        await setEnvValues(envPath, {
          AI_PROVIDER: "vercel-gateway",
          AI_MODEL: "openai/gpt-5.6-sol",
        });
      }
      if (
        !generatedValues.GOOGLE_CLIENT_ID &&
        !generatedValues.GOOGLE_CLIENT_SECRET &&
        generatedValues.GOOGLE_REDIRECT_URI ===
          "http://localhost:3000/api/connectors/google/callback"
      ) {
        await setEnvValue(envPath, "GOOGLE_REDIRECT_URI", "");
      }
      const parsedDatabase = z.enum(["hosted", "local"]).parse(database);
      const bootstrapChecks = await doctor(
        root,
        parsedTarget,
        "bootstrap",
        envFile,
      );
      const readyChecks = await doctor(root, parsedTarget, "ready", envFile);
      const next =
        parsedDatabase === "local"
          ? [
              "Run: pnpm supabase:start && pnpm supabase:reset",
              "Fill the local Supabase values in .env.local",
              "Run: pnpm dev",
              "Run: pnpm run smoke -- --url http://localhost:3000",
            ]
          : [
              "Use the connected Supabase integration to create or select a project.",
              "Run: pnpm run openinstinct -- setup-ui. Save OWNER_EMAIL and DATABASE_URL, then stop the loopback form.",
              "Capture the Supabase connection with: pnpm run openinstinct -- configure-supabase --project-ref <project-ref> --use-env-database-url.",
              "Run: pnpm exec supabase db push --linked",
              ...(["vercel", "vercel-pro", "vercel-cloudflare"].includes(
                parsedTarget,
              )
                ? [
                    "Run: vercel link",
                    "Read the Vercel project's assigned production domain and store it with: pnpm run openinstinct -- set-app-url --url <production-url>",
                    "Use the Supabase integration to set Auth Site URL to NEXT_PUBLIC_APP_URL and allow NEXT_PUBLIC_APP_URL/api/auth/callback.",
                    `Run: pnpm --silent run doctor -- --target ${parsedTarget} --phase bootstrap --json`,
                    "Run: pnpm run openinstinct -- push-vercel-env --environment production",
                    parsedTarget === "vercel-pro"
                      ? "Run: vercel deploy --prod --local-config vercel.pro.json"
                      : "Run: vercel deploy --prod",
                    ...(parsedTarget === "vercel"
                      ? [
                          "Run: pnpm --silent run openinstinct -- configure-supabase-scheduler --json",
                        ]
                      : []),
                  ]
                : [
                    `Run: pnpm --silent run doctor -- --target ${parsedTarget} --phase bootstrap --json`,
                  ]),
            ];
      const resolvedValues = envFileValues(await readFile(envPath, "utf8"));
      const bootstrapReady = bootstrapChecks.every((check) => check.ok);
      const ready = readyChecks.every((check) => check.ok);
      const result = {
        ok: true,
        ready,
        bootstrapReady,
        milestone: ready ? "ready" : bootstrapReady ? "bootstrap" : "local",
        target: parsedTarget,
        database: parsedDatabase,
        envFile: envPath,
        checks: bootstrapChecks,
        readyChecks,
        next,
        actions:
          parsedDatabase === "hosted"
            ? setupActions(parsedTarget, resolvedValues)
            : [],
      };
      emit(options.json ? result : result.next.join("\n"), options.json);
    },
  );

program
  .command("set-app-url")
  .description("store the final public application URL before deployment")
  .requiredOption("--url <url>", "final public HTTPS application URL")
  .option("--env-file <path>", "secure env file to update", ".env.local")
  .action(async ({ url, envFile }: { url: string; envFile: string }) => {
    const options = program.opts<{ json: boolean; root: string }>();
    const appUrl = normalizePublicAppUrl(url);
    const envPath = resolve(options.root, envFile);
    await setEnvValue(envPath, "NEXT_PUBLIC_APP_URL", appUrl);
    emit(
      options.json
        ? { ok: true, appUrl, envFile: envPath }
        : `Stored ${appUrl} as the final application URL.`,
      options.json,
    );
  });

program
  .command("setup-ui")
  .description("open a loopback-only browser form for private setup values")
  .option("--env-file <path>", "secure env file to update", ".env.local")
  .option("--port <port>", "loopback port", "4173")
  .option("--no-open", "print the local URL without opening a browser")
  .action(
    async ({
      envFile,
      port,
      open,
    }: {
      envFile: string;
      port: string;
      open: boolean;
    }) => {
      const options = program.opts<{ json: boolean; root: string }>();
      const parsedPort = z.coerce
        .number()
        .int()
        .min(1024)
        .max(65535)
        .parse(port);
      const envPath = resolve(options.root, envFile);
      const setupUi = await startSetupUi({ envPath, port: parsedPort });
      const opened =
        open && !options.json
          ? await openBrowser(setupUi.url, options.root).catch(() => false)
          : false;
      emit(
        options.json
          ? { ok: true, url: setupUi.url, envFile: envPath }
          : `${opened ? "Opened" : "Open"} ${setupUi.url} to continue setup locally. Press Ctrl-C when finished.`,
        options.json,
      );
    },
  );

program
  .command("doctor")
  .description("check prerequisites without changing external services")
  .option(
    "--target <target>",
    "vercel|vercel-pro|vercel-cloudflare|aws|gcp|docker",
    "vercel",
  )
  .option("--phase <phase>", "bootstrap|ready", "bootstrap")
  .option("--env-file <path>", "environment file", ".env.local")
  .action(
    async ({
      target,
      phase,
      envFile,
    }: {
      target: string;
      phase: string;
      envFile: string;
    }) => {
      const options = program.opts<{ json: boolean; root: string }>();
      const checks = await doctor(
        resolve(options.root),
        deploymentTargetSchema.parse(target),
        setupPhaseSchema.parse(phase),
        envFile,
      );
      emit(
        options.json
          ? checks
          : checks
              .map((c) => `${c.ok ? "PASS" : "FAIL"} ${c.name}: ${c.detail}`)
              .join("\n"),
        options.json,
      );
      if (checks.some((check) => !check.ok)) process.exitCode = 2;
    },
  );

program
  .command("smoke")
  .description("check the deployed health endpoints")
  .option("--url <url>", "application URL")
  .option("--worker-url <url>", "worker URL")
  .option("--env-file <path>", "environment file", ".env.local")
  .action(
    async ({
      url,
      workerUrl,
      envFile,
    }: {
      url?: string;
      workerUrl?: string;
      envFile: string;
    }) => {
      const options = program.opts<{ json: boolean; root: string }>();
      const envPath = resolve(options.root, envFile);
      const values = (await exists(envPath))
        ? envFileValues(await readFile(envPath, "utf8"))
        : {};
      url ??= process.env.NEXT_PUBLIC_APP_URL ?? values.NEXT_PUBLIC_APP_URL;
      workerUrl ??= process.env.WORKER_URL ?? values.WORKER_URL;
      if (!url) throw new Error("Pass --url or set NEXT_PUBLIC_APP_URL.");
      const targets = [new URL("/api/health", url).toString()];
      if (workerUrl) targets.push(new URL("/health", workerUrl).toString());
      const results = await Promise.all(
        targets.map(async (target) => {
          try {
            const response = await fetch(target, {
              signal: AbortSignal.timeout(10_000),
            });
            return { target, ok: response.ok, status: response.status };
          } catch (error) {
            return {
              target,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        }),
      );
      emit(
        options.json
          ? results
          : results
              .map((r) => `${r.ok ? "PASS" : "FAIL"} ${r.target}`)
              .join("\n"),
        options.json,
      );
      if (results.some((result) => !result.ok)) process.exitCode = 3;
    },
  );

program
  .command("try-message")
  .description(
    "preview one assistant response locally without Supabase, Blooio, connectors, or side effects",
  )
  .option(
    "--message <message>",
    "message to preview; omit to use stdin or a prompt",
  )
  .option("--env-file <path>", "environment file", ".env.local")
  .action(
    async ({ message, envFile }: { message?: string; envFile: string }) => {
      const options = program.opts<{ json: boolean; root: string }>();
      const envPath = resolve(options.root, envFile);
      const fileValues = (await exists(envPath))
        ? envFileValues(await readFile(envPath, "utf8"))
        : {};
      const values = {
        ...fileValues,
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            (entry): entry is [string, string] => Boolean(entry[1]),
          ),
        ),
      };
      const previewMessage =
        message?.trim() || (await readMessageInput("Message: "));
      if (!previewMessage) throw new Error("A preview message is required.");
      const selection = createAssistantModel(previewModelEnvironment(values));
      const text = await previewAssistantMessage({
        model: selection.model,
        message: previewMessage,
      });
      emit(
        options.json
          ? {
              ok: true,
              mode: "model-only-preview",
              model: selection.configuredId,
              text,
              sideEffects: false,
            }
          : `${text}\n\nPreview only — no database, connectors, approvals, or external actions were used.`,
        options.json,
      );
    },
  );

program
  .command("push-vercel-env")
  .description(
    "send allowlisted values from the env file to Vercel over stdin without printing them",
  )
  .option(
    "--environment <environment>",
    "production|preview|development",
    "production",
  )
  .option("--env-file <path>", "secure env file to read", ".env.local")
  .action(
    async ({
      environment,
      envFile,
    }: {
      environment: string;
      envFile: string;
    }) => {
      const parsedEnvironment = z
        .enum(["production", "preview", "development"])
        .parse(environment);
      const options = program.opts<{
        json: boolean;
        root: string;
      }>();
      const envPath = resolve(options.root, envFile);
      if (!(await exists(envPath)))
        throw new Error(`Environment file not found: ${envPath}`);
      const values = envFileValues(await readFile(envPath, "utf8"));
      const names = deployableEnvironmentNames.filter((name) => values[name]);
      if (names.length === 0)
        throw new Error("The environment file has no deployable values.");
      for (const name of names) {
        const result = await runCommand(
          "vercel",
          ["env", "add", name, parsedEnvironment, "--force"],
          { cwd: options.root, input: `${values[name]}\n` },
        );
        if (result.code !== 0)
          throw new Error(
            `Could not store ${name} in Vercel. Check CLI authentication and project linkage.`,
          );
      }
      emit(
        options.json
          ? {
              ok: true,
              environment: parsedEnvironment,
              valuesStored: names,
            }
          : `Stored ${names.length} environment values in Vercel ${parsedEnvironment} without printing them.`,
        options.json,
      );
    },
  );

program
  .command("configure-supabase")
  .description(
    "capture a hosted Supabase connection through hidden stdin and update the env file",
  )
  .requiredOption("--project-ref <ref>", "20-character Supabase project ref")
  .option("--env-file <path>", "secure env file to update", ".env.local")
  .option(
    "--use-env-database-url",
    "read DATABASE_URL from the secure env file instead of prompting",
    false,
  )
  .action(
    async ({
      projectRef,
      envFile,
      useEnvDatabaseUrl,
    }: {
      projectRef: string;
      envFile: string;
      useEnvDatabaseUrl: boolean;
    }) => {
      if (!/^[a-z]{20}$/u.test(projectRef))
        throw new Error("Supabase project ref must be 20 lowercase letters.");
      const options = program.opts<{
        json: boolean;
        root: string;
      }>();
      const envPath = resolve(options.root, envFile);
      const currentValues = (await exists(envPath))
        ? envFileValues(await readFile(envPath, "utf8"))
        : {};
      const databaseUrl = useEnvDatabaseUrl
        ? (currentValues.DATABASE_URL ?? "")
        : await readSecretInput(
            "Paste the hosted Supabase DATABASE_URL (input is hidden): ",
          );
      const parsedDatabaseUrl =
        environmentFieldSchemas.DATABASE_URL.safeParse(databaseUrl);
      if (!parsedDatabaseUrl.success || !new URL(databaseUrl).password)
        throw new Error(
          "DATABASE_URL must be a valid Postgres URL containing the database password.",
        );

      const link = await runCommand(
        "supabase",
        ["link", "--project-ref", projectRef],
        {
          cwd: options.root,
          env: {
            ...process.env,
            SUPABASE_DB_PASSWORD: decodeURIComponent(
              new URL(databaseUrl).password,
            ),
          },
        },
      );
      if (link.code !== 0)
        throw new Error(
          "Could not link the Supabase project. Check CLI authentication and the database URL.",
        );

      const apiKeys = await runCommand(
        "supabase",
        [
          "projects",
          "api-keys",
          "--project-ref",
          projectRef,
          "--reveal",
          "--output",
          "json",
        ],
        { cwd: options.root },
      );
      if (apiKeys.code !== 0)
        throw new Error(
          "Could not retrieve Supabase API keys. Check CLI authentication and project access.",
        );
      const { publishableKey, secretKey } = parseSupabaseApiKeys(
        JSON.parse(apiKeys.stdout),
      );
      const projectUrl = `https://${projectRef}.supabase.co`;
      await setEnvValues(envPath, {
        NEXT_PUBLIC_SUPABASE_URL: projectUrl,
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: publishableKey,
        SUPABASE_URL: projectUrl,
        SUPABASE_PUBLISHABLE_KEY: publishableKey,
        SUPABASE_SECRET_KEY: secretKey,
        DATABASE_URL: databaseUrl,
      });
      emit(
        options.json
          ? {
              ok: true,
              projectRef,
              envFile: envPath,
              valuesCaptured: Object.keys({
                NEXT_PUBLIC_SUPABASE_URL: true,
                NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: true,
                SUPABASE_URL: true,
                SUPABASE_PUBLISHABLE_KEY: true,
                SUPABASE_SECRET_KEY: true,
                DATABASE_URL: true,
              }),
            }
          : `Linked Supabase project ${projectRef} and stored its connection values in ${envPath} without printing them.`,
        options.json,
      );
    },
  );

program
  .command("configure-supabase-scheduler")
  .description(
    "schedule the protected queue consumer with Supabase Cron and Vault",
  )
  .option("--env-file <path>", "secure env file to read", ".env.local")
  .action(async ({ envFile }: { envFile: string }) => {
    const options = program.opts<{ json: boolean; root: string }>();
    const envPath = resolve(options.root, envFile);
    if (!(await exists(envPath)))
      throw new Error(`Environment file not found: ${envPath}`);
    const values = envFileValues(await readFile(envPath, "utf8"));
    const databaseUrl = environmentFieldSchemas.DATABASE_URL.parse(
      values.DATABASE_URL,
    );
    const appUrl = environmentFieldSchemas.NEXT_PUBLIC_APP_URL.parse(
      values.NEXT_PUBLIC_APP_URL,
    );
    const internalApiSecret = environmentFieldSchemas.INTERNAL_API_SECRET.parse(
      values.INTERNAL_API_SECRET,
    );
    const parsedAppUrl = new URL(appUrl);
    if (
      parsedAppUrl.protocol !== "https:" ||
      ["localhost", "127.0.0.1", "::1"].includes(parsedAppUrl.hostname)
    )
      throw new Error(
        "NEXT_PUBLIC_APP_URL must be the final public HTTPS deployment URL.",
      );
    const consumerUrl = new URL(
      "/api/internal/consume",
      parsedAppUrl,
    ).toString();
    const result = await configureSupabaseScheduler({
      databaseUrl,
      consumerUrl,
      internalApiSecret,
    });
    emit(
      options.json
        ? { ok: true, provider: "supabase-cron", consumerUrl, ...result }
        : `Scheduled ${consumerUrl} once per minute with Supabase Cron (job ${result.jobId}).`,
      options.json,
    );
  });

program
  .command("configure-blooio")
  .description(
    "verify a user-managed Blooio account and discover its active channels",
  )
  .option("--channel-id <id>", "explicit active Blooio channel to use")
  .option("--env-file <path>", "secure env file to update", ".env.local")
  .option(
    "--use-env-api-key",
    "read BLOOIO_API_KEY from the secure env file instead of prompting",
    false,
  )
  .action(
    async ({
      channelId,
      envFile,
      useEnvApiKey,
    }: {
      channelId?: string;
      envFile: string;
      useEnvApiKey: boolean;
    }) => {
      const options = program.opts<{ json: boolean; root: string }>();
      const envPath = resolve(options.root, envFile);
      const values = (await exists(envPath))
        ? envFileValues(await readFile(envPath, "utf8"))
        : {};
      const apiKey = useEnvApiKey
        ? (process.env.BLOOIO_API_KEY ?? values.BLOOIO_API_KEY ?? "")
        : await readSecretInput("Paste the Blooio API key (input is hidden): ");
      if (!apiKey)
        throw new Error(
          "BLOOIO_API_KEY is missing. Add it through setup-ui or enter it at the hidden prompt.",
        );
      const result = await configureBlooio({
        envPath,
        apiKey,
        ...(channelId ? { channelId } : {}),
      });
      const safeChannels = result.channels.map((channel) => ({
        id: channel.id,
        address: channel.address,
        status: channel.status,
      }));
      emit(
        options.json
          ? {
              ok: true,
              channels: safeChannels,
              selectedChannelId: result.selectedChannelId ?? null,
              envFile: envPath,
            }
          : result.selectedChannelId
            ? `Verified Blooio and selected ${result.selectedChannelId}.`
            : `Verified Blooio with ${result.channels.length} active channels. Add --channel-id to pin one, or leave routing to Blooio.`,
        options.json,
      );
    },
  );

program
  .command("create-blooio-webhook")
  .description(
    "idempotently register the deployed webhook; the signing secret is never printed",
  )
  .requiredOption("--url <url>", "public application URL")
  .option("--env-file <path>", "secure env file to update", ".env.local")
  .action(async ({ url, envFile }: { url: string; envFile: string }) => {
    const options = program.opts<{ json: boolean; root: string }>();
    const secretPath = resolve(options.root, envFile);
    const webhook = await ensureBlooioWebhook({
      envPath: secretPath,
      appUrl: url,
    });
    emit(
      options.json
        ? {
            ok: true,
            ...webhook,
            envFile: secretPath,
          }
        : webhook.operation === "reused"
          ? `Verified existing webhook ${webhook.webhookId}; the stored signing secret was preserved.`
          : `${webhook.operation === "created" ? "Created" : "Recovered"} webhook ${webhook.webhookId}; stored its one-time signing secret in ${secretPath} with mode 0600.`,
      options.json,
    );
  });

// pnpm 10 preserves the conventional `--` separator when forwarding script
// arguments. Commander treats it as the end of options, so normalize it here.
const cliArgv = process.argv.filter(
  (value, index) => index < 2 || value !== "--",
);

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  program.parseAsync(cliArgv).catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}

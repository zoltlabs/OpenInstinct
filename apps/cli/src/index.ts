#!/usr/bin/env node
import { access, chmod, copyFile, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import { parseEnv } from "node:util";
import { Command } from "commander";
import { z } from "zod";
import { BlooioClient } from "@openinstinct/messaging";
import {
  deploymentTargetSchema,
  environmentFieldSchemas,
  requiredCli,
  runCommand,
  type DeploymentTarget,
} from "@openinstinct/runtime";

export type Check = { name: string; ok: boolean; detail: string };
const setupPhaseSchema = z.enum(["bootstrap", "ready"]);
type SetupPhase = z.infer<typeof setupPhaseSchema>;

function emit(value: unknown, json: boolean): void {
  process.stdout.write(
    `${json ? JSON.stringify(value, null, 2) : String(value)}\n`,
  );
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
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

export function envFileValues(
  source: string,
): Record<string, string | undefined> {
  return parseEnv(source);
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

async function setEnvValue(
  path: string,
  name: string,
  value: string,
): Promise<void> {
  const source = (await exists(path)) ? await readFile(path, "utf8") : "";
  const lines = source.split(/\r?\n/u);
  const index = lines.findIndex((line) => line.startsWith(`${name}=`));
  const assignment = `${name}=${value}`;
  if (index >= 0) lines[index] = assignment;
  else lines.push(assignment);
  await writeFile(
    path,
    `${lines.filter((line, i) => line || i < lines.length - 1).join("\n")}\n`,
    {
      mode: 0o600,
    },
  );
  await chmod(path, 0o600);
}

const commonEnvironmentNames = [
  "NEXT_PUBLIC_APP_URL",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SECRET_KEY",
  "DATABASE_URL",
  "SECRET_ENCRYPTION_KEY",
  "BLOOIO_API_KEY",
  "BLOOIO_OWNER_PHONE",
  "OWNER_EMAIL",
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
  "AI_GATEWAY_API_KEY",
  "AI_MODEL",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REDIRECT_URI",
  "KERNEL_API_KEY",
  "INTERNAL_API_SECRET",
  "CRON_SECRET",
  "WORKER_URL",
] as const;

export function checkEnvironment(input: {
  values: Record<string, string | undefined>;
  target: DeploymentTarget;
  phase: SetupPhase;
}): Check[] {
  const names: Array<keyof typeof environmentFieldSchemas> = [
    ...commonEnvironmentNames,
  ];
  if (input.phase === "ready") names.push("BLOOIO_WEBHOOK_SECRET");
  if (input.target === "vercel-pro") names.push("CRON_SECRET");
  if (!["vercel", "vercel-pro"].includes(input.target))
    names.push("AI_GATEWAY_API_KEY");

  const checks = names.map((name) => {
    const value = input.values[name];
    if (!value) return { name: `env:${name}`, ok: false, detail: "missing" };
    const result = environmentFieldSchemas[name].safeParse(value);
    return {
      name: `env:${name}`,
      ok: result.success,
      detail: result.success ? "valid" : "invalid",
    };
  });

  if (input.target !== "docker") {
    for (const name of [
      "NEXT_PUBLIC_APP_URL",
      "NEXT_PUBLIC_SUPABASE_URL",
    ] as const) {
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

export function setupActions(target: DeploymentTarget) {
  const deploy =
    target === "vercel" || target === "vercel-pro"
      ? [
          {
            id: "link-vercel",
            command: "vercel link",
            mutatesExternalState: true,
          },
          {
            id: "sync-vercel-environment",
            command:
              "pnpm run openinstinct -- push-vercel-env --environment production",
            mutatesExternalState: true,
            secretInput: "read from .env.local and sent over stdin",
            confirmation: "required-before-credential-storage",
          },
          {
            id: "deploy-web",
            command: "vercel deploy --prod",
            mutatesExternalState: true,
          },
        ]
      : [];
  return [
    {
      id: "provision-supabase",
      description:
        "Create or select a hosted Supabase project. Prefer an authorized Supabase MCP/API integration; use browser control as the fallback.",
      preferredTool: "supabase-mcp",
      fallbackTool: "computer-use",
      mutatesExternalState: true,
      confirmation: "required-before-project-or-credential-creation",
    },
    {
      id: "capture-supabase",
      command:
        "pnpm run openinstinct -- configure-supabase --project-ref <project-ref>",
      mutatesExternalState: false,
      secretInput: "hidden prompt or stdin",
    },
    {
      id: "configure-supabase-auth",
      description:
        "Set the hosted Supabase Site URL and allowed redirect URL to NEXT_PUBLIC_APP_URL and NEXT_PUBLIC_APP_URL/api/auth/callback.",
      preferredTool: "supabase-mcp",
      fallbackTool: "computer-use",
      mutatesExternalState: true,
    },
    {
      id: "push-schema",
      command: "pnpm exec supabase db push --linked",
      mutatesExternalState: true,
    },
    ...deploy,
    ...(target === "vercel"
      ? [
          {
            id: "deploy-scheduler",
            command: "pnpm --dir infra/cloudflare-scheduler deploy",
            mutatesExternalState: true,
          },
        ]
      : []),
  ];
}

program
  .command("setup")
  .description("prepare local configuration and report remaining actions")
  .option("--target <target>", "vercel|vercel-pro|aws|gcp|docker", "vercel")
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
      if (!(await exists(envPath)))
        await copyFile(resolve(root, ".env.example"), envPath);
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
      const parsedTarget = deploymentTargetSchema.parse(target);
      const parsedDatabase = z.enum(["hosted", "local"]).parse(database);
      const checks = await doctor(root, parsedTarget, "bootstrap", envFile);
      const next =
        parsedDatabase === "local"
          ? [
              "Run: pnpm supabase:start && pnpm supabase:reset",
              "Fill the local Supabase values in .env.local",
              "Run: pnpm dev",
              "Run: pnpm run smoke -- --url http://localhost:3000",
            ]
          : [
              "Create or select a hosted Supabase project with an authorized MCP/API integration; use browser control only as fallback.",
              "Capture its connection securely with: pnpm run openinstinct -- configure-supabase --project-ref <project-ref> (paste DATABASE_URL only into the hidden prompt).",
              "Configure hosted Supabase Auth URLs for the final application URL.",
              "Run: pnpm exec supabase db push --linked",
              `Run: pnpm run doctor -- --target ${parsedTarget} --phase bootstrap --json`,
              ...(["vercel", "vercel-pro"].includes(parsedTarget)
                ? [
                    "Run: vercel link",
                    "Run: pnpm run openinstinct -- push-vercel-env --environment production",
                    "Run: vercel deploy --prod",
                  ]
                : []),
            ];
      const result = {
        ok: checks.every((check) => check.ok),
        target: parsedTarget,
        database: parsedDatabase,
        envFile: envPath,
        checks,
        next,
        actions: parsedDatabase === "hosted" ? setupActions(parsedTarget) : [],
      };
      emit(options.json ? result : result.next.join("\n"), options.json);
      if (!result.ok) process.exitCode = 2;
    },
  );

program
  .command("doctor")
  .description("check prerequisites without changing external services")
  .option("--target <target>", "vercel|vercel-pro|aws|gcp|docker", "vercel")
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
  .action(
    async ({
      projectRef,
      envFile,
    }: {
      projectRef: string;
      envFile: string;
    }) => {
      if (!/^[a-z]{20}$/u.test(projectRef))
        throw new Error("Supabase project ref must be 20 lowercase letters.");
      const options = program.opts<{
        json: boolean;
        root: string;
      }>();
      const databaseUrl = await readSecretInput(
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
      const envPath = resolve(options.root, envFile);
      const projectUrl = `https://${projectRef}.supabase.co`;
      for (const [name, value] of Object.entries({
        NEXT_PUBLIC_SUPABASE_URL: projectUrl,
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: publishableKey,
        SUPABASE_URL: projectUrl,
        SUPABASE_PUBLISHABLE_KEY: publishableKey,
        SUPABASE_SECRET_KEY: secretKey,
        DATABASE_URL: databaseUrl,
      })) {
        await setEnvValue(envPath, name, value);
      }
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
  .command("create-blooio-webhook")
  .description(
    "register the deployed webhook; the signing secret is never printed",
  )
  .requiredOption("--url <url>", "public application URL")
  .option("--env-file <path>", "secure env file to update", ".env.local")
  .action(async ({ url, envFile }: { url: string; envFile: string }) => {
    const options = program.opts<{ json: boolean; root: string }>();
    const secretPath = resolve(options.root, envFile);
    const values = (await exists(secretPath))
      ? envFileValues(await readFile(secretPath, "utf8"))
      : {};
    const apiKey = process.env.BLOOIO_API_KEY ?? values.BLOOIO_API_KEY;
    if (!apiKey)
      throw new Error(
        "Set BLOOIO_API_KEY in the environment or add it to --env-file.",
      );
    const publicUrl = new URL(url);
    if (publicUrl.protocol !== "https:")
      throw new Error("Blooio webhooks require a public HTTPS URL.");
    const webhook = await new BlooioClient({ apiKey }).createWebhook(
      new URL("/api/webhooks/blooio", publicUrl).toString(),
    );
    await setEnvValue(
      secretPath,
      "BLOOIO_WEBHOOK_SECRET",
      webhook.signingSecret,
    );
    emit(
      options.json
        ? {
            ok: true,
            webhookId: webhook.id,
            secretCaptured: true,
            envFile: secretPath,
          }
        : `Created webhook ${webhook.id}; stored the one-time signing secret in ${secretPath} with mode 0600.`,
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

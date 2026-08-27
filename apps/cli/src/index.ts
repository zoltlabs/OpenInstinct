#!/usr/bin/env node
import { access, chmod, copyFile, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { Command } from "commander";
import { BlooioClient } from "@openinstinct/messaging";
import {
  deploymentTargetSchema,
  requiredCli,
  runCommand,
  type DeploymentTarget,
} from "@openinstinct/runtime";

type Check = { name: string; ok: boolean; detail: string };

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

async function commandAvailable(command: string): Promise<boolean> {
  const result = await runCommand(command, ["--version"]);
  return result.code === 0;
}

function envFileValues(source: string): Record<string, string> {
  return Object.fromEntries(
    source
      .split(/\r?\n/u)
      .filter((line) => line && !line.startsWith("#") && line.includes("="))
      .map((line) => {
        const split = line.indexOf("=");
        return [line.slice(0, split), line.slice(split + 1)];
      }),
  );
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

async function doctor(
  root: string,
  target: DeploymentTarget,
): Promise<Check[]> {
  const checks: Check[] = [];
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  checks.push({ name: "node", ok: major >= 22, detail: process.versions.node });
  for (const command of requiredCli(target)) {
    const ok = await commandAvailable(command).catch(() => false);
    checks.push({
      name: `cli:${command}`,
      ok,
      detail: ok ? "installed" : "not found",
    });
  }
  const envPath = resolve(root, ".env.local");
  const hasEnv = await exists(envPath);
  checks.push({ name: "env-file", ok: hasEnv, detail: envPath });
  if (hasEnv) {
    const values = envFileValues(await readFile(envPath, "utf8"));
    for (const name of [
      "NEXT_PUBLIC_APP_URL",
      "NEXT_PUBLIC_SUPABASE_URL",
      "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
      "SUPABASE_SECRET_KEY",
      "DATABASE_URL",
      "SECRET_ENCRYPTION_KEY",
      "BLOOIO_API_KEY",
      "BLOOIO_WEBHOOK_SECRET",
      "BLOOIO_OWNER_PHONE",
      "OWNER_EMAIL",
      "AI_MODEL",
      "INTERNAL_API_SECRET",
    ]) {
      const ok = Boolean(values[name] || process.env[name]);
      checks.push({ name: `env:${name}`, ok, detail: ok ? "set" : "missing" });
    }
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
  .option("--target <target>", "vercel|cloudflare|aws|gcp|docker", "vercel")
  .action(async ({ target }: { target: string }) => {
    const options = program.opts<{ json: boolean; root: string }>();
    const root = resolve(options.root);
    const envPath = resolve(root, ".env.local");
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
    const checks = await doctor(root, parsedTarget);
    const result = {
      ok: checks.every((check) => check.ok),
      target: parsedTarget,
      envFile: envPath,
      checks,
      next: [
        "Fill missing values in .env.local",
        "Run: pnpm supabase:start && pnpm supabase:reset",
        "Run: pnpm dev",
        "Run: pnpm run smoke -- --url http://localhost:3000",
      ],
    };
    emit(options.json ? result : result.next.join("\n"), options.json);
    if (!result.ok) process.exitCode = 2;
  });

program
  .command("doctor")
  .description("check prerequisites without changing external services")
  .option("--target <target>", "vercel|cloudflare|aws|gcp|docker", "vercel")
  .action(async ({ target }: { target: string }) => {
    const options = program.opts<{ json: boolean; root: string }>();
    const checks = await doctor(
      resolve(options.root),
      deploymentTargetSchema.parse(target),
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
  });

program
  .command("smoke")
  .description("check the deployed health endpoints")
  .option("--url <url>", "application URL", process.env.NEXT_PUBLIC_APP_URL)
  .option("--worker-url <url>", "worker URL", process.env.WORKER_URL)
  .action(async ({ url, workerUrl }: { url?: string; workerUrl?: string }) => {
    const options = program.opts<{ json: boolean }>();
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
  });

program
  .command("create-blooio-webhook")
  .description(
    "register the deployed webhook; the signing secret is never printed",
  )
  .requiredOption("--url <url>", "public application URL")
  .option("--api-key <key>", "Blooio API key", process.env.BLOOIO_API_KEY)
  .option("--env-file <path>", "secure env file to update", ".env.local")
  .action(
    async ({
      url,
      apiKey,
      envFile,
    }: {
      url: string;
      apiKey?: string;
      envFile: string;
    }) => {
      if (!apiKey) throw new Error("Pass --api-key or set BLOOIO_API_KEY.");
      const publicUrl = new URL(url);
      if (publicUrl.protocol !== "https:")
        throw new Error("Blooio webhooks require a public HTTPS URL.");
      const options = program.opts<{ json: boolean }>();
      const webhook = await new BlooioClient({ apiKey }).createWebhook(
        new URL("/api/webhooks/blooio", publicUrl).toString(),
      );
      const secretPath = resolve(envFile);
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
    },
  );

// pnpm 10 preserves the conventional `--` separator when forwarding script
// arguments. Commander treats it as the end of options, so normalize it here.
const cliArgv = process.argv.filter(
  (value, index) => index < 2 || value !== "--",
);

program.parseAsync(cliArgv).catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});

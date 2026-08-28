import { spawn } from "node:child_process";
import { z } from "zod";

export const deploymentTargetSchema = z.enum([
  "vercel",
  "vercel-pro",
  "vercel-cloudflare",
  "aws",
  "gcp",
  "docker",
]);
export type DeploymentTarget = z.infer<typeof deploymentTargetSchema>;

export interface CommandResult {
  readonly command: string;
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export function runCommand(
  command: string,
  args: readonly string[],
  options: { cwd?: string; input?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      stdio: "pipe",
    });
    let stdout = "";
    let stderr = "";
    child.stdout
      .setEncoding("utf8")
      .on("data", (chunk: string) => (stdout += chunk));
    child.stderr
      .setEncoding("utf8")
      .on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({
        command: [command, ...args].join(" "),
        code: code ?? 1,
        stdout,
        stderr,
      }),
    );
    if (options.input) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

export function requiredCli(target: DeploymentTarget): readonly string[] {
  switch (target) {
    case "vercel":
    case "vercel-pro":
      return ["supabase", "vercel"];
    case "vercel-cloudflare":
      return ["supabase", "vercel", "wrangler"];
    case "aws":
      return ["supabase", "aws"];
    case "gcp":
      return ["supabase", "gcloud"];
    case "docker":
      return ["supabase", "docker"];
  }
}

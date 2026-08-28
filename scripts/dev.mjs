import { spawn } from "node:child_process";

const pnpmCli = process.env.npm_execpath;
const command = pnpmCli ? process.execPath : "pnpm";
const args = [
  ...(pnpmCli ? [pnpmCli] : []),
  "--parallel",
  "--filter",
  "@openinstinct/web",
  "--filter",
  "@openinstinct/worker",
  "dev",
];

const child = spawn(command, args, {
  env: process.env,
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("error", (error) => {
  process.stderr.write(
    `Could not start development services: ${error.message}\n`,
  );
  process.exitCode = 1;
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});

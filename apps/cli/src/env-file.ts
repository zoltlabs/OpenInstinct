import { access, chmod, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { parseEnv } from "node:util";

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export function envFileValues(
  source: string,
): Record<string, string | undefined> {
  return parseEnv(source);
}

function serializeEnvValue(value: string): string {
  if (/\u0000|\r|\n/u.test(value))
    throw new Error("Environment values cannot contain line breaks or NUL.");
  return JSON.stringify(value);
}

export async function setEnvValues(
  path: string,
  values: Record<string, string>,
): Promise<void> {
  const source = (await pathExists(path)) ? await readFile(path, "utf8") : "";
  const lines = source.split(/\r?\n/u);
  for (const [name, value] of Object.entries(values)) {
    const index = lines.findIndex((line) => line.startsWith(`${name}=`));
    const assignment = `${name}=${serializeEnvValue(value)}`;
    if (index >= 0) lines[index] = assignment;
    else lines.push(assignment);
  }
  await writeFile(
    path,
    `${lines.filter((line, index) => line || index < lines.length - 1).join("\n")}\n`,
    { mode: 0o600 },
  );
  await chmod(path, 0o600);
}

export async function setEnvValue(
  path: string,
  name: string,
  value: string,
): Promise<void> {
  await setEnvValues(path, { [name]: value });
}

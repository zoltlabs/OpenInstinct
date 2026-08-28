export interface BrowserSession {
  readonly id: string;
  readonly liveViewUrl?: string;
}

export interface BrowserProvider {
  create(input: {
    startUrl?: string;
    profileId?: string;
    timeoutSeconds?: number;
  }): Promise<BrowserSession>;
  execute(input: {
    sessionId: string;
    code: string;
    timeoutSeconds?: number;
  }): Promise<unknown>;
  destroy(sessionId: string): Promise<void>;
}

export function browserActionProgram(rawAction: BrowserAction): string {
  const action = browserActionSchema.parse(rawAction);
  const serialized = JSON.stringify(action.steps).replaceAll("<", "\\u003c");
  return `const steps = ${serialized};
for (const step of steps) {
  if (step.action === "goto") await page.goto(step.url, { waitUntil: "domcontentloaded" });
  else if (step.action === "click") await page.locator(step.selector).click();
  else if (step.action === "fill") await page.locator(step.selector).fill(step.value);
  else if (step.action === "select") await page.locator(step.selector).selectOption(step.value);
  else if (step.action === "wait") await page.waitForTimeout(step.milliseconds);
}
return { url: page.url(), title: await page.title(), text: (await page.locator("body").innerText()).slice(0, 12000) };`;
}

export const browserReadProgram = `return { url: page.url(), title: await page.title(), text: (await page.locator("body").innerText()).slice(0, 20000), links: await page.locator("a[href]").evaluateAll((nodes) => nodes.slice(0, 100).map((node) => ({ text: (node.textContent || "").trim(), href: node.href }))) };`;
import { z } from "zod";

export const browserStepSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("goto"), url: z.string().url() }),
  z.object({
    action: z.literal("click"),
    selector: z.string().min(1).max(500),
  }),
  z.object({
    action: z.literal("fill"),
    selector: z.string().min(1).max(500),
    value: z.string().max(10_000),
  }),
  z.object({
    action: z.literal("select"),
    selector: z.string().min(1).max(500),
    value: z.string().max(1_000),
  }),
  z.object({
    action: z.literal("wait"),
    milliseconds: z.number().int().min(0).max(5_000),
  }),
]);

export const browserActionSchema = z.object({
  startUrl: z.string().url(),
  profileId: z.string().max(500).optional(),
  steps: z.array(browserStepSchema).min(1).max(20),
});

export type BrowserAction = z.infer<typeof browserActionSchema>;

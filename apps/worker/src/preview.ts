import { generateText, type LanguageModel } from "ai";
import { assistantInstructions } from "@openinstinct/core";

export async function previewAssistantMessage(input: {
  model: LanguageModel;
  message: string;
}): Promise<string> {
  const message = input.message.trim();
  if (!message) throw new Error("A preview message is required.");
  const result = await generateText({
    model: input.model,
    system: `${assistantInstructions}\n\nThis is a local model-only preview. Do not claim to have used tools, read private services, or completed external actions.`,
    prompt: message,
  });
  return result.text;
}

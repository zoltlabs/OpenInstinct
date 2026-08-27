import { ToolLoopAgent, isStepCount, tool, type ModelMessage } from "ai";
import { z } from "zod";
import {
  assistantInstructions,
  createActionRequest,
  decideAction,
  type ActionRequest,
} from "@openinstinct/core";
import type { OpenInstinctStore, RunContext } from "@openinstinct/db";
import { GoogleConnector } from "@openinstinct/connectors";

const calendarEventInputSchema = z.object({
  summary: z.string().min(1),
  description: z.string().optional(),
  startDateTime: z.string().datetime(),
  endDateTime: z.string().datetime(),
  timeZone: z.string().optional(),
  attendees: z.array(z.string().email()).optional(),
});

const gmailDraftInputSchema = z.object({
  to: z.string().email(),
  subject: z.string().min(1),
  body: z.string().min(1),
});

export interface AgentExecution {
  readonly text: string;
  readonly pendingAction?: ActionRequest;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export async function runAssistantAgent(input: {
  context: RunContext;
  store: OpenInstinctStore;
  google?: GoogleConnector;
  googleConnection?: { id: string; account: string; configVersion: string };
  model: string;
  appUrl: string;
  mcpConnections?: readonly {
    id: string;
    name: string;
    toolNames: readonly string[];
    configVersion: string;
  }[];
}): Promise<AgentExecution> {
  let pendingAction: ActionRequest | undefined;

  const requireGoogle = () => {
    if (!input.google)
      throw new Error("Google is not connected for this deployment.");
    return input.google;
  };

  const propose = async (proposal: {
    toolName: string;
    risk: "write" | "communicate";
    summary: string;
    payload: Record<string, unknown>;
  }) => {
    if (pendingAction) {
      return {
        status: "approval_required",
        reason: "This run already has a pending action.",
        summary: pendingAction.summary,
        approvalUrl: `${input.appUrl}/approvals/${pendingAction.id}`,
      };
    }
    const decision = decideAction({
      risk: proposal.risk,
      toolName: proposal.toolName,
    });
    if (decision.type === "deny")
      return { status: "denied", reason: decision.reason };
    const action = createActionRequest({
      workspaceId: input.context.workspaceId,
      runId: input.context.runId,
      toolName: proposal.toolName,
      risk: proposal.risk,
      summary: proposal.summary,
      payload: proposal.payload,
    });
    await input.store.saveActionRequest(action);
    pendingAction = action;
    return {
      status: "approval_required",
      reason: decision.reason,
      summary: action.summary,
      approvalUrl: `${input.appUrl}/approvals/${action.id}`,
    };
  };

  const tools = {
    searchGmail: tool({
      description: "Search the owner's Gmail. Read-only.",
      inputSchema: z.object({
        query: z.string().min(1),
        maxResults: z.number().int().min(1).max(20).optional(),
      }),
      execute: ({ query, maxResults }) =>
        requireGoogle().searchGmail(query, maxResults),
    }),
    getGmailMessage: tool({
      description: "Read a Gmail message by its message ID. Read-only.",
      inputSchema: z.object({ messageId: z.string().min(1) }),
      execute: ({ messageId }) => requireGoogle().getGmailMessage(messageId),
    }),
    listCalendarEvents: tool({
      description:
        "List Google Calendar events in an ISO timestamp range. Read-only.",
      inputSchema: z.object({
        timeMin: z.string().datetime(),
        timeMax: z.string().datetime(),
        maxResults: z.number().int().min(1).max(50).optional(),
      }),
      execute: (value) => requireGoogle().listCalendarEvents(value),
    }),
    proposeGmailDraft: tool({
      description:
        "Propose creating a Gmail draft. This does not execute until the owner approves it.",
      inputSchema: gmailDraftInputSchema,
      execute: (value) =>
        propose({
          toolName: "google.gmail.create_draft",
          risk: "write",
          summary: `Create Gmail draft to ${value.to}: ${value.subject}`,
          payload: { ...value, googleConnection: input.googleConnection },
        }),
    }),
    proposeCalendarEvent: tool({
      description:
        "Propose creating a Google Calendar event. This does not execute until the owner approves it.",
      inputSchema: calendarEventInputSchema,
      execute: (value) =>
        propose({
          toolName: "google.calendar.create",
          risk: "write",
          summary: `Create calendar event: ${value.summary}`,
          payload: { ...value, googleConnection: input.googleConnection },
        }),
    }),
    proposeMcpCall: tool({
      description: `Propose a call to a connected remote MCP server. Every MCP call requires owner approval. Available connections: ${JSON.stringify(input.mcpConnections ?? [])}`,
      inputSchema: z.object({
        connectionId: z.string().uuid(),
        toolName: z.string().min(1),
        arguments: z.record(z.string(), z.unknown()).default({}),
        summary: z.string().min(1),
      }),
      execute: (value) => {
        const connection = input.mcpConnections?.find(
          (item) => item.id === value.connectionId,
        );
        if (!connection || !connection.toolNames.includes(value.toolName)) {
          return {
            status: "denied",
            reason: "MCP connection or tool is not allowlisted.",
          };
        }
        return propose({
          toolName: "mcp.call",
          risk: "write",
          summary: value.summary,
          payload: {
            connectionId: value.connectionId,
            toolName: value.toolName,
            arguments: value.arguments,
            configVersion: connection.configVersion,
          },
        });
      },
    }),
  };

  const agent = new ToolLoopAgent({
    model: input.model,
    instructions: assistantInstructions,
    stopWhen: isStepCount(8),
    tools,
  });
  const messages: ModelMessage[] = input.context.messages.map((message) => ({
    role: message.role,
    content: message.content,
  }));
  const result = await agent.generate({ messages });
  return {
    text:
      result.text ||
      (pendingAction ? "I prepared that action for your approval." : "Done."),
    pendingAction,
    inputTokens: result.totalUsage.inputTokens ?? 0,
    outputTokens: result.totalUsage.outputTokens ?? 0,
  };
}

export async function executeApprovedGoogleAction(input: {
  action: ActionRequest;
  google: GoogleConnector;
}): Promise<unknown> {
  switch (input.action.toolName) {
    case "google.gmail.create_draft":
      return input.google.createGmailDraft(
        gmailDraftInputSchema.parse(input.action.input),
      );
    case "google.calendar.create": {
      const value = calendarEventInputSchema.parse(input.action.input);
      return input.google.createCalendarEvent({
        id: input.action.id.replaceAll("-", ""),
        summary: value.summary,
        description: value.description,
        start: { dateTime: value.startDateTime, timeZone: value.timeZone },
        end: { dateTime: value.endDateTime, timeZone: value.timeZone },
        attendees: value.attendees,
      });
    }
    default:
      throw new Error(`Unsupported approved action: ${input.action.toolName}`);
  }
}

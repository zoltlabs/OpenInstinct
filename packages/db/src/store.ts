import { randomUUID } from "node:crypto";
import postgres, { type Sql } from "postgres";
import {
  actionRequestSchema,
  payloadHash,
  type ActionRequest,
} from "@openinstinct/core";
import { z } from "zod";
import { agentJobSchema, type AgentJob, type ClaimedJob } from "./jobs";

type JsonValue =
  | null
  | string
  | number
  | boolean
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue | undefined };

function toJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

const messageEventDataSchema = z
  .object({
    message_id: z.string(),
    chat_id: z.string(),
    text: z.string().nullable().optional(),
    sender: z.string().optional(),
    recipient: z.string().optional(),
    status: z.string().optional(),
  })
  .passthrough();

export interface RunContext {
  readonly runId: string;
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly ownerPhone: string;
  readonly messages: readonly { role: "user" | "assistant"; content: string }[];
}

export type ConnectionStatus =
  | "pending"
  | "active"
  | "expired"
  | "revoked"
  | "error";

export class RunNotClaimableError extends Error {
  override readonly name = "RunNotClaimableError";
}

export class OpenInstinctStore {
  readonly #sql: Sql;

  constructor(databaseUrl: string, options: { max?: number } = {}) {
    this.#sql = postgres(databaseUrl, {
      max: options.max ?? 4,
      prepare: false,
      ssl: databaseUrl.includes("localhost") ? false : "require",
    });
  }

  async close(): Promise<void> {
    await this.#sql.end();
  }

  async health(): Promise<boolean> {
    const [row] = await this.#sql<{ ok: number }[]>`select 1 as ok`;
    return row?.ok === 1;
  }

  async bootstrapOwner(input: {
    ownerUserId: string;
    displayName: string;
    timezone: string;
    phoneE164: string;
  }): Promise<{ workspaceId: string }> {
    return this.#sql.begin(async (tx) => {
      const existing =
        await tx`select id from public.workspaces limit 1 for update`;
      if (existing.length > 0)
        throw new Error("This deployment already has an owner.");
      const [workspace] = await tx<{ id: string }[]>`
        insert into public.workspaces (owner_user_id, display_name, timezone)
        values (${input.ownerUserId}, ${input.displayName}, ${input.timezone})
        returning id
      `;
      if (!workspace) throw new Error("Could not create owner workspace.");
      await tx`
        insert into public.owner_phone_numbers (workspace_id, phone_e164, verified_at)
        values (${workspace.id}, ${input.phoneE164}, now())
      `;
      return { workspaceId: workspace.id };
    });
  }

  async ingestBlooioEvent(event: {
    id: string;
    type: string;
    created_at: number;
    data: Record<string, unknown>;
  }): Promise<{ duplicate: boolean; runId?: string; workspaceId?: string }> {
    const data = messageEventDataSchema.safeParse(event.data);
    if (!data.success || event.type !== "message.received") {
      const inserted = await this.#sql`
        insert into public.inbound_events (id, source, type, occurred_at, payload)
        values (${event.id}, 'blooio', ${event.type}, ${new Date(event.created_at)}, ${this.#sql.json(toJson(event.data))})
        on conflict (id) do nothing
        returning id
      `;
      return { duplicate: inserted.length === 0 };
    }

    return this.#sql.begin(async (tx) => {
      const existing =
        await tx`select id from public.inbound_events where id = ${event.id}`;
      if (existing.length > 0) return { duplicate: true };

      const sender = data.data.sender;
      if (!sender)
        throw new Error("Inbound Blooio message is missing its sender.");
      const [owner] = await tx<{ workspace_id: string }[]>`
        select workspace_id from public.owner_phone_numbers
        where phone_e164 = ${sender} and verified_at is not null
      `;
      if (!owner)
        throw new Error("Inbound sender is not the verified deployment owner.");

      await tx`
        insert into public.inbound_events (id, workspace_id, source, type, occurred_at, payload)
        values (${event.id}, ${owner.workspace_id}, 'blooio', ${event.type}, ${new Date(event.created_at)}, ${tx.json(toJson(event.data))})
      `;
      const [conversation] = await tx<{ id: string }[]>`
        insert into public.conversations (workspace_id, provider, provider_chat_id, contact_address)
        values (${owner.workspace_id}, 'blooio', ${data.data.chat_id}, ${sender})
        on conflict (workspace_id, provider, provider_chat_id)
        do update set updated_at = now(), contact_address = excluded.contact_address
        returning id
      `;
      if (!conversation) throw new Error("Could not create conversation.");

      const insertedMessage = await tx`
        insert into public.messages (
          workspace_id, conversation_id, provider_message_id, role, direction, content, status, raw
        ) values (
          ${owner.workspace_id}, ${conversation.id}, ${data.data.message_id}, 'user', 'inbound',
          ${data.data.text ?? ""}, ${data.data.status ?? "received"}, ${tx.json(toJson(event.data))}
        ) on conflict (workspace_id, provider_message_id) do nothing
        returning id
      `;
      if (insertedMessage.length === 0) return { duplicate: true };
      const runId = randomUUID();
      await tx`
        insert into public.agent_runs (id, workspace_id, conversation_id, trigger_event_id, status)
        values (${runId}, ${owner.workspace_id}, ${conversation.id}, ${event.id}, 'queued')
      `;
      const job: AgentJob = {
        type: "process_event",
        eventId: event.id,
        runId,
        workspaceId: owner.workspace_id,
      };
      await tx`select pgmq.send('agent_jobs', ${tx.json(toJson(job))}::jsonb)`;
      return { duplicate: false, runId, workspaceId: owner.workspace_id };
    });
  }

  async claimJobs(limit = 5, visibilitySeconds = 120): Promise<ClaimedJob[]> {
    const rows = await this.#sql<
      { msg_id: string | number; read_ct: number; message: unknown }[]
    >`select msg_id, read_ct, message from pgmq.read('agent_jobs', ${visibilitySeconds}, ${limit})`;
    return rows.map((row) => ({
      messageId: Number(row.msg_id),
      readCount: row.read_ct,
      job: agentJobSchema.parse(row.message),
    }));
  }

  async archiveJob(messageId: number): Promise<void> {
    await this.#sql`select pgmq.archive('agent_jobs', ${messageId}::bigint)`;
  }

  async retryJob(messageId: number, delaySeconds: number): Promise<void> {
    await this
      .#sql`select pgmq.set_vt('agent_jobs', ${messageId}::bigint, ${delaySeconds})`;
  }

  async getRunContext(runId: string): Promise<RunContext> {
    const [run] = await this.#sql<
      { workspace_id: string; conversation_id: string; phone_e164: string }[]
    >`
      update public.agent_runs r set status = 'running', attempt = attempt + 1,
        started_at = coalesce(started_at, now()), last_error = null
      from public.owner_phone_numbers p
      where r.id = ${runId} and p.workspace_id = r.workspace_id
        and r.status in ('queued', 'failed')
      returning r.workspace_id, r.conversation_id, p.phone_e164
    `;
    if (!run) throw new RunNotClaimableError("Run is not claimable.");
    const messages = await this.#sql<
      { role: "user" | "assistant"; content: string }[]
    >`
      select role, content from (
        select role, content, created_at from public.messages
        where conversation_id = ${run.conversation_id} and role in ('user', 'assistant')
        order by created_at desc limit 50
      ) recent order by created_at asc
    `;
    return {
      runId,
      workspaceId: run.workspace_id,
      conversationId: run.conversation_id,
      ownerPhone: run.phone_e164,
      messages,
    };
  }

  async saveAssistantMessage(input: {
    workspaceId: string;
    conversationId: string;
    content: string;
    providerMessageId?: string;
    status?: string;
  }): Promise<void> {
    await this.#sql`
      insert into public.messages (
        workspace_id, conversation_id, provider_message_id, role, direction, content, status
      ) values (
        ${input.workspaceId}, ${input.conversationId}, ${input.providerMessageId ?? null},
        'assistant', 'outbound', ${input.content}, ${input.status ?? null}
      )
    `;
  }

  async completeRun(input: {
    runId: string;
    inputTokens?: number;
    outputTokens?: number;
    model?: string;
  }): Promise<void> {
    await this.#sql`
      update public.agent_runs set status = 'completed', completed_at = now(),
        input_tokens = ${input.inputTokens ?? 0}, output_tokens = ${input.outputTokens ?? 0},
        model = ${input.model ?? null}
      where id = ${input.runId} and status = 'running'
    `;
  }

  async failRun(runId: string, error: string): Promise<void> {
    await this.#sql`
      update public.agent_runs set status = 'failed', last_error = ${error}
      where id = ${runId} and status = 'running'
    `;
  }

  async saveActionRequest(action: ActionRequest): Promise<void> {
    const value = actionRequestSchema.parse(action);
    await this.#sql.begin(async (tx) => {
      await tx`
        insert into public.action_requests (
          id, workspace_id, run_id, tool_name, risk, summary, input, input_hash, status, expires_at
        ) values (
          ${value.id}, ${value.workspaceId}, ${value.runId}, ${value.toolName}, ${value.risk},
          ${value.summary}, ${tx.json(toJson(value.input))}, ${value.inputHash}, ${value.status},
          ${new Date(value.expiresAt)}
        )
      `;
      const updated = await tx`
        update public.agent_runs set status = 'waiting_approval', waiting_for = ${value.id}
        where id = ${value.runId} and workspace_id = ${value.workspaceId} and status = 'running'
        returning id
      `;
      if (updated.length !== 1)
        throw new Error("Run cannot wait for this action.");
    });
  }

  async getConnection(input: {
    workspaceId: string;
    provider: string;
  }): Promise<
    | {
        id: string;
        encryptedCredentials: string;
        metadata: Record<string, unknown>;
      }
    | undefined
  > {
    const [row] = await this.#sql<
      {
        id: string;
        encrypted_credentials: string | null;
        metadata: Record<string, unknown>;
      }[]
    >`
      select id, encrypted_credentials, metadata from public.connections
      where workspace_id = ${input.workspaceId} and provider = ${input.provider} and status = 'active'
      order by updated_at desc limit 1
    `;
    return row?.encrypted_credentials
      ? {
          id: row.id,
          encryptedCredentials: row.encrypted_credentials,
          metadata: row.metadata,
        }
      : undefined;
  }

  async listConnections(input: {
    workspaceId: string;
    provider: string;
  }): Promise<
    readonly {
      id: string;
      provider: string;
      accountId?: string;
      displayName?: string;
      scopes: readonly string[];
      status: ConnectionStatus;
      encryptedCredentials: string;
      metadata: Record<string, unknown>;
    }[]
  > {
    const rows = await this.#sql<
      {
        id: string;
        provider: string;
        account_id: string | null;
        display_name: string | null;
        scopes: string[];
        status: ConnectionStatus;
        encrypted_credentials: string | null;
        metadata: Record<string, unknown>;
      }[]
    >`
      select id, provider, account_id, display_name, scopes, status,
        encrypted_credentials, metadata
      from public.connections
      where workspace_id = ${input.workspaceId} and provider = ${input.provider}
        and status = 'active' and encrypted_credentials is not null
      order by updated_at desc
    `;
    return rows.map((row) => ({
      id: row.id,
      provider: row.provider,
      accountId: row.account_id ?? undefined,
      displayName: row.display_name ?? undefined,
      scopes: row.scopes,
      status: row.status,
      encryptedCredentials: row.encrypted_credentials!,
      metadata: row.metadata,
    }));
  }

  async getConnectionById(input: { id: string; workspaceId: string }): Promise<
    | {
        id: string;
        provider: string;
        accountId?: string;
        displayName?: string;
        scopes: readonly string[];
        status: ConnectionStatus;
        encryptedCredentials: string;
        metadata: Record<string, unknown>;
      }
    | undefined
  > {
    const [row] = await this.#sql<
      {
        id: string;
        provider: string;
        account_id: string | null;
        display_name: string | null;
        scopes: string[];
        status: ConnectionStatus;
        encrypted_credentials: string | null;
        metadata: Record<string, unknown>;
      }[]
    >`
      select id, provider, account_id, display_name, scopes, status,
        encrypted_credentials, metadata
      from public.connections
      where id = ${input.id} and workspace_id = ${input.workspaceId}
    `;
    if (!row?.encrypted_credentials) return undefined;
    return {
      id: row.id,
      provider: row.provider,
      accountId: row.account_id ?? undefined,
      displayName: row.display_name ?? undefined,
      scopes: row.scopes,
      status: row.status,
      encryptedCredentials: row.encrypted_credentials,
      metadata: row.metadata,
    };
  }

  async updateConnectionCredentials(input: {
    id: string;
    workspaceId: string;
    encryptedCredentials: string;
    status?: ConnectionStatus;
  }): Promise<void> {
    const result = await this.#sql`
      update public.connections set encrypted_credentials = ${input.encryptedCredentials},
        status = coalesce(${input.status ?? null}, status), updated_at = now()
      where id = ${input.id} and workspace_id = ${input.workspaceId}
      returning id
    `;
    if (result.length !== 1) throw new Error("Connection was not found.");
  }

  async updateConnectionStatus(input: {
    id: string;
    workspaceId: string;
    status: ConnectionStatus;
  }): Promise<void> {
    const result = await this.#sql`
      update public.connections set status = ${input.status}, updated_at = now()
      where id = ${input.id} and workspace_id = ${input.workspaceId}
      returning id
    `;
    if (result.length !== 1) throw new Error("Connection was not found.");
  }

  async upsertConnection(input: {
    id: string;
    workspaceId: string;
    provider: string;
    accountId?: string;
    displayName?: string;
    scopes: readonly string[];
    encryptedCredentials: string;
    status?: ConnectionStatus;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    const status = input.status ?? "active";
    await this.#sql`
      insert into public.connections (
        id, workspace_id, provider, account_id, display_name, scopes, status,
        encrypted_credentials, metadata
      ) values (
        ${input.id}, ${input.workspaceId}, ${input.provider}, ${input.accountId ?? null},
        ${input.displayName ?? null}, ${input.scopes as string[]}, ${status},
        ${input.encryptedCredentials}, ${this.#sql.json(toJson(input.metadata ?? {}))}
      ) on conflict (workspace_id, provider, account_id) do update set
        id = excluded.id, display_name = excluded.display_name, scopes = excluded.scopes,
        status = excluded.status,
        encrypted_credentials = excluded.encrypted_credentials,
        metadata = excluded.metadata, updated_at = now()
    `;
  }

  async decideAction(input: {
    actionId: string;
    workspaceId: string;
    approved: boolean;
    inputHash: string;
    channel: string;
    reason?: string;
  }): Promise<{ runId: string }> {
    const result = await this.#sql.begin(async (tx) => {
      const [action] = await tx<
        {
          run_id: string;
          input_hash: string;
          status: string;
          expires_at: Date;
        }[]
      >`
        select run_id, input_hash, status, expires_at from public.action_requests
        where id = ${input.actionId} and workspace_id = ${input.workspaceId}
        for update
      `;
      if (!action || action.status !== "pending")
        throw new Error("Action is not pending.");
      if (action.expires_at.getTime() <= Date.now()) {
        await tx`update public.action_requests set status = 'expired' where id = ${input.actionId}`;
        return { runId: action.run_id, expired: true as const };
      }
      if (action.input_hash !== input.inputHash)
        throw new Error("Approval payload hash mismatch.");
      await tx`
        insert into public.approvals (
          workspace_id, action_request_id, approved, input_hash, channel, reason
        ) values (
          ${input.workspaceId}, ${input.actionId}, ${input.approved}, ${input.inputHash},
          ${input.channel}, ${input.reason ?? null}
        )
      `;
      await tx`
        update public.action_requests set status = ${input.approved ? "approved" : "denied"}
        where id = ${input.actionId}
      `;
      if (input.approved) {
        await tx`update public.agent_runs set status = 'queued', waiting_for = null where id = ${action.run_id}`;
        await tx`select pgmq.send('agent_jobs', ${tx.json({
          type: "resume_run",
          runId: action.run_id,
          workspaceId: input.workspaceId,
        })}::jsonb)`;
      } else {
        await tx`update public.agent_runs set status = 'cancelled', waiting_for = null where id = ${action.run_id}`;
      }
      return { runId: action.run_id, expired: false as const };
    });
    if (result.expired) throw new Error("Action approval has expired.");
    return { runId: result.runId };
  }

  async claimApprovedAction(runId: string): Promise<ActionRequest | undefined> {
    await this.#sql`
      update public.action_requests set status = 'expired'
      where run_id = ${runId} and status = 'approved' and expires_at <= now()
    `;
    const [row] = await this.#sql<
      {
        id: string;
        workspace_id: string;
        run_id: string;
        tool_name: string;
        risk: ActionRequest["risk"];
        summary: string;
        input: Record<string, unknown>;
        input_hash: string;
        status: ActionRequest["status"];
        expires_at: Date;
      }[]
    >`
      update public.action_requests set status = 'executing'
      where id = (
        select id from public.action_requests
        where run_id = ${runId} and status = 'approved' and expires_at > now()
        order by created_at asc limit 1
        for update skip locked
      )
      returning id, workspace_id, run_id, tool_name, risk, summary, input, input_hash,
        status, expires_at
    `;
    if (!row) return;
    if (payloadHash(row.input) !== row.input_hash) {
      await this.markActionFailed(row.id);
      throw new Error("Approved action payload no longer matches its hash.");
    }
    return actionRequestSchema.parse({
      id: row.id,
      workspaceId: row.workspace_id,
      runId: row.run_id,
      toolName: row.tool_name,
      risk: row.risk,
      summary: row.summary,
      input: row.input,
      inputHash: row.input_hash,
      status: row.status,
      expiresAt: row.expires_at.toISOString(),
    });
  }

  async markActionExecuted(actionId: string): Promise<void> {
    const result = await this.#sql`
      update public.action_requests set status = 'executed'
      where id = ${actionId} and status = 'executing' returning id
    `;
    if (result.length !== 1)
      throw new Error("Action execution state changed unexpectedly.");
  }

  async markActionFailed(actionId: string): Promise<void> {
    await this.#sql`
      update public.action_requests set status = 'failed'
      where id = ${actionId} and status = 'executing'
    `;
  }

  async markActionUnknown(actionId: string): Promise<void> {
    await this.#sql`
      update public.action_requests set status = 'unknown'
      where id = ${actionId} and status = 'executing'
    `;
  }

  async searchMemories(input: {
    workspaceId: string;
    query?: string;
    limit?: number;
  }): Promise<
    readonly {
      id: string;
      kind: string;
      content: string;
      confidence: number;
      sensitivity: string;
      updatedAt: string;
    }[]
  > {
    const limit = Math.min(input.limit ?? 20, 50);
    const pattern = `%${input.query?.trim() ?? ""}%`;
    const rows = await this.#sql<
      {
        id: string;
        kind: string;
        content: string;
        confidence: number;
        sensitivity: string;
        updated_at: Date;
      }[]
    >`
      select id, kind, content, confidence, sensitivity, updated_at
      from public.memories
      where workspace_id = ${input.workspaceId}
        and (expires_at is null or expires_at > now())
        and content ilike ${pattern}
      order by confirmed_at desc nulls last, updated_at desc
      limit ${limit}
    `;
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      content: row.content,
      confidence: row.confidence,
      sensitivity: row.sensitivity,
      updatedAt: row.updated_at.toISOString(),
    }));
  }

  async saveMemory(input: {
    id: string;
    workspaceId: string;
    kind: "profile" | "episodic" | "commitment" | "open_loop" | "preference";
    content: string;
    sensitivity: "public" | "personal" | "sensitive";
    sourceId: string;
  }): Promise<void> {
    await this.#sql`
      insert into public.memories (
        id, workspace_id, kind, content, source_type, source_id,
        confidence, sensitivity, confirmed_at
      ) values (
        ${input.id}, ${input.workspaceId}, ${input.kind}, ${input.content},
        'owner_approved', ${input.sourceId}, 1, ${input.sensitivity}, now()
      ) on conflict (id) do nothing
    `;
  }

  async deleteMemory(input: {
    workspaceId: string;
    memoryId: string;
  }): Promise<void> {
    const deleted = await this.#sql`
      delete from public.memories
      where id = ${input.memoryId} and workspace_id = ${input.workspaceId}
      returning id
    `;
    if (deleted.length !== 1) throw new Error("Memory was not found.");
  }

  async listScheduledTriggers(input: {
    workspaceId: string;
    limit?: number;
  }): Promise<
    readonly {
      id: string;
      kind: string;
      payload: Record<string, unknown>;
      runAt: string;
      recurrenceSeconds?: number;
      status: string;
    }[]
  > {
    const rows = await this.#sql<
      {
        id: string;
        kind: string;
        payload: Record<string, unknown>;
        run_at: Date;
        recurrence_seconds: string | number | null;
        status: string;
      }[]
    >`
      select id, kind, payload, run_at, recurrence_seconds, status
      from public.scheduled_triggers
      where workspace_id = ${input.workspaceId} and status in ('scheduled', 'queued')
      order by run_at asc limit ${Math.min(input.limit ?? 20, 50)}
    `;
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      payload: row.payload,
      runAt: row.run_at.toISOString(),
      recurrenceSeconds:
        row.recurrence_seconds === null
          ? undefined
          : Number(row.recurrence_seconds),
      status: row.status,
    }));
  }

  async listBrowserProfiles(workspaceId: string): Promise<
    readonly {
      id: string;
      provider: string;
      providerProfileId: string;
      label: string;
    }[]
  > {
    const rows = await this.#sql<
      {
        id: string;
        provider: string;
        provider_profile_id: string;
        label: string;
      }[]
    >`
      select id, provider, provider_profile_id, label
      from public.browser_profiles
      where workspace_id = ${workspaceId}
      order by label asc limit 50
    `;
    return rows.map((row) => ({
      id: row.id,
      provider: row.provider,
      providerProfileId: row.provider_profile_id,
      label: row.label,
    }));
  }

  async createScheduledTrigger(input: {
    id: string;
    workspaceId: string;
    kind: "reminder" | "routine";
    payload: Record<string, unknown>;
    runAt: string;
    recurrenceSeconds?: number;
  }): Promise<void> {
    await this.#sql`
      insert into public.scheduled_triggers (
        id, workspace_id, kind, payload, run_at, recurrence_seconds
      ) values (
        ${input.id}, ${input.workspaceId}, ${input.kind},
        ${this.#sql.json(toJson(input.payload))}, ${new Date(input.runAt)},
        ${input.recurrenceSeconds ?? null}
      ) on conflict (id) do nothing
    `;
  }

  async cancelScheduledTrigger(input: {
    workspaceId: string;
    triggerId: string;
  }): Promise<void> {
    const updated = await this.#sql`
      update public.scheduled_triggers
      set status = 'cancelled', completed_at = now()
      where id = ${input.triggerId} and workspace_id = ${input.workspaceId}
        and status in ('scheduled', 'queued')
      returning id
    `;
    if (updated.length !== 1) throw new Error("Active schedule was not found.");
  }

  async isScheduledTriggerCancelled(input: {
    workspaceId: string;
    triggerId: string;
  }): Promise<boolean> {
    const [row] = await this.#sql<{ status: string }[]>`
      select status from public.scheduled_triggers
      where id = ${input.triggerId} and workspace_id = ${input.workspaceId}
    `;
    return !row || row.status === "cancelled";
  }

  async dispatchDueSchedules(limit = 20): Promise<number> {
    return this.#sql.begin(async (tx) => {
      const rows = await tx<
        {
          id: string;
          workspace_id: string;
          kind: string;
          payload: Record<string, unknown>;
          run_at: Date;
          recurrence_seconds: string | number | null;
        }[]
      >`
        select id, workspace_id, kind, payload, run_at, recurrence_seconds
        from public.scheduled_triggers
        where status = 'scheduled' and run_at <= now()
        order by run_at asc limit ${Math.min(limit, 100)}
        for update skip locked
      `;
      for (const row of rows) {
        const conversationId = row.payload.conversationId;
        if (typeof conversationId !== "string") {
          await tx`update public.scheduled_triggers set status = 'cancelled', completed_at = now() where id = ${row.id}`;
          continue;
        }
        const occurrenceAt = row.run_at.toISOString();
        if (row.kind === "reminder") {
          const message = row.payload.message;
          if (typeof message !== "string" || !message.trim()) {
            await tx`update public.scheduled_triggers set status = 'cancelled', completed_at = now() where id = ${row.id}`;
            continue;
          }
          await tx`select pgmq.send('agent_jobs', ${tx.json(
            toJson({
              type: "deliver_reminder",
              triggerId: row.id,
              occurrenceAt,
              workspaceId: row.workspace_id,
              conversationId,
              message,
            }),
          )}::jsonb)`;
        } else if (row.kind === "routine") {
          const prompt = row.payload.prompt;
          if (typeof prompt !== "string" || !prompt.trim()) {
            await tx`update public.scheduled_triggers set status = 'cancelled', completed_at = now() where id = ${row.id}`;
            continue;
          }
          const eventId = `schedule:${row.id}:${occurrenceAt}`;
          await tx`
            insert into public.inbound_events (id, workspace_id, source, type, occurred_at, payload)
            values (${eventId}, ${row.workspace_id}, 'schedule', 'routine.due', ${row.run_at}, ${tx.json(toJson({ triggerId: row.id, prompt }))})
          `;
          await tx`
            insert into public.messages (
              workspace_id, conversation_id, provider_message_id, role, direction, content, status
            ) values (
              ${row.workspace_id}, ${conversationId}, ${eventId}, 'user', 'inbound', ${prompt}, 'scheduled'
            )
          `;
          const runId = randomUUID();
          await tx`
            insert into public.agent_runs (id, workspace_id, conversation_id, trigger_event_id, status)
            values (${runId}, ${row.workspace_id}, ${conversationId}, ${eventId}, 'queued')
          `;
          await tx`select pgmq.send('agent_jobs', ${tx.json(
            toJson({
              type: "process_event",
              eventId,
              runId,
              workspaceId: row.workspace_id,
            }),
          )}::jsonb)`;
        }
        const recurrence =
          row.recurrence_seconds === null
            ? undefined
            : Number(row.recurrence_seconds);
        if (recurrence) {
          let next = new Date(row.run_at.getTime() + recurrence * 1000);
          while (next.getTime() <= Date.now())
            next = new Date(next.getTime() + recurrence * 1000);
          await tx`update public.scheduled_triggers set run_at = ${next}, status = 'scheduled' where id = ${row.id}`;
        } else {
          await tx`update public.scheduled_triggers set status = 'completed', completed_at = now() where id = ${row.id}`;
        }
      }
      return rows.length;
    });
  }
}

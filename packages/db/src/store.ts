import { randomUUID } from "node:crypto";
import postgres, { type Sql } from "postgres";
import {
  actionRequestSchema,
  normalizeJsonValue,
  payloadHash,
  structuredToolResultSchema,
  type ActionRequest,
  type RunEventType,
  type StructuredToolResult,
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
  return normalizeJsonValue(value) as JsonValue;
}

function durableToolResultHash(result: StructuredToolResult): string {
  return payloadHash({
    workspaceId: result.workspaceId,
    runId: result.runId,
    stepId: result.stepId,
    ...(result.actionRequestId
      ? { actionRequestId: result.actionRequestId }
      : {}),
    ...(result.reconcilesResultId
      ? { reconcilesResultId: result.reconcilesResultId }
      : {}),
    toolName: result.toolName,
    certainty: result.certainty,
    attempt: result.attempt,
    ...(result.output === undefined ? {} : { output: result.output }),
    ...(result.outputHash ? { outputHash: result.outputHash } : {}),
    ...(result.errorCode ? { errorCode: result.errorCode } : {}),
    ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
    retryEligible: result.retryEligible,
    startedAt: result.startedAt,
    completedAt: result.completedAt,
  });
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
  readonly claimToken: string;
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly ownerPhone: string;
  readonly messages: readonly { role: "user" | "assistant"; content: string }[];
  readonly toolResults: readonly StructuredToolResult[];
}

export interface ClaimedActionExecution {
  readonly action: ActionRequest;
  readonly stepId: string;
  readonly attempt: number;
  readonly startedAt: string;
}

export type RunClaimStage =
  | { readonly type: "process_event"; readonly workspaceId: string }
  | {
      readonly type: "resume_run";
      readonly workspaceId: string;
      readonly actionId: string;
    }
  | {
      readonly type: "continue_run";
      readonly workspaceId: string;
      readonly toolResultId: string;
    };

export type ConnectionStatus =
  | "pending"
  | "active"
  | "expired"
  | "revoked"
  | "error";

export class RunNotClaimableError extends Error {
  override readonly name = "RunNotClaimableError";

  constructor(
    message: string,
    readonly retryable: boolean,
    readonly retryAfterSeconds = 30,
  ) {
    super(message);
  }
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

  async #appendRunEvent(
    sql: Sql | postgres.TransactionSql,
    input: {
      workspaceId: string;
      runId: string;
      eventType: RunEventType;
      eventKey: string;
      payload?: Record<string, unknown>;
      stepId?: string;
      actionRequestId?: string;
      toolResultId?: string;
    },
  ): Promise<void> {
    const payload = input.payload ?? {};
    const inserted = await sql`
      insert into public.run_events (
        workspace_id, run_id, step_id, action_request_id, tool_result_id,
        event_type, event_key, payload, payload_hash
      ) values (
        ${input.workspaceId}, ${input.runId}, ${input.stepId ?? null},
        ${input.actionRequestId ?? null}, ${input.toolResultId ?? null},
        ${input.eventType}, ${input.eventKey}, ${sql.json(toJson(payload))},
        ${payloadHash(payload)}
      ) on conflict (run_id, event_key) do nothing
      returning id
    `;
    if (inserted.length === 0) {
      const [existing] = await sql<
        {
          workspace_id: string;
          step_id: string | null;
          action_request_id: string | null;
          tool_result_id: string | null;
          event_type: string;
          payload_hash: string;
        }[]
      >`
        select workspace_id, step_id, action_request_id, tool_result_id,
          event_type, payload_hash from public.run_events
        where run_id = ${input.runId} and event_key = ${input.eventKey}
      `;
      if (
        !existing ||
        existing.workspace_id !== input.workspaceId ||
        existing.step_id !== (input.stepId ?? null) ||
        existing.action_request_id !== (input.actionRequestId ?? null) ||
        existing.tool_result_id !== (input.toolResultId ?? null) ||
        existing.event_type !== input.eventType ||
        existing.payload_hash !== payloadHash(payload)
      )
        throw new Error("Conflicting run event idempotency key.");
    }
  }

  async #writeAuditEvent(
    sql: Sql | postgres.TransactionSql,
    input: {
      workspaceId: string;
      actor: string;
      action: string;
      eventKey: string;
      detail?: Record<string, unknown>;
      targetType?: string;
      targetId?: string;
      runId?: string;
      stepId?: string;
      actionRequestId?: string;
    },
  ): Promise<void> {
    const detail = input.detail ?? {};
    const inserted = await sql`
      insert into public.audit_events (
        workspace_id, actor, action, target_type, target_id, detail,
        run_id, workflow_step_id, action_request_id, event_key, detail_hash
      ) values (
        ${input.workspaceId}, ${input.actor}, ${input.action},
        ${input.targetType ?? null}, ${input.targetId ?? null},
        ${sql.json(toJson(detail))}, ${input.runId ?? null},
        ${input.stepId ?? null}, ${input.actionRequestId ?? null},
        ${input.eventKey}, ${payloadHash(detail)}
      ) on conflict (workspace_id, event_key) do nothing
      returning id
    `;
    if (inserted.length === 0) {
      const [existing] = await sql<
        {
          actor: string;
          action: string;
          target_type: string | null;
          target_id: string | null;
          run_id: string | null;
          workflow_step_id: string | null;
          action_request_id: string | null;
          detail_hash: string;
        }[]
      >`
        select actor, action, target_type, target_id, run_id,
          workflow_step_id, action_request_id, detail_hash
        from public.audit_events
        where workspace_id = ${input.workspaceId}
          and event_key = ${input.eventKey}
      `;
      if (
        !existing ||
        existing.actor !== input.actor ||
        existing.action !== input.action ||
        existing.target_type !== (input.targetType ?? null) ||
        existing.target_id !== (input.targetId ?? null) ||
        existing.run_id !== (input.runId ?? null) ||
        existing.workflow_step_id !== (input.stepId ?? null) ||
        existing.action_request_id !== (input.actionRequestId ?? null) ||
        existing.detail_hash !== payloadHash(detail)
      )
        throw new Error("Conflicting audit event idempotency key.");
    }
  }

  async #persistToolResultProjection(
    sql: Sql | postgres.TransactionSql,
    rawResult: StructuredToolResult,
    claimToken?: string,
  ): Promise<boolean> {
    const result = structuredToolResultSchema.parse(rawResult);
    const resultHash = durableToolResultHash(result);
    const inserted = await sql`
      insert into public.tool_results (
        id, workspace_id, run_id, step_id, action_request_id,
        reconciles_result_id, tool_name,
        certainty, attempt, output, output_hash, error_code, error_message,
        retry_eligible, result_hash, started_at, completed_at
      ) values (
        ${result.id}, ${result.workspaceId}, ${result.runId}, ${result.stepId},
        ${result.actionRequestId ?? null}, ${result.reconcilesResultId ?? null},
        ${result.toolName}, ${result.certainty},
        ${result.attempt},
        ${result.output === undefined ? null : sql.json(toJson(result.output))},
        ${result.outputHash ?? null}, ${result.errorCode ?? null},
        ${result.errorMessage ?? null}, ${result.retryEligible}, ${resultHash},
        ${new Date(result.startedAt)},
        ${new Date(result.completedAt)}
      ) on conflict do nothing
      returning id
    `;
    if (inserted.length === 0) {
      const [existing] = await sql<{ result_hash: string }[]>`
        select result_hash from public.tool_results
        where (
          ${result.actionRequestId ?? null}::uuid is not null
          and action_request_id = ${result.actionRequestId ?? null}
        ) or (
          ${result.actionRequestId ?? null}::uuid is null
          and step_id = ${result.stepId} and attempt = ${result.attempt}
        )
      `;
      if (!existing || existing.result_hash !== resultHash)
        throw new Error("Conflicting result already exists for this action.");
      return false;
    }

    const actionStatus = ["succeeded", "reconciled_succeeded"].includes(
      result.certainty,
    )
      ? "executed"
      : result.certainty === "unknown"
        ? "unknown"
        : "failed";
    const stepStatus = ["succeeded", "reconciled_succeeded"].includes(
      result.certainty,
    )
      ? "succeeded"
      : result.certainty === "unknown"
        ? "unknown"
        : "failed";

    if (result.actionRequestId) {
      const actionUpdate = await sql`
        update public.action_requests set status = ${actionStatus}
        where id = ${result.actionRequestId} and workspace_id = ${result.workspaceId}
          and status = 'executing'
        returning id
      `;
      if (actionUpdate.length !== 1)
        throw new Error(
          "Action execution state changed before result persistence.",
        );
    }
    const stepUpdate = await sql`
      update public.workflow_steps
      set status = ${stepStatus}, execution_phase = 'result_persisted',
        completed_at = ${new Date(result.completedAt)}
      where id = ${result.stepId} and workspace_id = ${result.workspaceId}
        and status = 'running' and attempt = ${result.attempt}
      returning id
    `;
    if (stepUpdate.length !== 1)
      throw new Error("Workflow step changed before result persistence.");
    const runUpdate = await sql`
      update public.agent_runs set status = 'queued', waiting_for = null
        , claim_token = null, lease_expires_at = null
      where id = ${result.runId} and workspace_id = ${result.workspaceId}
        and (
          (${result.reconcilesResultId ?? null}::uuid is not null
            and status in ('queued', 'running', 'failed', 'completed'))
          or (${result.reconcilesResultId ?? null}::uuid is null
            and status in ('running', 'failed')
            and (${claimToken ?? null}::uuid is null or claim_token = ${claimToken ?? null}))
        )
      returning id
    `;
    if (runUpdate.length !== 1)
      throw new Error("Run changed before result persistence.");
    await this.#appendRunEvent(sql, {
      workspaceId: result.workspaceId,
      runId: result.runId,
      stepId: result.stepId,
      actionRequestId: result.actionRequestId,
      toolResultId: result.id,
      eventType: "tool_result_recorded",
      eventKey: `result:${result.id}:recorded`,
      payload: {
        certainty: result.certainty,
        attempt: result.attempt,
        retryEligible: result.retryEligible,
        ...(result.outputHash ? { outputHash: result.outputHash } : {}),
        ...(result.errorCode ? { errorCode: result.errorCode } : {}),
      },
    });
    await this.#writeAuditEvent(sql, {
      workspaceId: result.workspaceId,
      actor: "worker",
      action:
        result.certainty === "unknown"
          ? "execution.unknown"
          : "execution.finished",
      eventKey: `result:${result.id}:recorded`,
      targetType: "tool_result",
      targetId: result.id,
      runId: result.runId,
      stepId: result.stepId,
      actionRequestId: result.actionRequestId,
      detail: {
        certainty: result.certainty,
        attempt: result.attempt,
        retryEligible: result.retryEligible,
        ...(result.outputHash ? { outputHash: result.outputHash } : {}),
        ...(result.errorCode ? { errorCode: result.errorCode } : {}),
      },
    });
    return true;
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
      await this.#appendRunEvent(tx, {
        workspaceId: owner.workspace_id,
        runId,
        eventType: "run_created",
        eventKey: "run_created",
        payload: { source: "blooio", triggerEventId: event.id },
      });
      await this.#writeAuditEvent(tx, {
        workspaceId: owner.workspace_id,
        actor: "system",
        action: "run.created",
        eventKey: `run:${runId}:created`,
        targetType: "agent_run",
        targetId: runId,
        runId,
        detail: { source: "blooio", triggerEventId: event.id },
      });
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

  async getRunContext(
    runId: string,
    claimToken: string,
    stage: RunClaimStage,
    leaseSeconds = 600,
  ): Promise<RunContext> {
    const run = await this.#sql.begin(async (tx) => {
      const [claimed] = await tx<
        {
          workspace_id: string;
          conversation_id: string;
          phone_e164: string;
          attempt: number;
          claim_token: string;
        }[]
      >`
        update public.agent_runs r set status = 'running', attempt = attempt + 1,
          started_at = coalesce(started_at, now()), last_error = null,
          claim_token = ${claimToken},
          lease_expires_at = now() + make_interval(secs => ${leaseSeconds})
        from public.owner_phone_numbers p
        where r.id = ${runId} and p.workspace_id = r.workspace_id
          and r.workspace_id = ${stage.workspaceId}
          and (
            r.status in ('queued', 'failed')
            or (r.status = 'running' and r.lease_expires_at <= now())
          )
          and (
            (${stage.type} = 'process_event' and not exists (
              select 1 from public.action_requests a where a.run_id = r.id
            ) and not exists (
              select 1 from public.tool_results tr where tr.run_id = r.id
            ))
            or (${stage.type} = 'resume_run' and exists (
              select 1 from public.action_requests a
              where a.run_id = r.id and a.workspace_id = r.workspace_id
                and a.id = ${stage.type === "resume_run" ? stage.actionId : null}::uuid
                and a.status = 'approved'
            ))
            or (${stage.type} = 'continue_run' and exists (
              select 1 from public.tool_results tr
              where tr.run_id = r.id and tr.workspace_id = r.workspace_id
                and tr.id = ${stage.type === "continue_run" ? stage.toolResultId : null}::uuid
                and tr.continuation_status = 'enqueued'
            ))
          )
        returning r.workspace_id, r.conversation_id, p.phone_e164, r.attempt,
          r.claim_token
      `;
      if (!claimed) return;
      await this.#appendRunEvent(tx, {
        workspaceId: claimed.workspace_id,
        runId,
        eventType: "run_started",
        eventKey: `run_started:${claimed.attempt}`,
        payload: { attempt: claimed.attempt },
      });
      await this.#writeAuditEvent(tx, {
        workspaceId: claimed.workspace_id,
        actor: "worker",
        action: "run.started",
        eventKey: `run:${runId}:started:${claimed.attempt}`,
        targetType: "agent_run",
        targetId: runId,
        runId,
        detail: { attempt: claimed.attempt },
      });
      return claimed;
    });
    if (!run) {
      const [current] = await this.#sql<
        { status: string; lease_expires_at: Date | null }[]
      >`
        select status, lease_expires_at from public.agent_runs
        where id = ${runId} and workspace_id = ${stage.workspaceId}
      `;
      const retryable = Boolean(
        current?.status === "running" &&
          current.lease_expires_at &&
          current.lease_expires_at.getTime() > Date.now(),
      );
      throw new RunNotClaimableError(
        retryable
          ? "Run is actively leased by another worker."
          : "Run is not claimable for this durable job stage.",
        retryable,
      );
    }
    const messages = await this.#sql<
      { role: "user" | "assistant"; content: string }[]
    >`
      select role, content from (
        select role, content, created_at from public.messages
        where conversation_id = ${run.conversation_id} and role in ('user', 'assistant')
        order by created_at desc limit 50
      ) recent order by created_at asc
    `;
    const resultRows = await this.#sql<
      {
        id: string;
        workspace_id: string;
        run_id: string;
        step_id: string;
        action_request_id: string | null;
        reconciles_result_id: string | null;
        tool_name: string;
        certainty: StructuredToolResult["certainty"];
        attempt: number;
        output: unknown | null;
        has_output: boolean;
        output_hash: string | null;
        error_code: string | null;
        error_message: string | null;
        retry_eligible: boolean;
        started_at: Date;
        completed_at: Date;
      }[]
    >`
      select id, workspace_id, run_id, step_id, action_request_id,
        reconciles_result_id, tool_name,
        certainty, attempt, output, output is not null as has_output,
        output_hash, error_code, error_message,
        retry_eligible, started_at, completed_at
      from public.tool_results
      where run_id = ${runId}
      order by created_at desc limit 5
    `;
    return {
      runId,
      claimToken: run.claim_token,
      workspaceId: run.workspace_id,
      conversationId: run.conversation_id,
      ownerPhone: run.phone_e164,
      messages,
      toolResults: resultRows.reverse().map((row) =>
        structuredToolResultSchema.parse({
          id: row.id,
          workspaceId: row.workspace_id,
          runId: row.run_id,
          stepId: row.step_id,
          actionRequestId: row.action_request_id ?? undefined,
          reconcilesResultId: row.reconciles_result_id ?? undefined,
          toolName: row.tool_name,
          certainty: row.certainty,
          attempt: row.attempt,
          ...(row.has_output ? { output: row.output } : {}),
          outputHash: row.output_hash ?? undefined,
          errorCode: row.error_code ?? undefined,
          errorMessage: row.error_message ?? undefined,
          retryEligible: row.retry_eligible,
          startedAt: row.started_at.toISOString(),
          completedAt: row.completed_at.toISOString(),
        }),
      ),
    };
  }

  async saveAssistantMessage(input: {
    workspaceId: string;
    conversationId: string;
    content: string;
    providerMessageId?: string;
    status?: string;
  }): Promise<void> {
    const inserted = await this.#sql`
      insert into public.messages (
        workspace_id, conversation_id, provider_message_id, role, direction, content, status
      ) values (
        ${input.workspaceId}, ${input.conversationId}, ${input.providerMessageId ?? null},
        'assistant', 'outbound', ${input.content}, ${input.status ?? null}
      ) on conflict (workspace_id, provider_message_id) do nothing
      returning id
    `;
    if (inserted.length === 0 && input.providerMessageId) {
      const [existing] = await this.#sql<
        { conversation_id: string; content: string }[]
      >`
        select conversation_id, content from public.messages
        where workspace_id = ${input.workspaceId}
          and provider_message_id = ${input.providerMessageId}
      `;
      if (
        !existing ||
        existing.conversation_id !== input.conversationId ||
        existing.content !== input.content
      )
        throw new Error("Conflicting outbound message idempotency key.");
    }
  }

  async completeRun(input: {
    runId: string;
    claimToken: string;
    inputTokens?: number;
    outputTokens?: number;
    model?: string;
  }): Promise<void> {
    await this.#sql.begin(async (tx) => {
      const [run] = await tx<{ workspace_id: string; attempt: number }[]>`
        update public.agent_runs set status = 'completed', completed_at = now(),
          input_tokens = ${input.inputTokens ?? 0}, output_tokens = ${input.outputTokens ?? 0},
          model = ${input.model ?? null}, waiting_for = null,
          claim_token = null, lease_expires_at = null
        where id = ${input.runId} and status = 'running'
          and claim_token = ${input.claimToken}
        returning workspace_id, attempt
      `;
      if (!run) return;
      await this.#appendRunEvent(tx, {
        workspaceId: run.workspace_id,
        runId: input.runId,
        eventType: "run_completed",
        eventKey: "run_completed",
        payload: { attempt: run.attempt },
      });
      await this.#writeAuditEvent(tx, {
        workspaceId: run.workspace_id,
        actor: "worker",
        action: "run.completed",
        eventKey: `run:${input.runId}:completed`,
        targetType: "agent_run",
        targetId: input.runId,
        runId: input.runId,
        detail: { attempt: run.attempt },
      });
    });
  }

  async failRun(
    runId: string,
    error: string,
    claimToken: string,
  ): Promise<void> {
    await this.#sql.begin(async (tx) => {
      const [run] = await tx<{ workspace_id: string; attempt: number }[]>`
        update public.agent_runs set status = 'failed', last_error = ${error.slice(0, 2000)},
          claim_token = null, lease_expires_at = null
        where id = ${runId} and status = 'running'
          and claim_token = ${claimToken}
        returning workspace_id, attempt
      `;
      if (!run) return;
      await this.#appendRunEvent(tx, {
        workspaceId: run.workspace_id,
        runId,
        eventType: "run_failed",
        eventKey: `run_failed:${run.attempt}`,
        payload: { attempt: run.attempt, errorCode: "job_failed" },
      });
      await this.#writeAuditEvent(tx, {
        workspaceId: run.workspace_id,
        actor: "worker",
        action: "run.failed",
        eventKey: `run:${runId}:failed:${run.attempt}`,
        targetType: "agent_run",
        targetId: runId,
        runId,
        detail: { attempt: run.attempt, errorCode: "job_failed" },
      });
    });
  }

  async releaseRunClaim(runId: string, claimToken: string): Promise<void> {
    await this.#sql`
      update public.agent_runs set status = 'queued', claim_token = null,
        lease_expires_at = null
      where id = ${runId} and status = 'running'
        and claim_token = ${claimToken}
    `;
  }

  async renewRunLease(
    runId: string,
    claimToken: string,
    leaseSeconds = 600,
  ): Promise<void> {
    const updated = await this.#sql`
      update public.agent_runs
      set lease_expires_at = now() + make_interval(secs => ${leaseSeconds})
      where id = ${runId} and status = 'running'
        and claim_token = ${claimToken}
      returning id
    `;
    if (updated.length !== 1)
      throw new RunNotClaimableError(
        "Run lease was lost before provider invocation.",
        false,
      );
  }

  async saveActionRequest(
    action: ActionRequest,
    claimToken?: string,
  ): Promise<void> {
    const value = actionRequestSchema.parse(action);
    await this.#sql.begin(async (tx) => {
      const [run] = await tx<{ status: string }[]>`
        select status from public.agent_runs
        where id = ${value.runId} and workspace_id = ${value.workspaceId}
          and (${claimToken ?? null}::uuid is null or claim_token = ${claimToken ?? null})
        for update
      `;
      if (!run || run.status !== "running")
        throw new Error("Run cannot wait for this action.");
      await tx`
        insert into public.action_requests (
          id, workspace_id, run_id, tool_name, risk, summary, input, input_hash, status, expires_at
        ) values (
          ${value.id}, ${value.workspaceId}, ${value.runId}, ${value.toolName}, ${value.risk},
          ${value.summary}, ${tx.json(toJson(value.input))}, ${value.inputHash}, ${value.status},
          ${new Date(value.expiresAt)}
        )
      `;
      const [step] = await tx<{ id: string; position: number }[]>`
        insert into public.workflow_steps (
          id, workspace_id, run_id, action_request_id, position, kind,
          tool_name, status, input, input_hash
        )
        select ${value.id}, ${value.workspaceId}, ${value.runId}, ${value.id},
          coalesce(max(position) + 1, 0), 'action', ${value.toolName},
          'waiting_approval', ${tx.json(toJson(value.input))}, ${value.inputHash}
        from public.workflow_steps where run_id = ${value.runId}
        returning id, position
      `;
      if (!step) throw new Error("Could not create workflow step.");
      const updated = await tx`
        update public.agent_runs set status = 'waiting_approval', waiting_for = ${value.id},
          claim_token = null, lease_expires_at = null
        where id = ${value.runId} and workspace_id = ${value.workspaceId}
          and status = 'running'
          and (${claimToken ?? null}::uuid is null or claim_token = ${claimToken ?? null})
        returning id
      `;
      if (updated.length !== 1)
        throw new Error("Run cannot wait for this action.");
      await this.#appendRunEvent(tx, {
        workspaceId: value.workspaceId,
        runId: value.runId,
        stepId: step.id,
        actionRequestId: value.id,
        eventType: "action_proposed",
        eventKey: `action:${value.id}:proposed`,
        payload: {
          toolName: value.toolName,
          risk: value.risk,
          inputHash: value.inputHash,
          position: step.position,
        },
      });
      await this.#writeAuditEvent(tx, {
        workspaceId: value.workspaceId,
        actor: "agent",
        action: "action.proposed",
        eventKey: `action:${value.id}:proposed`,
        targetType: "action_request",
        targetId: value.id,
        runId: value.runId,
        stepId: step.id,
        actionRequestId: value.id,
        detail: {
          toolName: value.toolName,
          risk: value.risk,
          inputHash: value.inputHash,
        },
      });
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
        const [step] = await tx<{ id: string }[]>`
          update public.workflow_steps set status = 'cancelled', completed_at = now()
          where action_request_id = ${input.actionId}
          returning id
        `;
        await tx`
          update public.agent_runs set status = 'failed', waiting_for = null,
            last_error = 'Action approval expired.'
          where id = ${action.run_id} and status = 'waiting_approval'
        `;
        await this.#appendRunEvent(tx, {
          workspaceId: input.workspaceId,
          runId: action.run_id,
          stepId: step?.id,
          actionRequestId: input.actionId,
          eventType: "approval_decided",
          eventKey: `action:${input.actionId}:approval_expired`,
          payload: { approved: false, expired: true, channel: input.channel },
        });
        await this.#writeAuditEvent(tx, {
          workspaceId: input.workspaceId,
          actor: "system",
          action: "approval.expired",
          eventKey: `action:${input.actionId}:approval_expired`,
          targetType: "action_request",
          targetId: input.actionId,
          runId: action.run_id,
          stepId: step?.id,
          actionRequestId: input.actionId,
          detail: { channel: input.channel },
        });
        await this.#appendRunEvent(tx, {
          workspaceId: input.workspaceId,
          runId: action.run_id,
          stepId: step?.id,
          actionRequestId: input.actionId,
          eventType: "run_failed",
          eventKey: "run_failed:approval_expired",
          payload: { errorCode: "approval_expired" },
        });
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
        const runUpdate = await tx`
          update public.agent_runs set status = 'queued', waiting_for = null
          where id = ${action.run_id} and workspace_id = ${input.workspaceId}
            and status = 'waiting_approval' and waiting_for = ${input.actionId}
          returning id
        `;
        if (runUpdate.length !== 1)
          throw new Error("Run is no longer waiting for this approval.");
        await tx`select pgmq.send('agent_jobs', ${tx.json({
          type: "resume_run",
          runId: action.run_id,
          workspaceId: input.workspaceId,
          actionId: input.actionId,
        })}::jsonb)`;
      } else {
        await tx`
          update public.workflow_steps set status = 'cancelled', completed_at = now()
          where action_request_id = ${input.actionId}
        `;
        const runUpdate = await tx`
          update public.agent_runs set status = 'cancelled', waiting_for = null
          where id = ${action.run_id} and workspace_id = ${input.workspaceId}
            and status = 'waiting_approval' and waiting_for = ${input.actionId}
          returning id
        `;
        if (runUpdate.length !== 1)
          throw new Error("Run is no longer waiting for this approval.");
      }
      const [step] = await tx<{ id: string }[]>`
        select id from public.workflow_steps where action_request_id = ${input.actionId}
      `;
      await this.#appendRunEvent(tx, {
        workspaceId: input.workspaceId,
        runId: action.run_id,
        stepId: step?.id,
        actionRequestId: input.actionId,
        eventType: "approval_decided",
        eventKey: `action:${input.actionId}:approval`,
        payload: {
          approved: input.approved,
          channel: input.channel,
          inputHash: input.inputHash,
        },
      });
      await this.#writeAuditEvent(tx, {
        workspaceId: input.workspaceId,
        actor: "owner",
        action: input.approved ? "approval.approved" : "approval.denied",
        eventKey: `action:${input.actionId}:approval`,
        targetType: "action_request",
        targetId: input.actionId,
        runId: action.run_id,
        stepId: step?.id,
        actionRequestId: input.actionId,
        detail: { channel: input.channel, inputHash: input.inputHash },
      });
      if (!input.approved)
        await this.#appendRunEvent(tx, {
          workspaceId: input.workspaceId,
          runId: action.run_id,
          stepId: step?.id,
          actionRequestId: input.actionId,
          eventType: "run_cancelled",
          eventKey: "run_cancelled:approval_denied",
          payload: { reason: "approval_denied" },
        });
      return { runId: action.run_id, expired: false as const };
    });
    if (result.expired) throw new Error("Action approval has expired.");
    return { runId: result.runId };
  }

  async claimApprovedAction(
    runId: string,
    actionId: string,
    claimToken: string,
  ): Promise<ClaimedActionExecution | undefined> {
    const expired = await this.#sql.begin(async (tx) => {
      const [action] = await tx<{ id: string; workspace_id: string }[]>`
        update public.action_requests set status = 'expired'
        where run_id = ${runId}
          and id = ${actionId}
          and status = 'approved' and expires_at <= now()
          and exists (
            select 1 from public.agent_runs r where r.id = ${runId}
              and r.status = 'running'
              and r.claim_token = ${claimToken}
          )
        returning id, workspace_id
      `;
      if (!action) return false;
      const [step] = await tx<{ id: string }[]>`
        update public.workflow_steps set status = 'cancelled', completed_at = now()
        where action_request_id = ${action.id}
        returning id
      `;
      await tx`
        update public.agent_runs set status = 'failed', waiting_for = null,
          last_error = 'Approved action expired before execution.'
        where id = ${runId} and workspace_id = ${action.workspace_id}
          and status = 'running'
          and claim_token = ${claimToken}
      `;
      await this.#appendRunEvent(tx, {
        workspaceId: action.workspace_id,
        runId,
        stepId: step?.id,
        actionRequestId: action.id,
        eventType: "run_failed",
        eventKey: "run_failed:approved_action_expired",
        payload: { errorCode: "approved_action_expired" },
      });
      await this.#writeAuditEvent(tx, {
        workspaceId: action.workspace_id,
        actor: "system",
        action: "approval.expired",
        eventKey: `action:${action.id}:expired_before_execution`,
        targetType: "action_request",
        targetId: action.id,
        runId,
        stepId: step?.id,
        actionRequestId: action.id,
        detail: { phase: "before_execution" },
      });
      return true;
    });
    if (expired) return;
    const claimed = await this.#sql.begin(async (tx) => {
      const [row] = await tx<
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
          where run_id = ${runId}
            and id = ${actionId}
            and status = 'approved' and expires_at > now()
            and exists (
              select 1 from public.agent_runs r where r.id = ${runId}
                and r.status = 'running'
                and r.claim_token = ${claimToken}
            )
          order by created_at asc limit 1
          for update skip locked
        )
        returning id, workspace_id, run_id, tool_name, risk, summary, input, input_hash,
          status, expires_at
      `;
      if (!row) return;
      if (payloadHash(row.input) !== row.input_hash) {
        const [step] = await tx<{ id: string }[]>`
          update public.workflow_steps
          set status = 'failed', completed_at = now()
          where action_request_id = ${row.id}
          returning id
        `;
        await tx`
          update public.action_requests set status = 'failed'
          where id = ${row.id} and status = 'executing'
        `;
        await tx`
          update public.agent_runs set status = 'failed',
            last_error = 'Approved action payload hash mismatch.',
            claim_token = null, lease_expires_at = null
          where id = ${runId} and workspace_id = ${row.workspace_id}
            and status = 'running'
            and claim_token = ${claimToken}
        `;
        await this.#appendRunEvent(tx, {
          workspaceId: row.workspace_id,
          runId,
          stepId: step?.id,
          actionRequestId: row.id,
          eventType: "run_failed",
          eventKey: "run_failed:action_hash_mismatch",
          payload: { errorCode: "action_hash_mismatch" },
        });
        await this.#writeAuditEvent(tx, {
          workspaceId: row.workspace_id,
          actor: "worker",
          action: "execution.integrity_failed",
          eventKey: `action:${row.id}:hash_mismatch`,
          targetType: "action_request",
          targetId: row.id,
          runId,
          stepId: step?.id,
          actionRequestId: row.id,
          detail: { errorCode: "action_hash_mismatch" },
        });
        return { invalid: true as const };
      }
      const [step] = await tx<
        { id: string; attempt: number; started_at: Date }[]
      >`
        update public.workflow_steps
        set status = 'running', execution_phase = 'claimed',
          attempt = attempt + 1, started_at = coalesce(started_at, now())
        where action_request_id = ${row.id}
          and status = 'waiting_approval' and attempt < max_attempts
        returning id, attempt, started_at
      `;
      if (!step) {
        const [failedStep] = await tx<{ id: string }[]>`
          update public.workflow_steps set status = 'failed', completed_at = now()
          where action_request_id = ${row.id}
          returning id
        `;
        await tx`
          update public.action_requests set status = 'failed'
          where id = ${row.id} and status = 'executing'
        `;
        await tx`
          update public.agent_runs set status = 'failed',
            last_error = 'Action step is not claimable.',
            claim_token = null, lease_expires_at = null
          where id = ${runId} and workspace_id = ${row.workspace_id}
            and status = 'running'
            and claim_token = ${claimToken}
        `;
        await this.#appendRunEvent(tx, {
          workspaceId: row.workspace_id,
          runId,
          stepId: failedStep?.id,
          actionRequestId: row.id,
          eventType: "run_failed",
          eventKey: "run_failed:action_step_not_claimable",
          payload: { errorCode: "action_step_not_claimable" },
        });
        return { invalid: true as const };
      }
      await this.#appendRunEvent(tx, {
        workspaceId: row.workspace_id,
        runId,
        stepId: step.id,
        actionRequestId: row.id,
        eventType: "action_execution_claimed",
        eventKey: `action:${row.id}:claimed:${step.attempt}`,
        payload: { attempt: step.attempt, inputHash: row.input_hash },
      });
      await this.#writeAuditEvent(tx, {
        workspaceId: row.workspace_id,
        actor: "worker",
        action: "execution.claimed",
        eventKey: `action:${row.id}:claimed:${step.attempt}`,
        targetType: "action_request",
        targetId: row.id,
        runId,
        stepId: step.id,
        actionRequestId: row.id,
        detail: { attempt: step.attempt, inputHash: row.input_hash },
      });
      return { row, step, invalid: false as const };
    });
    if (claimed?.invalid)
      throw new Error("Approved action could not be claimed safely.");
    const row = claimed?.row;
    if (!row) return;
    return {
      action: actionRequestSchema.parse({
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
      }),
      stepId: claimed.step.id,
      attempt: claimed.step.attempt,
      startedAt: claimed.step.started_at.toISOString(),
    };
  }

  async markActionInvocationStarted(input: {
    actionId: string;
    workspaceId: string;
    runId: string;
    stepId: string;
    attempt: number;
    claimToken: string;
  }): Promise<void> {
    await this.#sql.begin(async (tx) => {
      const updated = await tx`
        update public.workflow_steps set execution_phase = 'invocation_started'
        where id = ${input.stepId} and workspace_id = ${input.workspaceId}
          and run_id = ${input.runId} and action_request_id = ${input.actionId}
          and status = 'running' and execution_phase = 'claimed'
          and attempt = ${input.attempt}
          and exists (
            select 1 from public.agent_runs r where r.id = ${input.runId}
              and r.workspace_id = ${input.workspaceId} and r.status = 'running'
              and r.claim_token = ${input.claimToken}
          )
        returning id
      `;
      if (updated.length !== 1)
        throw new Error("Action invocation boundary changed unexpectedly.");
      await this.#appendRunEvent(tx, {
        workspaceId: input.workspaceId,
        runId: input.runId,
        stepId: input.stepId,
        actionRequestId: input.actionId,
        eventType: "action_invocation_started",
        eventKey: `action:${input.actionId}:invocation:${input.attempt}`,
        payload: { attempt: input.attempt },
      });
      await this.#writeAuditEvent(tx, {
        workspaceId: input.workspaceId,
        actor: "worker",
        action: "execution.started",
        eventKey: `action:${input.actionId}:invocation:${input.attempt}`,
        targetType: "action_request",
        targetId: input.actionId,
        runId: input.runId,
        stepId: input.stepId,
        actionRequestId: input.actionId,
        detail: { attempt: input.attempt },
      });
    });
  }

  async markActionResultReceived(input: {
    actionId: string;
    workspaceId: string;
    runId: string;
    stepId: string;
    attempt: number;
    claimToken: string;
  }): Promise<void> {
    await this.#sql.begin(async (tx) => {
      const updated = await tx`
        update public.workflow_steps set execution_phase = 'result_received'
        where id = ${input.stepId} and workspace_id = ${input.workspaceId}
          and action_request_id = ${input.actionId} and status = 'running'
          and execution_phase = 'invocation_started' and attempt = ${input.attempt}
          and exists (
            select 1 from public.agent_runs r where r.id = ${input.runId}
              and r.workspace_id = ${input.workspaceId} and r.status = 'running'
              and r.claim_token = ${input.claimToken}
          )
        returning id
      `;
      if (updated.length !== 1)
        throw new Error("Action result boundary changed unexpectedly.");
      await this.#appendRunEvent(tx, {
        workspaceId: input.workspaceId,
        runId: input.runId,
        stepId: input.stepId,
        actionRequestId: input.actionId,
        eventType: "action_result_received",
        eventKey: `action:${input.actionId}:response:${input.attempt}`,
        payload: { attempt: input.attempt },
      });
    });
  }

  async persistToolResult(
    result: StructuredToolResult,
    claimToken: string,
  ): Promise<boolean> {
    return this.#sql.begin((tx) =>
      this.#persistToolResultProjection(tx, result, claimToken),
    );
  }

  async reconcileUnknownResult(input: {
    unknownResultId: string;
    workspaceId: string;
    certainty: "reconciled_succeeded" | "reconciled_failed";
    evidence: Record<string, unknown>;
  }): Promise<StructuredToolResult> {
    const result = await this.#sql.begin(async (tx) => {
      const [unknown] = await tx<
        {
          run_id: string;
          action_request_id: string;
          tool_name: string;
        }[]
      >`
        select tr.run_id, tr.action_request_id, tr.tool_name
        from public.tool_results tr
        join public.action_requests a on a.id = tr.action_request_id
          and a.run_id = tr.run_id and a.workspace_id = tr.workspace_id
        join public.agent_runs r on r.id = tr.run_id
          and r.workspace_id = tr.workspace_id
        where tr.id = ${input.unknownResultId}
          and tr.workspace_id = ${input.workspaceId}
          and tr.certainty = 'unknown' and a.status = 'unknown'
          and r.status <> 'cancelled'
        for update of tr, a, r
      `;
      if (!unknown)
        throw new Error("Unknown result is not available for reconciliation.");
      const [position] = await tx<{ next_position: number }[]>`
        select coalesce(max(position), -1) + 1 as next_position
        from public.workflow_steps where run_id = ${unknown.run_id}
      `;
      const stepId = randomUUID();
      const evidence = normalizeJsonValue(input.evidence);
      await tx`
        insert into public.workflow_steps (
          id, workspace_id, run_id, position, kind, tool_name, status,
          execution_phase, input, input_hash, attempt, started_at
        ) values (
          ${stepId}, ${input.workspaceId}, ${unknown.run_id},
          ${position?.next_position ?? 0}, 'reconciliation',
          'reconciliation.read', 'running', 'result_received',
          ${tx.json(toJson(evidence))}, ${payloadHash(evidence)}, 1, now()
        )
      `;
      const now = new Date().toISOString();
      const reconciled = structuredToolResultSchema.parse({
        id: randomUUID(),
        workspaceId: input.workspaceId,
        runId: unknown.run_id,
        stepId,
        reconcilesResultId: input.unknownResultId,
        toolName: "reconciliation.read",
        certainty: input.certainty,
        attempt: 1,
        output: evidence,
        outputHash: payloadHash(evidence),
        retryEligible: false,
        startedAt: now,
        completedAt: now,
      });
      await this.#persistToolResultProjection(tx, reconciled);
      const resolved = await tx`
        update public.action_requests
        set status = ${input.certainty === "reconciled_succeeded" ? "executed" : "failed"}
        where id = ${unknown.action_request_id}
          and workspace_id = ${input.workspaceId} and status = 'unknown'
        returning id
      `;
      if (resolved.length !== 1)
        throw new Error("Unknown action changed during reconciliation.");
      await this.#writeAuditEvent(tx, {
        workspaceId: input.workspaceId,
        actor: "worker",
        action: "execution.reconciled",
        eventKey: `result:${input.unknownResultId}:reconciled`,
        targetType: "tool_result",
        targetId: reconciled.id,
        runId: unknown.run_id,
        stepId,
        actionRequestId: unknown.action_request_id,
        detail: {
          unknownResultId: input.unknownResultId,
          certainty: input.certainty,
        },
      });
      return reconciled;
    });
    await this.enqueuePendingContinuations(result.runId);
    return result;
  }

  async enqueuePendingContinuations(runId: string): Promise<number> {
    return this.#sql.begin(async (tx) => {
      const rows = await tx<
        {
          id: string;
          workspace_id: string;
          step_id: string;
          action_request_id: string | null;
        }[]
      >`
        select id, workspace_id, step_id, action_request_id
        from public.tool_results
        where run_id = ${runId} and continuation_status = 'pending'
        order by created_at asc
        for update skip locked
      `;
      for (const row of rows) {
        await tx`select pgmq.send('agent_jobs', ${tx.json(
          toJson({
            type: "continue_run",
            runId,
            workspaceId: row.workspace_id,
            toolResultId: row.id,
          }),
        )}::jsonb)`;
        await tx`
          update public.tool_results
          set continuation_status = 'enqueued', continuation_enqueued_at = now()
          where id = ${row.id} and continuation_status = 'pending'
        `;
        await this.#appendRunEvent(tx, {
          workspaceId: row.workspace_id,
          runId,
          stepId: row.step_id,
          actionRequestId: row.action_request_id ?? undefined,
          toolResultId: row.id,
          eventType: "continuation_enqueued",
          eventKey: `result:${row.id}:continuation`,
          payload: { toolResultId: row.id },
        });
        await this.#writeAuditEvent(tx, {
          workspaceId: row.workspace_id,
          actor: "worker",
          action: "continuation.enqueued",
          eventKey: `result:${row.id}:continuation`,
          targetType: "tool_result",
          targetId: row.id,
          runId,
          stepId: row.step_id,
          actionRequestId: row.action_request_id ?? undefined,
          detail: { toolResultId: row.id },
        });
      }
      return rows.length;
    });
  }

  async isExecutionJobFinalized(actionId: string): Promise<boolean> {
    const [row] = await this.#sql<{ finalized: boolean }[]>`
      select exists (
        select 1 from public.tool_results tr
        where tr.action_request_id = ${actionId}
          and tr.continuation_status = 'enqueued'
      ) as finalized
    `;
    return row?.finalized ?? false;
  }

  async resolveResumeActionId(input: {
    runId: string;
    workspaceId: string;
    actionId?: string;
  }): Promise<string | undefined> {
    const [row] = await this.#sql<{ id: string }[]>`
      select id from public.action_requests
      where run_id = ${input.runId} and workspace_id = ${input.workspaceId}
        and (
          ${input.actionId ?? null}::uuid is null
          or id = ${input.actionId ?? null}
        )
        and (
          status in ('approved', 'executing')
          or exists (
            select 1 from public.tool_results tr
            where tr.action_request_id = action_requests.id
          )
        )
      order by created_at desc limit 1
    `;
    return row?.id;
  }

  async recoverInterruptedAction(
    runId: string,
  ): Promise<"none" | "retry" | "continued"> {
    const outcome = await this.#sql.begin(async (tx) => {
      const [row] = await tx<
        {
          action_id: string;
          workspace_id: string;
          tool_name: string;
          step_id: string;
          attempt: number;
          max_attempts: number;
          execution_phase: string | null;
          started_at: Date | null;
        }[]
      >`
        select a.id as action_id, a.workspace_id, a.tool_name,
          s.id as step_id, s.attempt, s.max_attempts, s.execution_phase,
          s.started_at
        from public.action_requests a
        join public.workflow_steps s on s.action_request_id = a.id
        join public.agent_runs r on r.id = a.run_id
        where a.run_id = ${runId} and a.status = 'executing'
          and (
            r.status = 'failed'
            or (r.status = 'running' and r.lease_expires_at <= now())
          )
          and not exists (
            select 1 from public.tool_results tr
            where tr.action_request_id = a.id
          )
        for update of a, s, r
      `;
      if (!row) return { type: "none" as const };
      if (row.execution_phase === "claimed" && row.attempt < row.max_attempts) {
        await tx`
          update public.action_requests set status = 'approved'
          where id = ${row.action_id} and status = 'executing'
        `;
        await tx`
          update public.workflow_steps
          set status = 'waiting_approval', execution_phase = null
          where id = ${row.step_id} and status = 'running'
        `;
        await tx`
          update public.agent_runs set status = 'queued', last_error = null,
            claim_token = null, lease_expires_at = null
          where id = ${runId} and workspace_id = ${row.workspace_id}
            and status in ('running', 'failed')
        `;
        await this.#appendRunEvent(tx, {
          workspaceId: row.workspace_id,
          runId,
          stepId: row.step_id,
          actionRequestId: row.action_id,
          eventType: "action_retry_scheduled",
          eventKey: `action:${row.action_id}:retry:${row.attempt}`,
          payload: {
            attempt: row.attempt,
            reason: "interrupted_before_invocation",
          },
        });
        return { type: "retry" as const };
      }
      const certainty =
        row.execution_phase === "claimed"
          ? ("failed_before_effect" as const)
          : ("unknown" as const);
      const now = new Date().toISOString();
      const result = structuredToolResultSchema.parse({
        id: randomUUID(),
        workspaceId: row.workspace_id,
        runId,
        stepId: row.step_id,
        actionRequestId: row.action_id,
        toolName: row.tool_name,
        certainty,
        attempt: row.attempt,
        errorCode:
          certainty === "unknown"
            ? "interrupted_after_invocation_boundary"
            : "pre_effect_retry_limit_reached",
        errorMessage:
          certainty === "unknown"
            ? "Execution was interrupted after the external effect may have begun."
            : "Execution was interrupted before the effect and exhausted its retry budget.",
        retryEligible: false,
        startedAt: (row.started_at ?? new Date()).toISOString(),
        completedAt: now,
      });
      await this.#persistToolResultProjection(tx, result);
      return { type: "continued" as const };
    });
    if (outcome.type === "continued")
      await this.enqueuePendingContinuations(runId);
    return outcome.type;
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
          await this.#appendRunEvent(tx, {
            workspaceId: row.workspace_id,
            runId,
            eventType: "run_created",
            eventKey: "run_created",
            payload: { source: "schedule", triggerEventId: eventId },
          });
          await this.#writeAuditEvent(tx, {
            workspaceId: row.workspace_id,
            actor: "system",
            action: "run.created",
            eventKey: `run:${runId}:created`,
            targetType: "agent_run",
            targetId: runId,
            runId,
            detail: { source: "schedule", triggerEventId: eventId },
          });
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

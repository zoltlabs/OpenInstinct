import { randomUUID } from "node:crypto";
import postgres, { type Sql } from "postgres";
import {
  artifactKindSchema,
  artifactScanResultSchema,
  artifactSensitivitySchema,
  sanitizedArtifactName,
  type ArtifactScanResult,
} from "@openinstinct/artifacts";
import {
  actionRequestSchema,
  browserReadDecisionSchema,
  browserReadObservationSchema,
  canonicalBrowserReadUrl,
  normalizeJsonValue,
  payloadHash,
  structuredToolResultSchema,
  type ActionRequest,
  type BrowserReadDecision,
  type BrowserReadObservation,
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
      {
        msg_id: string | number;
        read_ct: number;
        enqueued_at: Date;
        message: unknown;
      }[]
    >`select msg_id, read_ct, enqueued_at, message from pgmq.read('agent_jobs', ${visibilitySeconds}, ${limit})`;
    return rows.map((row) => ({
      messageId: Number(row.msg_id),
      readCount: row.read_ct,
      enqueuedAt: row.enqueued_at.toISOString(),
      job: agentJobSchema.parse(row.message),
    }));
  }

  async recordWorkerHeartbeat(input: {
    workerId: string;
    jobsProcessed: number;
    oldestQueueLatencyMs: number;
  }): Promise<void> {
    await this.#sql`
      insert into app_private.worker_heartbeats (
        worker_id,last_seen_at,last_poll_at,jobs_processed,oldest_queue_latency_ms
      ) values (
        ${input.workerId},now(),now(),${input.jobsProcessed},${Math.max(0, input.oldestQueueLatencyMs)}
      ) on conflict (worker_id) do update set
        last_seen_at=excluded.last_seen_at,last_poll_at=excluded.last_poll_at,
        jobs_processed=app_private.worker_heartbeats.jobs_processed+excluded.jobs_processed,
        oldest_queue_latency_ms=excluded.oldest_queue_latency_ms
    `;
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

  async enqueueAllPendingContinuations(limit = 100): Promise<number> {
    const rows = await this.#sql<{ run_id: string }[]>`
      select distinct run_id from public.tool_results
      where continuation_status='pending'
      order by run_id limit ${Math.min(Math.max(limit, 1), 500)}
    `;
    let enqueued = 0;
    for (const row of rows)
      enqueued += await this.enqueuePendingContinuations(row.run_id);
    return enqueued;
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
      label: string;
      status: string;
      configurationVersion: number;
      allowedOrigins: readonly string[];
    }[]
  > {
    const rows = await this.#sql<
      {
        id: string;
        provider: string;
        label: string;
        status: string;
        configuration_version: string | number;
        allowed_origins: string[];
      }[]
    >`
      select p.id, p.provider, p.label, p.status, p.configuration_version,
        coalesce(array_agg(o.origin order by o.origin) filter (where o.origin is not null), '{}') as allowed_origins
      from public.browser_profiles p
      left join public.browser_profile_origins o on o.profile_id = p.id
        and o.workspace_id = p.workspace_id
      where p.workspace_id = ${workspaceId}
      group by p.id order by p.label asc limit 50
    `;
    return rows.map((row) => ({
      id: row.id,
      provider: row.provider,
      label: row.label,
      status: row.status,
      configurationVersion: Number(row.configuration_version),
      allowedOrigins: row.allowed_origins,
    }));
  }

  async createProvisioningBrowserProfile(input: {
    id: string;
    workspaceId: string;
    provider: string;
    label: string;
    origin: string;
    capabilities: Record<string, unknown>;
  }): Promise<void> {
    await this.#sql.begin(async (tx) => {
      await tx`
        insert into public.browser_profiles (
          id, workspace_id, provider, label, status,
          provider_capabilities, capabilities_hash, capabilities_checked_at
        ) values (
          ${input.id}, ${input.workspaceId}, ${input.provider}, ${input.label},
          'provisioning', ${tx.json(toJson(input.capabilities))},
          ${payloadHash(input.capabilities)}, now()
        )
      `;
      await tx`
        insert into public.browser_profile_origins (profile_id, workspace_id, origin)
        values (${input.id}, ${input.workspaceId}, ${input.origin})
      `;
      await this.#writeAuditEvent(tx, {
        workspaceId: input.workspaceId,
        actor: "owner",
        action: "browser.profile.create_requested",
        eventKey: `browser_profile:${input.id}:create_requested`,
        targetType: "browser_profile",
        targetId: input.id,
        detail: { provider: input.provider, origin: input.origin },
      });
    });
  }

  async attachBrowserProviderProfile(input: {
    id: string;
    workspaceId: string;
    providerProfileId: string;
  }): Promise<void> {
    await this.#sql.begin(async (tx) => {
      const updated = await tx`
        update public.browser_profiles
        set provider_profile_id = ${input.providerProfileId}, status = 'needs_login',
          last_error_code = null
        where id = ${input.id} and workspace_id = ${input.workspaceId}
          and status = 'provisioning' and provider_profile_id is null
        returning id
      `;
      if (updated.length !== 1)
        throw new Error("Browser profile provisioning state changed.");
      await this.#writeAuditEvent(tx, {
        workspaceId: input.workspaceId,
        actor: "system",
        action: "browser.profile.provisioned",
        eventKey: `browser_profile:${input.id}:provisioned`,
        targetType: "browser_profile",
        targetId: input.id,
        detail: {},
      });
    });
  }

  async markBrowserProfileError(input: {
    id: string;
    workspaceId: string;
    errorCode: string;
    configurationVersion: number;
    operation: "enrollment" | "reauthentication";
  }): Promise<void> {
    await this.#sql.begin(async (tx) => {
      const rows = await tx`
        update public.browser_profiles set status='error',last_error_code=${input.errorCode}
        where id=${input.id} and workspace_id=${input.workspaceId}
          and configuration_version=${input.configurationVersion}
          and (
            (${input.operation}='enrollment' and status in ('provisioning','needs_login','error'))
            or (${input.operation}='reauthentication' and status in ('needs_reauth','error'))
          )
        returning id
      `;
      if (rows.length !== 1) return;
      await this.#writeAuditEvent(tx, {
        workspaceId: input.workspaceId,
        actor: "system",
        action: "browser.profile.operation_failed",
        eventKey: `browser_profile:${input.id}:${input.operation}:${input.configurationVersion}:failed`,
        targetType: "browser_profile",
        targetId: input.id,
        detail: { operation: input.operation, errorCode: input.errorCode },
      });
    });
  }

  async beginBrowserReauthentication(input: {
    id: string;
    workspaceId: string;
  }): Promise<number> {
    return this.#sql.begin(async (tx) => {
      const activeExecution = await tx`
        select id from public.browser_executions
        where profile_id=${input.id} and workspace_id=${input.workspaceId}
          and status in ('queued','running','waiting_owner','cleanup_pending')
        limit 1 for update
      `;
      if (activeExecution.length)
        throw new Error("Browser profile is owned by an active execution.");
      const [row] = await tx<{ configuration_version: string | number }[]>`
        update public.browser_profiles
        set status=case when status='needs_login' then 'needs_login' else 'needs_reauth' end,
          configuration_version=configuration_version+1,last_error_code=null
        where id=${input.id} and workspace_id=${input.workspaceId}
          and status in ('active','needs_login','needs_reauth','error')
        returning configuration_version
      `;
      if (!row)
        throw new Error("Browser profile cannot start reauthentication.");
      await tx`
        update app_private.browser_control_sessions
        set status='cleanup_pending'
        where profile_id=${input.id} and workspace_id=${input.workspaceId} and status='active'
      `;
      await this.#writeAuditEvent(tx, {
        workspaceId: input.workspaceId,
        actor: "owner",
        action: "browser.reauthentication.started",
        eventKey: `browser_profile:${input.id}:reauthentication:${row.configuration_version}:started`,
        targetType: "browser_profile",
        targetId: input.id,
        detail: { configurationVersion: Number(row.configuration_version) },
      });
      return Number(row.configuration_version);
    });
  }

  async deleteUnprovisionedBrowserProfile(input: {
    id: string;
    workspaceId: string;
  }): Promise<void> {
    await this.#sql.begin(async (tx) => {
      const rows = await tx`
        delete from public.browser_profiles
        where id=${input.id} and workspace_id=${input.workspaceId}
          and provider_profile_id is null and status in ('provisioning','error')
        returning id
      `;
      if (rows.length !== 1)
        throw new Error(
          "Unprovisioned browser profile cleanup is unavailable.",
        );
      await this.#writeAuditEvent(tx, {
        workspaceId: input.workspaceId,
        actor: "system",
        action: "browser.profile.unprovisioned_cleanup",
        eventKey: `browser_profile:${input.id}:unprovisioned_cleanup`,
        targetType: "browser_profile",
        targetId: input.id,
        detail: { providerAbsenceVerified: true },
      });
    });
  }

  async getBrowserProfileForManagement(input: {
    id: string;
    workspaceId: string;
    configurationVersion?: number;
  }): Promise<{
    id: string;
    provider: string;
    providerProfileId: string;
    label: string;
    status: string;
    configurationVersion: number;
    allowedOrigins: readonly string[];
  }> {
    const [row] = await this.#sql<
      {
        id: string;
        provider: string;
        provider_profile_id: string | null;
        label: string;
        status: string;
        configuration_version: string | number;
        allowed_origins: string[];
      }[]
    >`
      select p.id,p.provider,p.provider_profile_id,p.label,p.status,p.configuration_version,
        coalesce(array_agg(o.origin order by o.origin) filter (where o.origin is not null), '{}') as allowed_origins
      from public.browser_profiles p left join public.browser_profile_origins o
        on o.profile_id=p.id and o.workspace_id=p.workspace_id
      where p.id=${input.id} and p.workspace_id=${input.workspaceId}
        and (${input.configurationVersion ?? null}::bigint is null
          or p.configuration_version=${input.configurationVersion ?? null})
      group by p.id
    `;
    if (!row?.provider_profile_id)
      throw new Error("Browser profile is not provider-ready.");
    return {
      id: row.id,
      provider: row.provider,
      providerProfileId: row.provider_profile_id,
      label: row.label,
      status: row.status,
      configurationVersion: Number(row.configuration_version),
      allowedOrigins: row.allowed_origins,
    };
  }

  async getBrowserProfileForRecovery(input: {
    id: string;
    workspaceId: string;
  }): Promise<{
    id: string;
    provider: string;
    providerProfileId?: string;
    status: string;
  }> {
    const [row] = await this.#sql<
      {
        id: string;
        provider: string;
        provider_profile_id: string | null;
        status: string;
      }[]
    >`
      select id,provider,provider_profile_id,status
      from public.browser_profiles
      where id=${input.id} and workspace_id=${input.workspaceId}
    `;
    if (!row) throw new Error("Browser profile is unavailable.");
    return {
      id: row.id,
      provider: row.provider,
      ...(row.provider_profile_id
        ? { providerProfileId: row.provider_profile_id }
        : {}),
      status: row.status,
    };
  }

  async resolveActiveBrowserProfile(input: {
    id: string;
    workspaceId: string;
    origin?: string;
  }): Promise<string> {
    const profile = await this.getBrowserProfileForManagement(input);
    if (profile.status !== "active")
      throw new Error("Browser profile requires owner attention.");
    if (input.origin && !profile.allowedOrigins.includes(input.origin))
      throw new Error("Browser profile is not authorized for this origin.");
    return profile.providerProfileId;
  }

  async createBrowserControlSession(input: {
    id: string;
    profileId: string;
    workspaceId: string;
    providerSessionId: string;
    purpose: "enrollment" | "reauthentication" | "health" | "takeover";
    nonceHash: string;
    configurationVersion: number;
    expiresAt: string;
  }): Promise<void> {
    await this.#sql.begin(async (tx) => {
      const activeExecution = await tx`
        select id from public.browser_executions
        where profile_id=${input.profileId} and workspace_id=${input.workspaceId}
          and status in ('queued','running','waiting_owner','cleanup_pending')
        limit 1 for update
      `;
      if (activeExecution.length)
        throw new Error("Browser profile is owned by an active execution.");
      const rows = await tx`
        insert into app_private.browser_control_sessions (
          id,profile_id,workspace_id,provider_session_id,purpose,status,
          takeover_nonce_hash,configuration_version,expires_at
        ) select ${input.id},p.id,p.workspace_id,${input.providerSessionId},${input.purpose},
          'active',${input.nonceHash},p.configuration_version,${new Date(input.expiresAt)}
        from public.browser_profiles p where p.id=${input.profileId}
          and p.workspace_id=${input.workspaceId}
          and p.configuration_version=${input.configurationVersion}
          and p.status in ('needs_login','needs_reauth')
        returning id
      `;
      if (rows.length !== 1)
        throw new Error("Browser control session could not be bound safely.");
      await this.#writeAuditEvent(tx, {
        workspaceId: input.workspaceId,
        actor: "owner",
        action: "browser.control.started",
        eventKey: `browser_session:${input.id}:started`,
        targetType: "browser_profile",
        targetId: input.profileId,
        detail: { purpose: input.purpose },
      });
    });
  }

  async getBrowserControlSession(input: {
    nonceHash: string;
    workspaceId: string;
    allowCompleted?: boolean;
  }): Promise<{
    id: string;
    profileId: string;
    providerSessionId: string;
    purpose: string;
    status: "active" | "completed";
    configurationVersion: number;
    authenticationVerified?: boolean;
    expiresAt: string;
  }> {
    const [row] = await this.#sql<
      {
        id: string;
        profile_id: string;
        provider_session_id: string;
        purpose: string;
        status: "active" | "completed";
        configuration_version: string | number;
        authentication_verified: boolean | null;
        expires_at: Date;
      }[]
    >`
      select s.id,s.profile_id,s.provider_session_id,s.purpose,s.status,
        s.configuration_version,s.authentication_verified,s.expires_at
      from app_private.browser_control_sessions s
      join public.browser_profiles p on p.id=s.profile_id and p.workspace_id=s.workspace_id
      where s.takeover_nonce_hash=${input.nonceHash} and s.workspace_id=${input.workspaceId}
        and s.expires_at>now()
        and (
          (s.status='active' and p.status in ('needs_login','needs_reauth')
            and p.configuration_version=s.configuration_version)
          or (${input.allowCompleted ?? false} and s.status='completed')
        )
    `;
    if (!row)
      throw new Error(
        "Browser takeover authorization is unavailable or expired.",
      );
    return {
      id: row.id,
      profileId: row.profile_id,
      providerSessionId: row.provider_session_id,
      purpose: row.purpose,
      status: row.status,
      configurationVersion: Number(row.configuration_version),
      ...(row.authentication_verified === null
        ? {}
        : { authenticationVerified: row.authentication_verified }),
      expiresAt: row.expires_at.toISOString(),
    };
  }

  async recordBrowserTakeoverAccess(input: {
    sessionId: string;
    profileId: string;
    workspaceId: string;
  }): Promise<void> {
    await this.#sql.begin(async (tx) => {
      const rows = await tx`
        update app_private.browser_control_sessions
        set takeover_accessed_at=now()
        where id=${input.sessionId} and profile_id=${input.profileId}
          and workspace_id=${input.workspaceId} and status='active'
          and expires_at>now() and takeover_accessed_at is null
        returning id
      `;
      if (rows.length !== 1)
        throw new Error("Browser takeover authorization changed.");
      await this.#writeAuditEvent(tx, {
        workspaceId: input.workspaceId,
        actor: "owner",
        action: "browser.takeover.accessed",
        eventKey: `browser_session:${input.sessionId}:takeover:${randomUUID()}`,
        targetType: "browser_profile",
        targetId: input.profileId,
        detail: {},
      });
    });
  }

  async listActiveBrowserControlSessions(input: {
    profileId: string;
    workspaceId: string;
    beforeConfigurationVersion?: number;
  }): Promise<readonly { id: string; providerSessionId: string }[]> {
    const rows = await this.#sql<{ id: string; provider_session_id: string }[]>`
      select id,provider_session_id from app_private.browser_control_sessions
      where profile_id=${input.profileId} and workspace_id=${input.workspaceId}
        and status in ('active','cleanup_pending')
        and (${input.beforeConfigurationVersion ?? null}::bigint is null
          or configuration_version<${input.beforeConfigurationVersion ?? null})`;
    return rows.map((row) => ({
      id: row.id,
      providerSessionId: row.provider_session_id,
    }));
  }

  async listBrowserSessionsPendingCleanup(
    limit = 20,
  ): Promise<
    readonly { id: string; workspaceId: string; providerSessionId: string }[]
  > {
    return this.#sql.begin(async (tx) => {
      await tx`
        update app_private.browser_control_sessions
        set status='cleanup_pending'
        where status='active' and expires_at<=now()
      `;
      const rows = await tx<
        { id: string; workspace_id: string; provider_session_id: string }[]
      >`
        select id,workspace_id,provider_session_id
        from app_private.browser_control_sessions
        where status='cleanup_pending'
        order by expires_at asc limit ${Math.min(Math.max(limit, 1), 100)}
      `;
      return rows.map((row) => ({
        id: row.id,
        workspaceId: row.workspace_id,
        providerSessionId: row.provider_session_id,
      }));
    });
  }

  async closeBrowserControlSession(input: {
    id: string;
    workspaceId: string;
    status?: "cleanup_pending" | "closed" | "failed" | "expired";
  }): Promise<void> {
    await this.#sql.begin(async (tx) => {
      const status = input.status ?? "closed";
      const rows = await tx`update app_private.browser_control_sessions
        set status=${status},completed_at=case when ${status}='cleanup_pending' then null else now() end
        where id=${input.id} and workspace_id=${input.workspaceId}
          and status in ('active','cleanup_pending') returning profile_id,purpose
      `;
      const row = rows[0] as
        | { profile_id: string; purpose: string }
        | undefined;
      if (!row) return;
      await this.#writeAuditEvent(tx, {
        workspaceId: input.workspaceId,
        actor: "system",
        action: "browser.control.closed",
        eventKey: `browser_session:${input.id}:${status}`,
        targetType: "browser_profile",
        targetId: row.profile_id,
        detail: { purpose: row.purpose, status },
      });
    });
  }

  async completeBrowserEnrollment(input: {
    profileId: string;
    workspaceId: string;
    sessionId: string;
    authenticated: boolean;
  }): Promise<void> {
    await this.#sql.begin(async (tx) => {
      const [session] = await tx<{ configuration_version: string | number }[]>`
        update app_private.browser_control_sessions s
        set status='completed',completed_at=now(),authentication_verified=${input.authenticated}
        where s.id=${input.sessionId} and s.profile_id=${input.profileId}
          and s.workspace_id=${input.workspaceId} and s.status='active'
          and s.expires_at>now()
          and s.purpose in ('enrollment','reauthentication')
          and exists (
            select 1 from public.browser_profiles p
            where p.id=s.profile_id and p.workspace_id=s.workspace_id
              and p.configuration_version=s.configuration_version
              and p.status in ('needs_login','needs_reauth')
          )
        returning s.configuration_version
      `;
      if (!session) throw new Error("Browser enrollment session changed.");
      const profile = await tx`
        update public.browser_profiles
        set status=case
            when ${input.authenticated} then 'active'
            when status='needs_reauth' then 'needs_reauth'
            else 'needs_login'
          end,
          last_health_checked_at=now(),
          last_authenticated_at=case when ${input.authenticated} then now() else last_authenticated_at end,
          last_error_code=${input.authenticated ? null : "authentication_unconfirmed"}
        where id=${input.profileId} and workspace_id=${input.workspaceId}
          and configuration_version=${Number(session.configuration_version)}
          and status in ('needs_login','needs_reauth') returning id
      `;
      if (profile.length !== 1)
        throw new Error("Browser profile enrollment state changed.");
      await this.#writeAuditEvent(tx, {
        workspaceId: input.workspaceId,
        actor: "owner",
        action: "browser.enrollment.completed",
        eventKey: `browser_session:${input.sessionId}:completed`,
        targetType: "browser_profile",
        targetId: input.profileId,
        detail: { authenticated: input.authenticated },
      });
    });
  }

  async failBrowserEnrollmentSession(input: {
    sessionId: string;
    profileId: string;
    workspaceId: string;
    configurationVersion: number;
    providerClosed: boolean;
    errorCode: string;
  }): Promise<boolean> {
    return this.#sql.begin(async (tx) => {
      const rows = await tx`
        update app_private.browser_control_sessions
        set status=${input.providerClosed ? "failed" : "cleanup_pending"},
          completed_at=${input.providerClosed ? new Date() : null}
        where id=${input.sessionId} and profile_id=${input.profileId}
          and workspace_id=${input.workspaceId}
          and configuration_version=${input.configurationVersion}
          and purpose in ('enrollment','reauthentication') and status='active'
        returning id
      `;
      if (rows.length !== 1) return false;
      await tx`
        update public.browser_profiles
        set status='error',last_error_code=${input.errorCode}
        where id=${input.profileId} and workspace_id=${input.workspaceId}
          and configuration_version=${input.configurationVersion}
          and status in ('needs_login','needs_reauth')
      `;
      await this.#writeAuditEvent(tx, {
        workspaceId: input.workspaceId,
        actor: "system",
        action: "browser.enrollment.failed",
        eventKey: `browser_session:${input.sessionId}:failed`,
        targetType: "browser_profile",
        targetId: input.profileId,
        detail: {
          configurationVersion: input.configurationVersion,
          cleanupPending: !input.providerClosed,
          errorCode: input.errorCode,
        },
      });
      return true;
    });
  }

  async recordBrowserProfileHealth(input: {
    id: string;
    workspaceId: string;
    healthy: boolean;
    authenticated: boolean;
    configurationVersion: number;
    errorCode?: string;
  }): Promise<void> {
    await this.#sql.begin(async (tx) => {
      const nextStatus = input.healthy
        ? input.authenticated
          ? "active"
          : "needs_reauth"
        : "error";
      const rows = await tx`
        update public.browser_profiles
        set status=${nextStatus}, last_health_checked_at=now(),
          last_authenticated_at=case when ${input.authenticated} then now() else last_authenticated_at end,
          last_error_code=${input.errorCode ?? (input.authenticated ? null : "authentication_unconfirmed")}
        where id=${input.id} and workspace_id=${input.workspaceId}
          and configuration_version=${input.configurationVersion}
          and status in ('active','needs_login','needs_reauth','error')
        returning id
      `;
      if (rows.length !== 1)
        throw new Error("Browser profile health state changed.");
      await this.#writeAuditEvent(tx, {
        workspaceId: input.workspaceId,
        actor: "system",
        action: "browser.profile.health_checked",
        eventKey: `browser_profile:${input.id}:health:${randomUUID()}`,
        targetType: "browser_profile",
        targetId: input.id,
        detail: {
          healthy: input.healthy,
          authenticated: input.authenticated,
          errorCode: input.errorCode,
        },
      });
    });
  }

  async revokeBrowserProfile(input: {
    id: string;
    workspaceId: string;
  }): Promise<readonly { id: string; providerSessionId: string }[]> {
    return this.#sql.begin(async (tx) => {
      const rows = await tx`
        update public.browser_profiles set status='revoked',revoked_at=coalesce(revoked_at,now()),
          deletion_requested_at=coalesce(deletion_requested_at,now())
        where id=${input.id} and workspace_id=${input.workspaceId}
          and status in ('provisioning','needs_login','active','needs_reauth','error','revoked')
        returning id
      `;
      if (rows.length !== 1)
        throw new Error("Browser profile cannot be revoked.");
      const sessions = await tx<{ id: string; provider_session_id: string }[]>`
        update app_private.browser_control_sessions set status='cleanup_pending'
        where profile_id=${input.id} and workspace_id=${input.workspaceId} and status='active'
        returning id,provider_session_id
      `;
      await this.#writeAuditEvent(tx, {
        workspaceId: input.workspaceId,
        actor: "owner",
        action: "browser.profile.revoked",
        eventKey: `browser_profile:${input.id}:revoked`,
        targetType: "browser_profile",
        targetId: input.id,
        detail: {},
      });
      return sessions.map((row) => ({
        id: row.id,
        providerSessionId: row.provider_session_id,
      }));
    });
  }

  async deleteVerifiedBrowserProfile(input: {
    id: string;
    workspaceId: string;
  }): Promise<void> {
    await this.#sql.begin(async (tx) => {
      const rows = await tx<{ provider: string }[]>`
        update public.browser_profiles set deletion_verified_at=now()
        where id=${input.id} and workspace_id=${input.workspaceId} and status='revoked'
          and deletion_requested_at is not null returning provider
      `;
      if (rows.length !== 1)
        throw new Error("Browser profile deletion is not ready.");
      const executions = await tx`
        select id from public.browser_executions
        where profile_id=${input.id} and workspace_id=${input.workspaceId}
          and status in ('queued','running','waiting_owner','cleanup_pending')
        limit 1
      `;
      if (executions.length)
        throw new Error("Browser profile execution cleanup is still pending.");
      const pending = await tx`
        select id from app_private.browser_control_sessions
        where profile_id=${input.id} and workspace_id=${input.workspaceId}
          and status in ('active','cleanup_pending') limit 1
      `;
      if (pending.length)
        throw new Error("Browser profile session cleanup is still pending.");
      await this.#writeAuditEvent(tx, {
        workspaceId: input.workspaceId,
        actor: "owner",
        action: "browser.profile.deletion_verified",
        eventKey: `browser_profile:${input.id}:deletion_verified`,
        targetType: "browser_profile",
        targetId: input.id,
        detail: { provider: rows[0]?.provider },
      });
      await tx`delete from public.browser_profiles where id=${input.id} and workspace_id=${input.workspaceId}`;
    });
  }

  async createBrowserExecution(input: {
    workspaceId: string;
    runId: string;
    claimToken: string;
    goal: string;
    startUrl: string;
    allowedOrigins: readonly string[];
    profileId?: string;
    provider?: string;
    maxSteps?: number;
    maxDurationSeconds?: number;
    maxCostUnits?: number;
  }): Promise<{ executionId: string }> {
    const startUrl = canonicalBrowserReadUrl(input.startUrl);
    const allowedOrigins = [...new Set(input.allowedOrigins)].map((origin) => {
      const parsed = new URL(origin);
      if (parsed.protocol !== "https:" || parsed.origin !== origin)
        throw new Error(
          "Browser execution origins must be exact HTTPS origins.",
        );
      return origin;
    });
    if (!allowedOrigins.includes(startUrl.origin))
      throw new Error("Browser start URL is outside the exact origin policy.");
    if (!input.goal.trim() || input.goal.length > 8_000)
      throw new Error("Browser research goal is outside the bounded size.");
    const maxSteps = Math.min(Math.max(input.maxSteps ?? 12, 1), 50);
    const maxDurationSeconds = Math.min(
      Math.max(input.maxDurationSeconds ?? 600, 10),
      3_600,
    );
    const maxCostUnits = Math.min(
      Math.max(input.maxCostUnits ?? maxSteps, 1),
      1_000,
    );
    return this.#sql.begin(async (tx) => {
      const [run] = await tx<{ status: string }[]>`
        select status from public.agent_runs
        where id=${input.runId} and workspace_id=${input.workspaceId}
          and claim_token=${input.claimToken} and status='running'
        for update
      `;
      if (!run) throw new Error("Run cannot start browser research.");
      let provider = input.provider ?? "kernel";
      let profileConfigurationVersion: string | number | null = null;
      if (input.profileId) {
        const [profile] = await tx<
          { provider: string; configuration_version: string | number }[]
        >`
          select p.provider,p.configuration_version from public.browser_profiles p
          where p.id=${input.profileId} and p.workspace_id=${input.workspaceId}
            and p.status='active' and p.provider_profile_id is not null
            and not exists (
              select 1 from app_private.browser_control_sessions cs
              where cs.profile_id=p.id and cs.workspace_id=p.workspace_id
                and cs.status in ('active','cleanup_pending')
            )
            and not exists (
              select 1 from unnest(${allowedOrigins}::text[]) requested(origin)
              where not exists (
                select 1 from public.browser_profile_origins configured
                where configured.profile_id=p.id and configured.workspace_id=p.workspace_id
                  and configured.origin=requested.origin
              )
            )
          for update
        `;
        if (!profile)
          throw new Error(
            "Browser profile is unavailable for the exact origin policy.",
          );
        provider = profile.provider;
        profileConfigurationVersion = profile.configuration_version;
      }
      const [position] = await tx<{ next_position: number }[]>`
        select coalesce(max(position),-1)+1 as next_position
        from public.workflow_steps where run_id=${input.runId}
      `;
      const executionId = randomUUID();
      const stepId = randomUUID();
      const correlationId = randomUUID();
      const mode = input.profileId
        ? "persistent_read_only"
        : "ephemeral_read_only";
      const policy = {
        mode,
        allowedOrigins,
        maxSteps,
        maxDurationSeconds,
        maxCostUnits,
        actionSchema: "browser-read-v1",
        redaction: "semantic-v1",
      };
      await tx`
        insert into public.workflow_steps (
          id,workspace_id,run_id,position,kind,tool_name,status,
          execution_phase,input,input_hash,attempt,max_attempts,started_at
        ) values (
          ${stepId},${input.workspaceId},${input.runId},${position?.next_position ?? 0},
          'tool','browser.research','running','invocation_started',
          ${tx.json(toJson({ goal: input.goal, startUrl: startUrl.toString(), policy }))},
          ${payloadHash({ goal: input.goal, startUrl: startUrl.toString(), policy })},1,1,now()
        )
      `;
      await tx`
        insert into public.browser_executions (
          id,workspace_id,run_id,step_id,profile_id,profile_configuration_version,
          mode,status,goal_hash,
          policy_hash,max_steps,max_duration_seconds,max_cost_units
        ) values (
          ${executionId},${input.workspaceId},${input.runId},${stepId},
          ${input.profileId ?? null},${profileConfigurationVersion},
          ${mode},'queued',${payloadHash(input.goal)},
          ${payloadHash(policy)},${maxSteps},${maxDurationSeconds},${maxCostUnits}
        )
      `;
      await tx`
        insert into app_private.browser_execution_handles (
          execution_id,workspace_id,provider,correlation_id,allowed_origins,start_url,goal
        ) values (
          ${executionId},${input.workspaceId},${provider},${correlationId},
          ${tx.json(toJson(allowedOrigins))},${startUrl.toString()},${input.goal.trim()}
        )
      `;
      await tx`
        insert into app_private.browser_execution_slices (
          execution_id,workspace_id,ordinal,status
        ) values (${executionId},${input.workspaceId},0,'queued')
      `;
      await tx`select pgmq.send('agent_jobs', ${tx.json(
        toJson({
          type: "browser_slice",
          executionId,
          workspaceId: input.workspaceId,
        }),
      )}::jsonb)`;
      const updated = await tx`
        update public.agent_runs set status='waiting_event',waiting_for=${executionId},
          claim_token=null,lease_expires_at=null
        where id=${input.runId} and workspace_id=${input.workspaceId}
          and status='running' and claim_token=${input.claimToken}
        returning id
      `;
      if (updated.length !== 1)
        throw new Error("Run changed while browser research was queued.");
      await this.#writeAuditEvent(tx, {
        workspaceId: input.workspaceId,
        actor: "worker",
        action: "browser.execution.created",
        eventKey: `browser_execution:${executionId}:created`,
        targetType: "browser_execution",
        targetId: executionId,
        runId: input.runId,
        stepId,
        detail: { mode, policyHash: payloadHash(policy) },
      });
      return { executionId };
    });
  }

  async claimBrowserExecutionSlice(input: {
    executionId: string;
    workspaceId: string;
    claimToken: string;
    leaseSeconds?: number;
  }): Promise<
    | {
        executionId: string;
        workspaceId: string;
        runId: string;
        stepId: string;
        sliceId: string;
        ordinal: number;
        leaseEpoch: number;
        mode: "ephemeral_read_only" | "persistent_read_only";
        goal: string;
        startUrl: string;
        allowedOrigins: readonly string[];
        provider: string;
        correlationId: string;
        providerSessionId?: string;
        providerPhase: string;
        profileId?: string;
        providerProfileId?: string;
        remainingSteps: number;
        remainingCostUnits: number;
        deadlineAt: string;
      }
    | undefined
  > {
    const leaseSeconds = Math.min(Math.max(input.leaseSeconds ?? 60, 10), 120);
    return this.#sql.begin(async (tx) => {
      const [row] = await tx<
        {
          run_id: string;
          step_id: string;
          profile_id: string | null;
          profile_configuration_version: string | number | null;
          mode: "ephemeral_read_only" | "persistent_read_only";
          max_steps: number;
          steps_completed: number;
          max_duration_seconds: number;
          max_cost_units: number;
          cost_units_used: number;
          started_at: Date | null;
          provider: string;
          correlation_id: string;
          provider_session_id: string | null;
          provider_phase: string;
          lease_epoch: string | number;
          lease_token_hash: string | null;
          lease_expires_at: Date | null;
          allowed_origins: string[];
          start_url: string;
          goal: string;
          provider_profile_id: string | null;
        }[]
      >`
        select e.run_id,e.step_id,e.profile_id,e.profile_configuration_version,
          e.mode,e.max_steps,e.steps_completed,
          e.max_duration_seconds,e.max_cost_units,e.cost_units_used,e.started_at,h.provider,h.correlation_id,
          h.provider_session_id,h.provider_phase,h.lease_epoch,h.lease_token_hash,
          h.lease_expires_at,h.allowed_origins,h.start_url,h.goal,p.provider_profile_id
        from public.browser_executions e
        join app_private.browser_execution_handles h on h.execution_id=e.id
          and h.workspace_id=e.workspace_id
        left join public.browser_profiles p on p.id=e.profile_id and p.workspace_id=e.workspace_id
        where e.id=${input.executionId} and e.workspace_id=${input.workspaceId}
          and e.status in ('queued','running')
          and e.steps_completed < e.max_steps
          and (h.lease_expires_at is null or h.lease_expires_at<=now())
          and (
            e.profile_id is null or (
              p.status='active'
              and p.configuration_version=e.profile_configuration_version
              and p.provider_profile_id is not null
            )
          )
        for update of e,h
      `;
      if (!row) return;
      const [slice] = await tx<
        { id: string; ordinal: number; cost_reserved: boolean }[]
      >`
        select id,ordinal,cost_reserved from app_private.browser_execution_slices
        where execution_id=${input.executionId} and workspace_id=${input.workspaceId}
          and status in ('queued','claimed','observation_recorded')
        order by ordinal asc limit 1 for update
      `;
      if (!slice) return;
      const nextEpoch = Number(row.lease_epoch) + 1;
      if (!slice.cost_reserved) {
        const reserved = await tx`
          update public.browser_executions
          set cost_units_used=cost_units_used+1
          where id=${input.executionId} and workspace_id=${input.workspaceId}
            and cost_units_used < max_cost_units
          returning id
        `;
        if (reserved.length !== 1) return;
      }
      await tx`
        update app_private.browser_execution_handles
        set lease_epoch=${nextEpoch},lease_token_hash=${payloadHash(input.claimToken)},
          lease_expires_at=now()+make_interval(secs=>${leaseSeconds}),controller='worker'
        where execution_id=${input.executionId} and workspace_id=${input.workspaceId}
      `;
      await tx`
        update app_private.browser_execution_slices
        set status='claimed',lease_epoch=${nextEpoch},started_at=coalesce(started_at,now()),
          cost_reserved=true,
          redacted_observation=null,observation_hash=null,decision=null,
          decision_hash=null,action_hash=null,result_hash=null
        where id=${slice.id}
      `;
      const [execution] = await tx<{ started_at: Date }[]>`
        update public.browser_executions set status='running',started_at=coalesce(started_at,now())
        where id=${input.executionId} returning started_at
      `;
      if (!execution) return;
      return {
        executionId: input.executionId,
        workspaceId: input.workspaceId,
        runId: row.run_id,
        stepId: row.step_id,
        sliceId: slice.id,
        ordinal: slice.ordinal,
        leaseEpoch: nextEpoch,
        mode: row.mode,
        goal: row.goal,
        startUrl: row.start_url,
        allowedOrigins: row.allowed_origins,
        provider: row.provider,
        correlationId: row.correlation_id,
        ...(row.provider_session_id
          ? { providerSessionId: row.provider_session_id }
          : {}),
        providerPhase: row.provider_phase,
        ...(row.profile_id ? { profileId: row.profile_id } : {}),
        ...(row.provider_profile_id
          ? { providerProfileId: row.provider_profile_id }
          : {}),
        remainingSteps: row.max_steps - row.steps_completed,
        remainingCostUnits:
          row.max_cost_units -
          row.cost_units_used -
          (slice.cost_reserved ? 0 : 1),
        deadlineAt: new Date(
          execution.started_at.getTime() + row.max_duration_seconds * 1_000,
        ).toISOString(),
      };
    });
  }

  async renewBrowserExecutionLease(input: {
    executionId: string;
    workspaceId: string;
    claimToken: string;
    leaseEpoch: number;
    leaseSeconds?: number;
  }): Promise<void> {
    const leaseSeconds = Math.min(Math.max(input.leaseSeconds ?? 60, 10), 120);
    const updated = await this.#sql`
      update app_private.browser_execution_handles
      set lease_expires_at=now()+make_interval(secs=>${leaseSeconds})
      where execution_id=${input.executionId} and workspace_id=${input.workspaceId}
        and lease_epoch=${input.leaseEpoch}
        and lease_token_hash=${payloadHash(input.claimToken)}
        and lease_expires_at>now()
        and provider_phase not in ('cleanup_requested','deleted','cleanup_unknown')
      returning execution_id
    `;
    if (updated.length !== 1)
      throw new Error("Browser execution lease was lost.");
  }

  async validateBrowserSliceAction(input: {
    executionId: string;
    workspaceId: string;
    sliceId: string;
    claimToken: string;
    leaseEpoch: number;
    decision: Extract<BrowserReadDecision, { type: "act" }>;
    actionHash: string;
  }): Promise<void> {
    const decision = browserReadDecisionSchema.parse(input.decision);
    const updated = await this.#sql`
      update app_private.browser_execution_slices s
      set status='action_validated',decision=${this.#sql.json(toJson(decision))},
        decision_hash=${payloadHash(decision)},action_hash=${input.actionHash}
      where s.id=${input.sliceId} and s.execution_id=${input.executionId}
        and s.workspace_id=${input.workspaceId} and s.status='observation_recorded'
        and s.lease_epoch=${input.leaseEpoch}
        and exists (
          select 1 from app_private.browser_execution_handles h
          where h.execution_id=s.execution_id and h.workspace_id=s.workspace_id
            and h.lease_epoch=${input.leaseEpoch}
            and h.lease_token_hash=${payloadHash(input.claimToken)}
            and h.lease_expires_at>now()
        ) returning id
    `;
    if (updated.length !== 1)
      throw new Error("Browser action validation fence was lost.");
  }

  async markBrowserSliceInvocationStarted(input: {
    executionId: string;
    workspaceId: string;
    sliceId: string;
    claimToken: string;
    leaseEpoch: number;
    actionHash: string;
  }): Promise<void> {
    const updated = await this.#sql`
      update app_private.browser_execution_slices s set status='invocation_started'
      where s.id=${input.sliceId} and s.execution_id=${input.executionId}
        and s.workspace_id=${input.workspaceId} and s.status='action_validated'
        and s.action_hash=${input.actionHash} and s.lease_epoch=${input.leaseEpoch}
        and exists (
          select 1 from app_private.browser_execution_handles h
          where h.execution_id=s.execution_id and h.workspace_id=s.workspace_id
            and h.lease_epoch=${input.leaseEpoch}
            and h.lease_token_hash=${payloadHash(input.claimToken)}
            and h.lease_expires_at>now()
        ) returning id
    `;
    if (updated.length !== 1)
      throw new Error("Browser invocation fence was lost.");
  }

  async markBrowserSliceInvocationUnknown(input: {
    executionId: string;
    workspaceId: string;
    sliceId: string;
    claimToken: string;
    leaseEpoch: number;
    errorCode: string;
  }): Promise<void> {
    await this.#sql.begin(async (tx) => {
      const updated = await tx`
        update app_private.browser_execution_slices s
        set status='unknown',last_error_code=${input.errorCode},completed_at=now()
        where s.id=${input.sliceId} and s.execution_id=${input.executionId}
          and s.workspace_id=${input.workspaceId} and s.status='invocation_started'
          and s.lease_epoch=${input.leaseEpoch}
          and exists (
            select 1 from app_private.browser_execution_handles h
            where h.execution_id=s.execution_id and h.workspace_id=s.workspace_id
              and h.lease_epoch=${input.leaseEpoch}
              and h.lease_token_hash=${payloadHash(input.claimToken)}
          ) returning id
      `;
      if (updated.length !== 1)
        throw new Error("Browser unknown-outcome fence was lost.");
      await tx`
        update public.browser_executions set status='cleanup_pending',last_error_code=${input.errorCode}
        where id=${input.executionId} and workspace_id=${input.workspaceId}
          and status='running'
      `;
      await tx`
        update app_private.browser_execution_handles
        set provider_phase='cleanup_requested',lease_token_hash=null,
          lease_expires_at=null,controller=null
        where execution_id=${input.executionId} and workspace_id=${input.workspaceId}
          and lease_epoch=${input.leaseEpoch}
      `;
      await tx`select pgmq.send('agent_jobs', ${tx.json(
        toJson({
          type: "browser_cleanup",
          executionId: input.executionId,
          workspaceId: input.workspaceId,
        }),
      )}::jsonb)`;
    });
  }

  async requestBrowserExecutionCleanup(input: {
    executionId: string;
    workspaceId: string;
    sliceId: string;
    claimToken: string;
    leaseEpoch: number;
    errorCode: string;
  }): Promise<void> {
    await this.#sql.begin(async (tx) => {
      const slice = await tx`
        update app_private.browser_execution_slices s
        set status='failed',last_error_code=${input.errorCode},completed_at=now()
        where s.id=${input.sliceId} and s.execution_id=${input.executionId}
          and s.workspace_id=${input.workspaceId}
          and s.status in ('claimed','observation_recorded','action_validated')
          and s.lease_epoch=${input.leaseEpoch}
          and exists (
            select 1 from app_private.browser_execution_handles h
            where h.execution_id=s.execution_id and h.workspace_id=s.workspace_id
              and h.lease_epoch=${input.leaseEpoch}
              and h.lease_token_hash=${payloadHash(input.claimToken)}
          ) returning id
      `;
      if (slice.length !== 1) return;
      await tx`
        update public.browser_executions
        set status='cleanup_pending',last_error_code=${input.errorCode}
        where id=${input.executionId} and workspace_id=${input.workspaceId}
          and status='running'
      `;
      await tx`
        update app_private.browser_execution_handles
        set provider_phase='cleanup_requested',lease_token_hash=null,
          lease_expires_at=null,controller=null
        where execution_id=${input.executionId} and workspace_id=${input.workspaceId}
      `;
      await tx`select pgmq.send('agent_jobs', ${tx.json(
        toJson({
          type: "browser_cleanup",
          executionId: input.executionId,
          workspaceId: input.workspaceId,
        }),
      )}::jsonb)`;
    });
  }

  async claimBrowserExecutionCleanup(input: {
    executionId: string;
    workspaceId: string;
    claimToken: string;
    leaseSeconds?: number;
  }): Promise<
    | {
        executionId: string;
        workspaceId: string;
        correlationId: string;
        providerSessionId?: string;
        leaseEpoch: number;
        summary?: string;
        errorCode?: string;
        unknown: boolean;
      }
    | undefined
  > {
    const leaseSeconds = Math.min(Math.max(input.leaseSeconds ?? 60, 10), 120);
    return this.#sql.begin(async (tx) => {
      const [row] = await tx<
        {
          correlation_id: string;
          provider_session_id: string | null;
          lease_epoch: string | number;
          lease_expires_at: Date | null;
          last_error_code: string | null;
          summary: string | null;
        }[]
      >`
        select h.correlation_id,h.provider_session_id,h.lease_epoch,h.lease_expires_at,
          e.last_error_code,
          (select s.decision->>'summary' from app_private.browser_execution_slices s
            where s.execution_id=e.id and s.workspace_id=e.workspace_id
            order by s.ordinal desc limit 1) as summary
        from app_private.browser_execution_handles h
        join public.browser_executions e on e.id=h.execution_id and e.workspace_id=h.workspace_id
        where h.execution_id=${input.executionId} and h.workspace_id=${input.workspaceId}
          and e.status='cleanup_pending'
          and h.provider_phase in ('cleanup_requested','cleanup_unknown','deleted')
          and (h.lease_expires_at is null or h.lease_expires_at<=now())
        for update of h,e
      `;
      if (!row) return;
      const leaseEpoch = Number(row.lease_epoch) + 1;
      await tx`
        update app_private.browser_execution_handles
        set lease_epoch=${leaseEpoch},lease_token_hash=${payloadHash(input.claimToken)},
          lease_expires_at=now()+make_interval(secs=>${leaseSeconds}),controller='cleanup'
        where execution_id=${input.executionId} and workspace_id=${input.workspaceId}
      `;
      return {
        executionId: input.executionId,
        workspaceId: input.workspaceId,
        correlationId: row.correlation_id,
        ...(row.provider_session_id
          ? { providerSessionId: row.provider_session_id }
          : {}),
        leaseEpoch,
        ...(row.summary ? { summary: row.summary } : {}),
        ...(row.last_error_code ? { errorCode: row.last_error_code } : {}),
        unknown: row.last_error_code === "provider_action_outcome_unknown",
      };
    });
  }

  async bindBrowserExecutionSession(input: {
    executionId: string;
    workspaceId: string;
    claimToken: string;
    leaseEpoch: number;
    providerSessionId: string;
    sessionExpiresAt: string;
    guardsInstalled: boolean;
  }): Promise<void> {
    const updated = await this.#sql`
      update app_private.browser_execution_handles
      set provider_session_id=${input.providerSessionId},
        session_expires_at=${new Date(input.sessionExpiresAt)},
        provider_phase=${input.guardsInstalled ? "guards_installed" : "session_bound"}
      where execution_id=${input.executionId} and workspace_id=${input.workspaceId}
        and lease_epoch=${input.leaseEpoch}
        and lease_token_hash=${payloadHash(input.claimToken)}
        and lease_expires_at>now()
        and provider_phase in ('not_started','start_requested','session_bound','guards_installed')
      returning execution_id
    `;
    if (updated.length !== 1)
      throw new Error("Browser execution lease was lost.");
  }

  async recordBrowserSliceObservation(input: {
    executionId: string;
    workspaceId: string;
    sliceId: string;
    claimToken: string;
    leaseEpoch: number;
    observation: BrowserReadObservation;
  }): Promise<void> {
    const observation = browserReadObservationSchema.parse(input.observation);
    const updated = await this.#sql`
      update app_private.browser_execution_slices s
      set status='observation_recorded',observation_hash=${observation.hash},
        redacted_observation=${this.#sql.json(toJson(observation))}
      where s.id=${input.sliceId} and s.execution_id=${input.executionId}
        and s.workspace_id=${input.workspaceId} and s.status='claimed'
        and s.lease_epoch=${input.leaseEpoch}
        and exists (
          select 1 from app_private.browser_execution_handles h
          where h.execution_id=s.execution_id and h.workspace_id=s.workspace_id
            and h.lease_epoch=${input.leaseEpoch}
            and h.lease_token_hash=${payloadHash(input.claimToken)}
            and h.lease_expires_at>now()
        ) returning id
    `;
    if (updated.length !== 1)
      throw new Error("Browser observation fence was lost.");
  }

  async markBrowserBootstrapInvocationStarted(input: {
    executionId: string;
    workspaceId: string;
    sliceId: string;
    claimToken: string;
    leaseEpoch: number;
    actionHash: string;
  }): Promise<void> {
    const updated = await this.#sql`
      update app_private.browser_execution_slices s
      set status='invocation_started',action_hash=${input.actionHash}
      where s.id=${input.sliceId} and s.execution_id=${input.executionId}
        and s.workspace_id=${input.workspaceId} and s.status='claimed'
        and s.lease_epoch=${input.leaseEpoch}
        and exists (
          select 1 from app_private.browser_execution_handles h
          where h.execution_id=s.execution_id and h.workspace_id=s.workspace_id
            and h.lease_epoch=${input.leaseEpoch}
            and h.lease_token_hash=${payloadHash(input.claimToken)}
            and h.lease_expires_at>now() and h.provider_phase='guards_installed'
        ) returning id
    `;
    if (updated.length !== 1)
      throw new Error("Browser bootstrap invocation fence was lost.");
  }

  async completeBrowserBootstrapInvocation(input: {
    executionId: string;
    workspaceId: string;
    sliceId: string;
    claimToken: string;
    leaseEpoch: number;
    actionHash: string;
    resultHash: string;
  }): Promise<void> {
    const updated = await this.#sql`
      update app_private.browser_execution_slices s
      set status='claimed',result_hash=${input.resultHash}
      where s.id=${input.sliceId} and s.execution_id=${input.executionId}
        and s.workspace_id=${input.workspaceId} and s.status='invocation_started'
        and s.action_hash=${input.actionHash} and s.lease_epoch=${input.leaseEpoch}
        and exists (
          select 1 from app_private.browser_execution_handles h
          where h.execution_id=s.execution_id and h.workspace_id=s.workspace_id
            and h.lease_epoch=${input.leaseEpoch}
            and h.lease_token_hash=${payloadHash(input.claimToken)}
            and h.lease_expires_at>now()
        ) returning id
    `;
    if (updated.length !== 1)
      throw new Error("Browser bootstrap result fence was lost.");
  }

  async abortBrowserExecutionSlice(input: {
    executionId: string;
    workspaceId: string;
    sliceId: string;
    claimToken: string;
    leaseEpoch: number;
    decision: Exclude<BrowserReadDecision, { type: "act" }>;
    errorCode: string;
  }): Promise<void> {
    const decision = browserReadDecisionSchema.parse(input.decision);
    const updated = await this.#sql`
      update app_private.browser_execution_slices s
      set status='failed',decision=${this.#sql.json(toJson(decision))},
        decision_hash=${payloadHash(decision)},last_error_code=${input.errorCode},
        completed_at=now()
      where s.id=${input.sliceId} and s.execution_id=${input.executionId}
        and s.workspace_id=${input.workspaceId} and s.status='claimed'
        and s.lease_epoch=${input.leaseEpoch}
        and exists (
          select 1 from app_private.browser_execution_handles h
          where h.execution_id=s.execution_id and h.workspace_id=s.workspace_id
            and h.lease_epoch=${input.leaseEpoch}
            and h.lease_token_hash=${payloadHash(input.claimToken)}
            and h.lease_expires_at>now()
        ) returning id
    `;
    if (updated.length !== 1) throw new Error("Browser abort fence was lost.");
  }

  async completeBrowserExecutionSlice(input: {
    executionId: string;
    workspaceId: string;
    sliceId: string;
    claimToken: string;
    leaseEpoch: number;
    decision: BrowserReadDecision;
    actionHash?: string;
    resultHash?: string;
  }): Promise<{ nextQueued: boolean; exhausted: boolean }> {
    const decision = browserReadDecisionSchema.parse(input.decision);
    return this.#sql.begin(async (tx) => {
      const [slice] = await tx<{ ordinal: number }[]>`
        update app_private.browser_execution_slices s
        set status='completed',decision=${tx.json(toJson(decision))},
          decision_hash=${payloadHash(decision)},action_hash=${input.actionHash ?? null},
          result_hash=${input.resultHash ?? null},completed_at=now()
        where s.id=${input.sliceId} and s.execution_id=${input.executionId}
          and s.workspace_id=${input.workspaceId}
          and s.status=${decision.type === "act" ? "invocation_started" : "observation_recorded"}
          and s.lease_epoch=${input.leaseEpoch}
          and exists (
            select 1 from app_private.browser_execution_handles h
            where h.execution_id=s.execution_id and h.workspace_id=s.workspace_id
              and h.lease_epoch=${input.leaseEpoch}
              and h.lease_token_hash=${payloadHash(input.claimToken)}
              and h.lease_expires_at>now()
          ) returning ordinal
      `;
      if (!slice) throw new Error("Browser action fence was lost.");
      const [execution] = await tx<
        {
          steps_completed: number;
          max_steps: number;
          cost_units_used: number;
          max_cost_units: number;
        }[]
      >`
        update public.browser_executions
        set steps_completed=steps_completed+1
        where id=${input.executionId} and workspace_id=${input.workspaceId}
          and status='running'
        returning steps_completed,max_steps,cost_units_used,max_cost_units
      `;
      if (!execution) throw new Error("Browser execution state changed.");
      const exhausted =
        execution.steps_completed >= execution.max_steps ||
        execution.cost_units_used >= execution.max_cost_units;
      const shouldQueue = decision.type === "act" && !exhausted;
      if (shouldQueue) {
        await tx`
          insert into app_private.browser_execution_slices (
            execution_id,workspace_id,ordinal,status
          ) values (${input.executionId},${input.workspaceId},${slice.ordinal + 1},'queued')
        `;
        await tx`select pgmq.send('agent_jobs', ${tx.json(
          toJson({
            type: "browser_slice",
            executionId: input.executionId,
            workspaceId: input.workspaceId,
          }),
        )}::jsonb)`;
      }
      if (shouldQueue)
        await tx`
          update app_private.browser_execution_handles
          set lease_token_hash=null,lease_expires_at=null,controller=null
          where execution_id=${input.executionId} and workspace_id=${input.workspaceId}
            and lease_epoch=${input.leaseEpoch}
            and lease_token_hash=${payloadHash(input.claimToken)}
        `;
      return { nextQueued: shouldQueue, exhausted };
    });
  }

  async requestBrowserExecutionHandoff(input: {
    handoffId: string;
    executionId: string;
    workspaceId: string;
    sliceId: string;
    claimToken: string;
    leaseEpoch: number;
    decision: Extract<BrowserReadDecision, { type: "request_owner_takeover" }>;
    providerSessionId: string;
    reasonCode: string;
    expiresAt: string;
  }): Promise<void> {
    const decision = browserReadDecisionSchema.parse(input.decision);
    await this.#sql.begin(async (tx) => {
      const [slice] = await tx<{ ordinal: number }[]>`
        update app_private.browser_execution_slices s
        set status='completed',decision=${tx.json(toJson(decision))},
          decision_hash=${payloadHash(decision)},completed_at=now()
        where s.id=${input.sliceId} and s.execution_id=${input.executionId}
          and s.workspace_id=${input.workspaceId}
          and s.status in ('claimed','observation_recorded')
          and s.lease_epoch=${input.leaseEpoch}
          and exists (
            select 1 from app_private.browser_execution_handles h
            where h.execution_id=s.execution_id and h.workspace_id=s.workspace_id
              and h.provider_session_id=${input.providerSessionId}
              and h.lease_epoch=${input.leaseEpoch}
              and h.lease_token_hash=${payloadHash(input.claimToken)}
              and h.lease_expires_at>now()
          ) returning ordinal
      `;
      if (!slice) throw new Error("Browser handoff fence was lost.");
      const execution = await tx`
        update public.browser_executions
        set status='waiting_owner',steps_completed=steps_completed+1,
          last_error_code=${input.reasonCode}
        where id=${input.executionId} and workspace_id=${input.workspaceId}
          and status='running' returning id
      `;
      if (execution.length !== 1)
        throw new Error("Browser handoff execution state changed.");
      await tx`
        insert into public.browser_handoffs (
          id,workspace_id,execution_id,status,reason_code,expires_at
        ) values (
          ${input.handoffId},${input.workspaceId},${input.executionId},'requested',
          ${input.reasonCode},${new Date(input.expiresAt)}
        )
      `;
      await tx`
        insert into app_private.browser_handoff_handles (
          handoff_id,workspace_id,provider_session_id
        ) values (${input.handoffId},${input.workspaceId},${input.providerSessionId})
      `;
      await tx`
        update app_private.browser_execution_handles
        set lease_token_hash=null,lease_expires_at=null,controller='owner'
        where execution_id=${input.executionId} and workspace_id=${input.workspaceId}
          and lease_epoch=${input.leaseEpoch}
      `;
      await this.#writeAuditEvent(tx, {
        workspaceId: input.workspaceId,
        actor: "worker",
        action: "browser.handoff.requested",
        eventKey: `browser_handoff:${input.handoffId}:requested`,
        targetType: "browser_execution",
        targetId: input.executionId,
        detail: { reasonCode: input.reasonCode },
      });
    });
  }

  async accessBrowserExecutionHandoff(input: {
    handoffId: string;
    workspaceId: string;
  }): Promise<{ providerSessionId: string }> {
    return this.#sql.begin(async (tx) => {
      const [row] = await tx<{ provider_session_id: string }[]>`
        select hh.provider_session_id
        from public.browser_handoffs bh
        join app_private.browser_handoff_handles hh
          on hh.handoff_id=bh.id and hh.workspace_id=bh.workspace_id
        where bh.id=${input.handoffId} and bh.workspace_id=${input.workspaceId}
          and bh.status in ('requested','active') and bh.expires_at>now()
          and hh.access_count<20
        for update of bh,hh
      `;
      if (!row) throw new Error("Browser handoff is unavailable.");
      await tx`
        update public.browser_handoffs set status='active',
          first_accessed_at=coalesce(first_accessed_at,now())
        where id=${input.handoffId} and workspace_id=${input.workspaceId}
      `;
      await tx`
        update app_private.browser_handoff_handles
        set access_count=access_count+1,last_accessed_at=now()
        where handoff_id=${input.handoffId} and workspace_id=${input.workspaceId}
      `;
      return { providerSessionId: row.provider_session_id };
    });
  }

  async listPendingBrowserHandoffNotifications(
    limit = 20,
  ): Promise<readonly { id: string; workspaceId: string }[]> {
    const rows = await this.#sql<{ id: string; workspace_id: string }[]>`
      select bh.id,bh.workspace_id from public.browser_handoffs bh
      join app_private.browser_handoff_handles hh
        on hh.handoff_id=bh.id and hh.workspace_id=bh.workspace_id
      where bh.status in ('requested','active') and bh.expires_at>now()
        and hh.notification_status='pending' and hh.notification_attempts<100
      order by bh.created_at asc limit ${Math.min(Math.max(limit, 1), 100)}
    `;
    return rows.map((row) => ({ id: row.id, workspaceId: row.workspace_id }));
  }

  async markBrowserHandoffNotificationSent(input: {
    handoffId: string;
    workspaceId: string;
  }): Promise<void> {
    await this.#sql`
      update app_private.browser_handoff_handles
      set notification_status='sent',notification_attempts=notification_attempts+1,
        notification_sent_at=now()
      where handoff_id=${input.handoffId} and workspace_id=${input.workspaceId}
        and notification_status='pending'
    `;
  }

  async recordBrowserHandoffNotificationFailure(input: {
    handoffId: string;
    workspaceId: string;
  }): Promise<void> {
    await this.#sql`
      update app_private.browser_handoff_handles
      set notification_attempts=least(notification_attempts+1,100)
      where handoff_id=${input.handoffId} and workspace_id=${input.workspaceId}
        and notification_status='pending'
    `;
  }

  async completeBrowserExecutionHandoff(input: {
    handoffId: string;
    workspaceId: string;
  }): Promise<void> {
    await this.#sql.begin(async (tx) => {
      const [handoff] = await tx<
        { execution_id: string; reason_code: string }[]
      >`
        update public.browser_handoffs set status='completed',completed_at=now()
        where id=${input.handoffId} and workspace_id=${input.workspaceId}
          and status in ('requested','active') and expires_at>now()
        returning execution_id,reason_code
      `;
      if (!handoff) throw new Error("Browser handoff cannot be completed.");
      const [execution] = await tx<
        {
          steps_completed: number;
          max_steps: number;
          cost_units_used: number;
          max_cost_units: number;
        }[]
      >`
        select steps_completed,max_steps,cost_units_used,max_cost_units
        from public.browser_executions
        where id=${handoff.execution_id} and workspace_id=${input.workspaceId}
          and status='waiting_owner' for update
      `;
      if (!execution) throw new Error("Browser handoff execution changed.");
      const cannotResume =
        handoff.reason_code === "provider_read_only_isolation_unavailable" ||
        execution.steps_completed >= execution.max_steps ||
        execution.cost_units_used >= execution.max_cost_units;
      if (cannotResume) {
        await tx`
          update public.browser_executions
          set status='cleanup_pending',
            last_error_code=case
              when ${handoff.reason_code}='provider_read_only_isolation_unavailable' then null
              else 'browser_budget_exhausted_after_handoff'
            end
          where id=${handoff.execution_id} and workspace_id=${input.workspaceId}
            and status='waiting_owner'
        `;
        await tx`
          update app_private.browser_execution_handles
          set provider_phase='cleanup_requested',controller=null,
            lease_token_hash=null,lease_expires_at=null
          where execution_id=${handoff.execution_id} and workspace_id=${input.workspaceId}
        `;
        await tx`select pgmq.send('agent_jobs', ${tx.json(
          toJson({
            type: "browser_cleanup",
            executionId: handoff.execution_id,
            workspaceId: input.workspaceId,
          }),
        )}::jsonb)`;
        return;
      }
      const [ordinal] = await tx<{ ordinal: number }[]>`
        select coalesce(max(ordinal),-1)::integer as ordinal
        from app_private.browser_execution_slices
        where execution_id=${handoff.execution_id} and workspace_id=${input.workspaceId}
      `;
      await tx`
        insert into app_private.browser_execution_slices (
          execution_id,workspace_id,ordinal,status
        ) values (
          ${handoff.execution_id},${input.workspaceId},${(ordinal?.ordinal ?? -1) + 1},'queued'
        )
      `;
      await tx`
        update public.browser_executions set status='queued',last_error_code=null
        where id=${handoff.execution_id} and workspace_id=${input.workspaceId}
          and status='waiting_owner'
      `;
      await tx`
        update app_private.browser_execution_handles set controller=null
        where execution_id=${handoff.execution_id} and workspace_id=${input.workspaceId}
          and controller='owner'
      `;
      await tx`select pgmq.send('agent_jobs', ${tx.json(
        toJson({
          type: "browser_slice",
          executionId: handoff.execution_id,
          workspaceId: input.workspaceId,
        }),
      )}::jsonb)`;
    });
  }

  async expireBrowserExecutionHandoffs(limit = 50): Promise<number> {
    return this.#sql.begin(async (tx) => {
      const rows = await tx<
        { id: string; execution_id: string; workspace_id: string }[]
      >`
        select id,execution_id,workspace_id from public.browser_handoffs
        where status in ('requested','active') and expires_at<=now()
        order by expires_at asc limit ${Math.min(Math.max(limit, 1), 200)}
        for update skip locked
      `;
      for (const row of rows) {
        await tx`
          update public.browser_handoffs set status='expired'
          where id=${row.id} and status in ('requested','active')
        `;
        await tx`
          update public.browser_executions
          set status='cleanup_pending',last_error_code='owner_handoff_expired'
          where id=${row.execution_id} and workspace_id=${row.workspace_id}
            and status='waiting_owner'
        `;
        await tx`
          update app_private.browser_execution_handles
          set provider_phase='cleanup_requested',controller=null,
            lease_token_hash=null,lease_expires_at=null
          where execution_id=${row.execution_id} and workspace_id=${row.workspace_id}
        `;
        await tx`select pgmq.send('agent_jobs', ${tx.json(
          toJson({
            type: "browser_cleanup",
            executionId: row.execution_id,
            workspaceId: row.workspace_id,
          }),
        )}::jsonb)`;
      }
      return rows.length;
    });
  }

  async recoverStaleBrowserExecutions(limit = 100): Promise<number> {
    return this.#sql.begin(async (tx) => {
      const validated = await tx`
        update app_private.browser_execution_slices s
        set status='observation_recorded',decision=null,decision_hash=null,action_hash=null
        from app_private.browser_execution_handles h
        where s.execution_id=h.execution_id and s.workspace_id=h.workspace_id
          and s.status='action_validated'
          and (h.lease_expires_at is null or h.lease_expires_at<=now())
      `;
      const unknown = await tx<
        { execution_id: string; workspace_id: string }[]
      >`
        update app_private.browser_execution_slices s
        set status='unknown',last_error_code='provider_action_outcome_unknown',
          completed_at=coalesce(completed_at,now())
        from app_private.browser_execution_handles h
        where s.execution_id=h.execution_id and s.workspace_id=h.workspace_id
          and s.status='invocation_started'
          and (h.lease_expires_at is null or h.lease_expires_at<=now())
        returning s.execution_id,s.workspace_id
      `;
      for (const row of unknown)
        await tx`
          update public.browser_executions
          set status='cleanup_pending',last_error_code='provider_action_outcome_unknown'
          where id=${row.execution_id} and workspace_id=${row.workspace_id}
            and status='running'
        `;
      await tx`
        update public.browser_executions e
        set status='cleanup_pending',
          last_error_code=coalesce(e.last_error_code,'browser_cleanup_recovered')
        from app_private.browser_execution_handles h
        where h.execution_id=e.id and h.workspace_id=e.workspace_id
          and e.status='running'
          and (h.lease_expires_at is null or h.lease_expires_at<=now())
          and not exists (
            select 1 from app_private.browser_execution_slices s
            where s.execution_id=e.id and s.workspace_id=e.workspace_id
              and s.status in (
                'queued','claimed','observation_recorded','action_validated','invocation_started'
              )
          )
      `;
      await tx`
        update app_private.browser_execution_handles h
        set provider_phase=case
              when h.provider_phase='deleted' then 'deleted'
              else 'cleanup_requested'
            end,
          lease_token_hash=null,lease_expires_at=null,controller=null
        from public.browser_executions e
        where e.id=h.execution_id and e.workspace_id=h.workspace_id
          and e.status='cleanup_pending'
          and (h.lease_expires_at is null or h.lease_expires_at<=now())
      `;
      const pending = await tx<{ id: string; workspace_id: string }[]>`
        select e.id,e.workspace_id from public.browser_executions e
        join app_private.browser_execution_handles h
          on h.execution_id=e.id and h.workspace_id=e.workspace_id
        where e.status='cleanup_pending'
          and (h.lease_expires_at is null or h.lease_expires_at<=now())
        order by e.updated_at asc limit ${Math.min(Math.max(limit, 1), 500)}
      `;
      for (const row of pending)
        await tx`select pgmq.send('agent_jobs', ${tx.json(
          toJson({
            type: "browser_cleanup",
            executionId: row.id,
            workspaceId: row.workspace_id,
          }),
        )}::jsonb)`;
      return validated.count + unknown.length + pending.length;
    });
  }

  async finishBrowserExecution(input: {
    executionId: string;
    workspaceId: string;
    claimToken: string;
    leaseEpoch: number;
    summary?: string;
    errorCode?: string;
    unknown?: boolean;
  }): Promise<void> {
    await this.#sql.begin(async (tx) => {
      const [execution] = await tx<
        {
          run_id: string;
          step_id: string;
          started_at: Date;
        }[]
      >`
        update public.browser_executions e
        set status=${input.unknown ? "unknown" : input.errorCode ? "failed" : "completed"},
          last_error_code=${input.errorCode ?? null},
          completed_at=now()
        where e.id=${input.executionId} and e.workspace_id=${input.workspaceId}
          and e.status in ('running','cleanup_pending')
          and exists (
            select 1 from app_private.browser_execution_handles h
            where h.execution_id=e.id and h.workspace_id=e.workspace_id
              and h.lease_epoch=${input.leaseEpoch}
              and h.lease_token_hash=${payloadHash(input.claimToken)}
              and h.lease_expires_at>now()
              and h.provider_phase='deleted'
          ) returning run_id,step_id,started_at
      `;
      if (!execution) throw new Error("Browser completion fence was lost.");
      await tx`
        update public.agent_runs set status='running'
        where id=${execution.run_id} and workspace_id=${input.workspaceId}
          and status='waiting_event' and waiting_for=${input.executionId}
      `;
      const output = input.errorCode
        ? { status: "failed", errorCode: input.errorCode }
        : {
            status: "completed",
            summary: input.summary ?? "Research completed.",
          };
      const result = structuredToolResultSchema.parse({
        id: randomUUID(),
        workspaceId: input.workspaceId,
        runId: execution.run_id,
        stepId: execution.step_id,
        toolName: "browser.research",
        certainty: input.unknown
          ? "unknown"
          : input.errorCode
            ? "failed_before_effect"
            : "succeeded",
        attempt: 1,
        output,
        outputHash: payloadHash(output),
        errorCode: input.errorCode,
        retryEligible: false,
        startedAt: execution.started_at.toISOString(),
        completedAt: new Date().toISOString(),
      });
      await this.#persistToolResultProjection(tx, result);
      await tx`
        update app_private.browser_execution_handles
        set lease_token_hash=null,lease_expires_at=null,controller=null
        where execution_id=${input.executionId}
      `;
    });
    await this.enqueuePendingContinuations(
      (
        await this.#sql<{ run_id: string }[]>`
          select run_id from public.browser_executions where id=${input.executionId}
        `
      )[0]!.run_id,
    );
  }

  async markBrowserExecutionSessionDeleted(input: {
    executionId: string;
    workspaceId: string;
    claimToken: string;
    leaseEpoch: number;
  }): Promise<void> {
    const updated = await this.#sql`
      update app_private.browser_execution_handles
      set provider_phase='deleted'
      where execution_id=${input.executionId} and workspace_id=${input.workspaceId}
        and lease_epoch=${input.leaseEpoch}
        and lease_token_hash=${payloadHash(input.claimToken)}
        and lease_expires_at>now() returning execution_id
    `;
    if (updated.length !== 1)
      throw new Error("Browser cleanup fence was lost.");
  }

  async reserveArtifact(input: {
    id: string;
    workspaceId: string;
    browserExecutionId?: string;
    stepId?: string;
    kind: string;
    sensitivity: string;
    displayName: string;
    declaredMimeType: string;
    uploadToken: string;
  }): Promise<"reserved" | "available" | "rejected"> {
    const kind = artifactKindSchema.parse(input.kind);
    const sensitivity = artifactSensitivitySchema.parse(input.sensitivity);
    const displayName = sanitizedArtifactName(input.displayName);
    return this.#sql.begin(async (tx) => {
      const [artifact] = await tx<{ state: string }[]>`
        insert into public.artifacts (
          id,workspace_id,browser_execution_id,step_id,kind,sensitivity,state,
          display_name,declared_mime_type
        ) values (
          ${input.id},${input.workspaceId},${input.browserExecutionId ?? null},
          ${input.stepId ?? null},${kind},${sensitivity},'pending_upload',
          ${displayName},${input.declaredMimeType}
        ) on conflict (id) do update set id=excluded.id
        where artifacts.workspace_id=excluded.workspace_id
          and artifacts.browser_execution_id is not distinct from excluded.browser_execution_id
          and artifacts.step_id is not distinct from excluded.step_id
          and artifacts.kind=excluded.kind and artifacts.sensitivity=excluded.sensitivity
          and artifacts.display_name=excluded.display_name
          and artifacts.declared_mime_type=excluded.declared_mime_type
          and artifacts.state in ('pending_upload','quarantined','scanning','available','rejected')
        returning state
      `;
      if (!artifact)
        throw new Error(
          "Artifact reservation conflicts with existing metadata.",
        );
      if (artifact.state === "available" || artifact.state === "rejected")
        return artifact.state;
      const lease = await tx`
        insert into app_private.artifact_ingest_leases (
          artifact_id,workspace_id,lease_token_hash,lease_expires_at
        ) values (
          ${input.id},${input.workspaceId},${payloadHash(input.uploadToken)},
          now()+interval '5 minutes'
        ) on conflict (artifact_id) do update
          set lease_token_hash=excluded.lease_token_hash,
            lease_expires_at=excluded.lease_expires_at,updated_at=now()
          where artifact_ingest_leases.lease_expires_at<=now()
        returning artifact_id
      `;
      if (lease.length !== 1)
        throw new Error("Artifact upload is already leased.");
      return "reserved";
    });
  }

  async bindArtifactLocation(input: {
    id: string;
    workspaceId: string;
    bucketId: "openinstinct-quarantine" | "openinstinct-artifacts";
    storageKey: string;
    etag?: string;
    sizeBytes: number;
    sha256: string;
    uploadToken: string;
  }): Promise<void> {
    await this.#sql.begin(async (tx) => {
      await tx`
        insert into app_private.artifact_locations (
          artifact_id,workspace_id,bucket_id,storage_key,etag
        ) values (
          ${input.id},${input.workspaceId},${input.bucketId},${input.storageKey},
          ${input.etag ?? null}
        ) on conflict (artifact_id) do update set artifact_id=excluded.artifact_id
        where artifact_locations.workspace_id=excluded.workspace_id
          and artifact_locations.bucket_id=excluded.bucket_id
          and artifact_locations.storage_key=excluded.storage_key
      `;
      const updated = await tx`
        update public.artifacts set state='quarantined',size_bytes=${input.sizeBytes},
          sha256=${input.sha256}
        where id=${input.id} and workspace_id=${input.workspaceId}
          and state in ('pending_upload','quarantined','scanning')
          and (sha256 is null or sha256=${input.sha256})
          and (size_bytes is null or size_bytes=${input.sizeBytes})
          and exists (
            select 1 from app_private.artifact_ingest_leases l
            where l.artifact_id=public.artifacts.id
              and l.workspace_id=public.artifacts.workspace_id
              and l.lease_token_hash=${payloadHash(input.uploadToken)}
              and l.lease_expires_at>now()
          ) returning id
      `;
      if (updated.length !== 1)
        throw new Error("Artifact upload binding state changed.");
      await tx`
        delete from app_private.artifact_ingest_leases
        where artifact_id=${input.id} and workspace_id=${input.workspaceId}
          and lease_token_hash=${payloadHash(input.uploadToken)}
      `;
    });
  }

  async completeArtifactScan(input: {
    id: string;
    workspaceId: string;
    result: ArtifactScanResult;
    detectedMimeType?: string;
    redactionStatus?: "redacted" | "withheld" | "not_applicable";
    redactionVersion?: string;
  }): Promise<void> {
    const result = artifactScanResultSchema.parse(input.result);
    const clean = result.verdict === "clean";
    const updated = await this.#sql`
      update public.artifacts
      set state=${clean ? "available" : "rejected"},scan_verdict=${result.verdict},
        scan_version=${result.scannerVersion},scan_code=${result.safeCode ?? null},
        detected_mime_type=${input.detectedMimeType ?? null},
        redaction_status=${input.redactionStatus ?? null},
        redaction_version=${input.redactionVersion ?? null},
        available_at=case when ${clean} then now() else null end
      where id=${input.id} and workspace_id=${input.workspaceId}
        and (
          state in ('quarantined','scanning') or (
            state=${clean ? "available" : "rejected"}
            and scan_verdict=${result.verdict}
            and scan_version=${result.scannerVersion}
          )
        ) returning id
    `;
    if (updated.length !== 1) throw new Error("Artifact scan state changed.");
  }

  async getArtifactLocationForDeletion(input: {
    id: string;
    workspaceId: string;
  }): Promise<{ storageKey: string; bucketId: string }> {
    const [row] = await this.#sql<
      {
        storage_key: string | null;
        bucket_id: string | null;
      }[]
    >`
      update public.artifacts set state='deletion_pending',
        deletion_requested_at=coalesce(deletion_requested_at,now())
      where id=${input.id} and workspace_id=${input.workspaceId}
        and (
          state <> 'deleted'
          or (deletion_recheck_until>now() and next_deletion_check_at<=now())
        )
        and not exists (
          select 1 from app_private.artifact_ingest_leases il
          where il.artifact_id=public.artifacts.id
            and il.workspace_id=public.artifacts.workspace_id
            and il.lease_expires_at>now()
        )
      returning (
        select storage_key from app_private.artifact_locations l
        where l.artifact_id=public.artifacts.id and l.workspace_id=public.artifacts.workspace_id
      ) as storage_key, (
        select bucket_id from app_private.artifact_locations l
        where l.artifact_id=public.artifacts.id and l.workspace_id=public.artifacts.workspace_id
      ) as bucket_id
    `;
    if (!row) throw new Error("Artifact is unavailable for deletion.");
    return {
      storageKey: row.storage_key ?? `${input.workspaceId}/${input.id}/content`,
      bucketId: row.bucket_id ?? "openinstinct-quarantine",
    };
  }

  async listArtifactsPendingCleanup(
    limit = 50,
  ): Promise<readonly { id: string; workspaceId: string }[]> {
    const rows = await this.#sql<{ id: string; workspace_id: string }[]>`
      select a.id,a.workspace_id from public.artifacts a
      where (
        a.state in ('rejected','deletion_pending','deletion_unknown')
        or (a.state='available' and a.retention_expires_at<=now())
        or (a.state in ('pending_upload','quarantined','scanning')
          and a.created_at<=now()-interval '15 minutes')
        or (a.state='deleted' and a.deletion_recheck_until>now()
          and a.next_deletion_check_at<=now())
      )
      and not exists (
        select 1 from app_private.artifact_ingest_leases il
        where il.artifact_id=a.id and il.workspace_id=a.workspace_id
          and il.lease_expires_at>now()
      )
      order by a.retention_expires_at asc
      limit ${Math.min(Math.max(limit, 1), 200)}
    `;
    return rows.map((row) => ({ id: row.id, workspaceId: row.workspace_id }));
  }

  async completeArtifactDeletion(input: {
    id: string;
    workspaceId: string;
    verified: boolean;
  }): Promise<void> {
    await this.#sql.begin(async (tx) => {
      const updated = await tx`
        update public.artifacts
        set state=${input.verified ? "deleted" : "deletion_unknown"},
          deletion_verified_at=case when ${input.verified} then now() else null end,
          deletion_recheck_until=case when ${input.verified}
            then coalesce(deletion_recheck_until,now()+interval '24 hours')
            else deletion_recheck_until end,
          next_deletion_check_at=case when ${input.verified}
            then now()+interval '5 minutes' else next_deletion_check_at end
        where id=${input.id} and workspace_id=${input.workspaceId}
          and state in ('deletion_pending','deletion_unknown','deleted') returning id
      `;
      if (updated.length !== 1)
        throw new Error("Artifact deletion state changed.");
      if (input.verified)
        await tx`
          delete from app_private.artifact_locations
          where artifact_id=${input.id} and workspace_id=${input.workspaceId}
        `;
      if (input.verified)
        await tx`
          delete from app_private.artifact_ingest_leases
          where artifact_id=${input.id} and workspace_id=${input.workspaceId}
        `;
    });
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

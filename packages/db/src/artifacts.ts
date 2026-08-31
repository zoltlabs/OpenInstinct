import type { ArtifactByteStore } from "@openinstinct/artifacts";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const storageKeyPattern =
  /^[0-9a-f]{8}-[0-9a-f-]{27,}\/([0-9a-f]{8}-[0-9a-f-]{27,})\/content$/iu;

export class SupabaseArtifactByteStore implements ArtifactByteStore {
  readonly #client: SupabaseClient;
  readonly #bucket: string;

  constructor(input: {
    supabaseUrl: string;
    serviceRoleKey: string;
    bucket?: string;
    client?: SupabaseClient;
  }) {
    this.#client =
      input.client ??
      createClient(input.supabaseUrl, input.serviceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false },
        global: { fetch: boundedArtifactFetch },
      });
    this.#bucket = input.bucket ?? "openinstinct-quarantine";
  }

  async put(input: {
    workspaceId: string;
    artifactId: string;
    bytes: Uint8Array;
    contentType: string;
  }): Promise<{ storageKey: string; etag?: string }> {
    const storageKey = `${input.workspaceId}/${input.artifactId}/content`;
    assertStorageKey(storageKey);
    const { data, error } = await this.#client.storage
      .from(this.#bucket)
      .upload(storageKey, input.bytes, {
        contentType: input.contentType,
        upsert: false,
        cacheControl: "no-store",
      });
    if (error) throw new Error("Artifact upload failed.", { cause: error });
    return { storageKey: data.path };
  }

  async head(storageKey: string): Promise<{
    exists: boolean;
    sizeBytes?: number;
    contentType?: string;
  }> {
    assertStorageKey(storageKey);
    const { data, error } = await this.#client.storage
      .from(this.#bucket)
      .info(storageKey);
    if (error) {
      const exists = await this.#exists(storageKey);
      if (!exists) return { exists: false };
      throw new Error("Artifact metadata lookup failed.", { cause: error });
    }
    return {
      exists: true,
      ...(typeof data.size === "number" ? { sizeBytes: data.size } : {}),
      ...(data.contentType ? { contentType: data.contentType } : {}),
    };
  }

  async read(storageKey: string, maxBytes: number): Promise<Uint8Array> {
    assertStorageKey(storageKey);
    const metadata = await this.head(storageKey);
    if (!metadata.exists) throw new Error("Artifact object is unavailable.");
    if (metadata.sizeBytes !== undefined && metadata.sizeBytes > maxBytes)
      throw new Error("Artifact object exceeds the read limit.");
    const { data, error } = await this.#client.storage
      .from(this.#bucket)
      .download(storageKey);
    if (error) throw new Error("Artifact download failed.", { cause: error });
    const bytes = new Uint8Array(await data.arrayBuffer());
    if (bytes.byteLength > maxBytes)
      throw new Error("Artifact object exceeds the read limit.");
    return bytes;
  }

  async delete(storageKey: string): Promise<void> {
    assertStorageKey(storageKey);
    const { error } = await this.#client.storage
      .from(this.#bucket)
      .remove([storageKey]);
    if (error) throw new Error("Artifact deletion failed.", { cause: error });
  }

  async verifyDeleted(storageKey: string): Promise<boolean> {
    assertStorageKey(storageKey);
    return !(await this.#exists(storageKey));
  }

  async #exists(storageKey: string): Promise<boolean> {
    const { data } = await this.#client.storage
      .from(this.#bucket)
      .exists(storageKey);
    return data;
  }
}

async function boundedArtifactFetch(
  request: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const timeout = AbortSignal.timeout(60_000);
  const signal = init?.signal
    ? AbortSignal.any([init.signal, timeout])
    : timeout;
  return fetch(request, { ...init, signal });
}

function assertStorageKey(storageKey: string): void {
  if (!storageKeyPattern.test(storageKey))
    throw new Error(
      "Artifact storage key is outside the bounded workspace path.",
    );
}

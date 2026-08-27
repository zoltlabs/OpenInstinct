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

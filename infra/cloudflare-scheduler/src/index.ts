interface SchedulerEnvironment {
  readonly CONSUMER_URL: string;
  readonly INTERNAL_API_SECRET: string;
}

export default {
  async scheduled(
    _controller: unknown,
    environment: SchedulerEnvironment,
  ): Promise<void> {
    const url = new URL("/api/internal/consume", environment.CONSUMER_URL);
    if (url.protocol !== "https:")
      throw new Error("CONSUMER_URL must use HTTPS.");
    const response = await fetch(url, {
      method: "POST",
      redirect: "error",
      headers: {
        authorization: `Bearer ${environment.INTERNAL_API_SECRET}`,
      },
    });
    if (!response.ok)
      throw new Error(
        `OpenInstinct consumer returned HTTP ${response.status}.`,
      );
  },
};

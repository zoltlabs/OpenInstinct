export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  const expected = process.env.NEXT_PUBLIC_APP_URL;
  return Boolean(
    expected && new URL(origin).origin === new URL(expected).origin,
  );
}

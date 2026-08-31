export type FeedbackTone = "success" | "error" | "info";

const feedbackMessages: Record<
  string,
  { readonly tone: FeedbackTone; readonly message: string }
> = {
  "check-email": {
    tone: "success",
    message: "Check your email for the private sign-in link.",
  },
  "auth-missing-code": {
    tone: "error",
    message:
      "That sign-in link is incomplete. Request a new one and try again.",
  },
  "auth-exchange-failed": {
    tone: "error",
    message:
      "That sign-in link could not be used. It may have expired; request a new one.",
  },
  "signin-unavailable": {
    tone: "error",
    message: "Sign-in is unavailable for that address.",
  },
  "signin-failed": {
    tone: "error",
    message: "The sign-in email could not be sent. Try again in a moment.",
  },
  "configuration-incomplete": {
    tone: "error",
    message:
      "This deployment is not fully configured yet. Run the setup doctor for details.",
  },
  "session-expired": {
    tone: "error",
    message: "Your session expired. Sign in again to continue.",
  },
  "onboarding-invalid": {
    tone: "error",
    message:
      "Check the owner name, E.164 phone number, and IANA time zone, then try again.",
  },
  "onboarding-phone-mismatch": {
    tone: "error",
    message:
      "The phone number does not match the owner number configured for this deployment.",
  },
  "onboarding-failed": {
    tone: "error",
    message: "The owner workspace could not be created. It may already exist.",
  },
  "onboarding-complete": {
    tone: "success",
    message: "Owner setup is complete.",
  },
  "browser-invalid": {
    tone: "error",
    message: "Enter a label and an exact HTTPS website origin.",
  },
  "browser-error": {
    tone: "error",
    message: "The private browser profile could not be updated safely.",
  },
  "browser-active": {
    tone: "success",
    message: "The browser identity is active and ready for later sessions.",
  },
  "browser-login-needed": {
    tone: "info",
    message:
      "Login could not be confirmed yet. Reopen the private browser and finish signing in.",
  },
  "browser-revoked": {
    tone: "success",
    message:
      "The browser identity is revoked. Delete it to verify provider-side removal.",
  },
  "browser-deleted": {
    tone: "success",
    message: "The browser identity was verified deleted at the provider.",
  },
  "mcp-invalid": {
    tone: "error",
    message: "Enter a connector name and a public HTTPS MCP URL.",
  },
  "mcp-failed": {
    tone: "error",
    message: "The MCP server could not be verified or connected.",
  },
  "mcp-oauth-failed": {
    tone: "error",
    message:
      "MCP authorization could not be completed. Start the connection again and finish it within ten minutes.",
  },
  "mcp-connected": {
    tone: "success",
    message:
      "The MCP connector is ready. Every invocation will still require approval.",
  },
  "google-connected": {
    tone: "success",
    message: "Google is connected.",
  },
  "google-failed": {
    tone: "error",
    message:
      "Google could not be connected. Start the connection again and complete it within ten minutes.",
  },
  "approval-confirmation-mismatch": {
    tone: "error",
    message: "The destructive confirmation phrase did not match.",
  },
  "approval-failed": {
    tone: "error",
    message:
      "That approval decision could not be recorded. Refresh and check its status.",
  },
  "approval-recorded": {
    tone: "success",
    message: "The approval decision was recorded.",
  },
};

export function feedbackForCode(code: string | undefined) {
  return code ? feedbackMessages[code] : undefined;
}

export function feedbackUrl(
  requestUrl: string,
  code: string,
  pathname = "/",
): URL {
  const url = new URL(pathname, requestUrl);
  url.searchParams.set("feedback", code);
  return url;
}

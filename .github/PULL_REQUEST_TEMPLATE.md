## Summary

Describe the owner or operator outcome and the approach taken.

## Verification

- [ ] `pnpm check`
- [ ] `pnpm build`
- [ ] `pnpm supabase:test` when database behavior changed
- [ ] Applicable smoke or end-to-end path

List any verification that could not run and why.

## Safety review

- [ ] No secrets, personal messages, tokens, or private webhook payloads are included.
- [ ] Ingestion and retries remain idempotent.
- [ ] Consequential actions cross the proposal, approval, and execution boundary.
- [ ] Ambiguous external writes are recorded as `unknown` and are not retried automatically.
- [ ] New Data API objects have explicit grants, RLS, and SQL tests.
- [ ] Provider-specific code remains outside `packages/core`, `packages/db`, `packages/messaging`, and `packages/connectors` unless that package owns the provider boundary.

## UX and documentation

- [ ] Setup, doctor output, help text, and relevant docs were updated.
- [ ] New form controls have labels and owner-visible success/error feedback.

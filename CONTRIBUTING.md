# Contributing

Use Node 22 and pnpm 10. Before opening a pull request, run `pnpm check` and `pnpm build`. Database changes require an additive Supabase migration and a pgTAP test when practical.

New providers belong behind package interfaces. Separate read tools from write tools; write, communication, financial, destructive, and security actions must pass the deterministic policy layer and be persisted before any external side effect.

Never commit `.env.local`, access tokens, webhook samples containing personal data, or generated browser profiles.

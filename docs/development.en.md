# Development and release checks

[Español](development.es.md) · [README](../README.md)

## Reproduce the development environment

Use Node.js 24. Install exact dependencies from the committed lockfile:

```sh
npm ci
npm test
npm run typecheck
```

The suite uses Node's test runner, PGlite with vector support, faux inference providers, mocked network calls and temporary SQLite files. Multiple test files can use significant memory concurrently. If the host is constrained, run the same suite with limited concurrency:

```sh
node --test --test-concurrency=2 tests/*.test.ts
```

Default tests do not log in to an inference account, read production finance records or send Telegram messages. A passing synthetic suite proves the exercised contracts; it does not prove an account's live catalog access, deployed extensions or end-to-end Telegram behavior.

## Make changes

Create a branch. Use synthetic names, IDs, balances and conversations. Preserve exact cents, immutable ledger entries, ownership verification, revision checks and queue/outbox idempotency. Add behavioral regression tests for changes to these contracts; documentation-only corrections do not need tests mirroring prose.

For database changes, inspect the pinned Supabase CLI's help and create a migration with `npx supabase migration new DESCRIPTIVE_NAME`. Do not rewrite an applied migration. Apply the ordered migration chain in an isolated development project and run its relevant tests. The PGlite fixtures simulate Supabase roles/Vault and skip hosted cron schedule migrations, so validate hosted cron and extension behavior separately before deployment.

Update both documentation languages whenever configuration, behavior or commands change. Bot-facing Spanish strings are part of the current runtime contract; bilingual documentation does not make its conversation multilingual.

## Optional live tools

| Tool | Scope |
| --- | --- |
| `subscription:connect` / `subscription:probe` | Own account authorization and synthetic provider probes |
| `flue:readiness` | Current session/configuration, bot identity, SQLite and embedding readiness |
| `scripts/flue-evaluation.ts` | Explicit model evaluation; inspect arguments and fixtures first |
| `scripts/agent-general-eval.ts` / `scripts/account-scope-eval.ts` | Explicit synthetic live model evaluation |
| Embedding evaluation/reindex scripts | Read code first; reindex can modify a project's vector index |
| State migration / archived replay scripts | Historical Postgres runtime tools requiring an explicit source and isolated target |

Do not invoke every script as a generic test suite. Some tools access real services or perform operational writes. Reindexing requires the same pinned embedding model for query and passage vectors. State migration tools cannot be used after their source schema has already been retired without an appropriate private backup.

## Public-release checklist

1. Export only reviewed source, migrations, tests and generic deployment templates. Exclude credential/state directories, runtime archives, internal reports, attachments and model cache.
2. Scan every tracked file for secrets and personal/infrastructure identifiers, including examples, fixtures, certificates and package metadata. Manually inspect findings without printing real secret values.
3. Review Git history, authors, remotes, branches, tags and large/binary files. A clean source tree does not clean old Git objects. A new public snapshot must not import private history.
4. Run the full suite, typecheck, documentation-link checks and isolated SQLite bootstrap/backup/recovery checks. Read all failures and fix their causes.
5. Review repository description, issue templates, release assets and commit metadata. GitHub still displays the repository owner's public account identity; sanitized source cannot anonymize that account.
6. Publish only the reviewed snapshot, verify visibility and remote tree, and keep production configuration separate. Do not include private data in CI logs, pull request bodies or public release notes.

MIT licenses the project's source. Dependency packages and the downloaded embedding model keep their own licenses; inspect their upstream notices when redistributing them. The standard `LICENSE` text is authoritative; Spanish documentation explains its use rather than substituting a legal translation.

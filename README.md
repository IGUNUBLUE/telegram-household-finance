# Telegram Household Finance

[Español](README.es.md) · [Installation](docs/install.en.md) · [Usage](docs/usage.en.md) · [Operations](docs/operations.en.md)

A conversational household finance bot for Telegram. It turns Spanish messages, voice notes and supported images into reviewed financial operations. PostgreSQL validates permissions and posts balanced ledger entries; the model proposes actions rather than writing balances directly.

The current runtime runs on a Linux VPS with Flue, Pi and private SQLite state. Supabase remains the financial ledger, queue, outbox and vector store. Local multilingual embeddings run on CPU, directly on Spanish text.

## What it does

- Accounts, pockets, income, expenses, transfers, debts, corrections and reconciliation.
- Persistent drafts that survive follow-up messages and conversation interruptions.
- Account-manager approval for operations affecting another member's accounts, with at most three notification rounds one hour apart.
- Personal account queries and explicit household-wide summaries.
- Duplicate detection, idempotent processing, audit history and ledger export.
- Consistent SQLite backups, private offsite copies and Spanish semantic search.

## Scope and requirements

This edition supports **one household, exactly two human members and one bot in its Telegram group**. Conversation and bot replies are Spanish; amounts use COP and financial dates use `America/Bogota`. Documentation is available in English and Spanish. Multi-household hosting, configurable currencies and English bot conversations are not implemented.

You need Node.js 24, a Linux VPS with persistent disk, a Supabase project, a Telegram bot, a Deepgram key and a separately authorized ChatGPT session with access to the model accepted by this runtime. The subscription transport is experimental and depends on the account's catalog and authorization capabilities. Publishing the source does not include model access, credentials, provider subscriptions or free inference.

Follow the complete [installation guide](docs/install.en.md). Do not start with the historical Edge deployment commands.

## Install with an AI agent

Copy the [agent setup prompt](docs/agent-setup.en.md) into an agent with terminal and SSH tools. It follows the installation guide, performs checks and reports blockers. You provide your own resources and complete private sign-ins/OAuth; a chat without execution tools cannot install the bot.

## Documentation

| Topic | English | Español |
| --- | --- | --- |
| AI-agent installation prompt | [Copy prompt](docs/agent-setup.en.md) | [Copiar prompt](docs/agent-setup.es.md) |
| Installation and configuration | [Install](docs/install.en.md) | [Instalación](docs/install.es.md) |
| Conversation examples and commands | [Usage](docs/usage.en.md) | [Uso](docs/usage.es.md) |
| Components, permissions and embeddings | [Architecture](docs/architecture.en.md) | [Arquitectura](docs/architecture.es.md) |
| Services, backups, recovery and troubleshooting | [Operations](docs/operations.en.md) | [Operación](docs/operations.es.md) |
| Development, tests and release checklist | [Development](docs/development.en.md) | [Desarrollo](docs/development.es.md) |
| Initial snapshot verification | [Checks](docs/release-check.en.md) | [Verificación](docs/release-check.es.md) |

All identities, account labels and financial data used in conversation examples and tests are fictional. No runtime database, conversation archive, credential file or previous private Git history is included.

## Local development

```sh
npm ci
npm test
npm run typecheck
```

The default suite uses synthetic providers and temporary databases. It does not need production credentials or send Telegram messages. Live-provider evaluations and operational migration scripts are separate, explicitly invoked tools.

## Source map

| Path | Responsibility |
| --- | --- |
| `scripts/flue-worker.ts` | VPS polling, inference, queue processing and notifications |
| `scripts/lib/` | OAuth, SQLite, local embeddings and runtime adapters |
| `supabase/functions/_shared/` | Domain rules, tools, message formatting and worker engine |
| `supabase/migrations/` | Ordered ledger, permission and workflow migrations |
| `tests/` | Synthetic behavioral, database and recovery tests |
| `deploy/` | Generic systemd templates; replace installer placeholders |

The Edge entry points and earlier Postgres runtime migration utilities are retained for compatibility and development. They are not the default deployment path. Use a single VPS execution owner.

## License and security

The source is distributed under the [MIT license](LICENSE). Third-party packages and model weights have their own licenses. See [contribution guidance](CONTRIBUTING.md) and [security/data handling](SECURITY.md).

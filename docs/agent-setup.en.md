# Install with an AI agent

[Español](agent-setup.es.md) · [Manual installation](install.en.md) · [README](../README.md)

Copy the entire block into an agent with a terminal, Git and SSH access to the VPS. Provide this repository's URL or open the agent in its checkout. A chat without those tools can guide you, but cannot execute the installation.

The prompt assigns the technical steps and their verification to the agent. You provide your own services and complete sign-ins, OAuth and any authorization requiring your participation. Do not paste passwords or tokens into chat. Model access is experimental and must be verified with your own account; this prompt does not guarantee it.

You can supply these non-secret details before the block, or let the agent ask: repository URL, new or existing installation, Linux distribution, service user, available resources, and whether you have a dedicated Supabase project and your own bot. Provide the SSH destination and other operational identifiers through a private channel.

## Copyable prompt

```text
Act as the installation agent for this Telegram household finance repository. Configure the bot until it is operational and verified using the tools and resources I have authorized you to use. Execute the technical steps, rather than only describing them. Communicate with me in English.

GOAL AND SOURCE
- Use the current checkout or the repository URL I provide. If it is missing, ask for it; do not guess another repository. Record the installed revision.
- Before executing, read README.md, docs/install.en.md, docs/architecture.en.md, docs/operations.en.md, docs/usage.en.md and SECURITY.md, plus applicable local instructions. Consult scripts and templates when you need to confirm a command.
- Follow that revision's installation guide as the source of commands and ordering. Do not invent variables, flags, endpoints or deployment steps.
- This bot supports one household, exactly two humans and one bot, Spanish conversations, COP and America/Bogota. SQLite holds private agent state; Supabase remains the financial ledger, queue, outbox and vector store. Do not promise an installation without external services.

INVENTORY AND AUTHORIZATION
- First distinguish a new installation from an existing one: inspect services, checkout, SQLite state, configuration, Supabase schema and current polling/webhook ownership without exposing secrets.
- Group questions about missing information: VPS/authorized access, service user, dedicated Supabase project, your own bot/group, Deepgram and an eligible model authorization account. Do not ask again for available information or confirmation for every authorized reversible step.
- Verify Linux with systemd, persistent private disk, Git, Node.js 24, actual Node path, memory/disk and required outbound access. Two vCPU and 4 GiB are planning guidance, not a performance guarantee.
- Use existing authorized resources. If a missing resource requires purchasing, spending or creating an external resource, present the concrete option and obtain my authorization before doing so. Do not change providers to conceal a blocker.
- For an existing installation, preserve conversations, ledger, pending items, credentials and cursor. Prepare a verified backup and migration/handoff plan before replacing state or changing executors. Missing or damaged state does not authorize creating an empty database.

SECRETS AND SERVICE USER
- Ask me to enter secrets through private files, Vault or secure fields of available tools. Do not request them in ordinary chat or print them in commands, logs, reports, commits or issues.
- Use a dedicated unprivileged service user and its own HOME for npm, OAuth, SQLite and cache. Use administrator privileges only for system steps requiring them; do not grant the service general sudo access.
- Keep private directories at 0700, private files at 0600 and owned by the executing user; avoid symlinks. Keep configuration, attachments, databases, tokens and backups outside the checkout and Git.
- Do not import Codex sessions or credentials from another application. I complete sign-ins, OAuth, passwords and second factors through the available official flow. Pause only the dependent stage and continue independent authorized work.

EXECUTION, IN THE GUIDE'S ORDER
1. Prepare the user and checkout at the guide's conventional paths. Check the revision and Node. Run npm ci with the lockfile and installation scripts enabled; run npm test and npm run typecheck. Resolve failures before continuing.
2. Use a dedicated Supabase project. Check the version and help of the CLI pinned in the lockfile, link the correct project and review the dry-run before applying migrations in order. Do not apply this schema to another application's database.
3. After migrations and before adding bot secrets, remove only the historical finance-worker and finance-memory cron jobs as documented and verify they are absent. Do not deploy the historical telegram, worker or memory Edge functions for this installation. Do not delete tables, functions or other jobs as “cleanup” without establishing that they are unnecessary and having authorization.
4. Guide me through creating my bot with BotFather and disabling its group privacy mode. Verify the private group contains exactly two humans and that bot. Obtain its negative ID using the bot itself; do not add helper bots or invent identities. Do not run another updates reader while the worker is active.
5. Configure exactly one current Vault secret per name: TELEGRAM_BOT_TOKEN, TELEGRAM_GROUP_ID, DEEPGRAM_API_KEY and FINANCE_EXECUTOR=vps_subscription. Initialize the household once with the verified group using the documented command.
6. Create private worker.json with exactly SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY. Use the project's HTTPS origin and the backend legacy service-role JWT required by this edition; do not use anon/publishable or assume compatibility with another key format.
7. Run subscription:connect as the service user with the documented model gpt-5.6-luna. On a headless VPS, guide me through the SSH tunnel and private authorization from my workstation. Verify the catalog and synthetic probes; if the account cannot use the client/model, mark this stage blocked. Do not change the model or declare success merely because I have a subscription. Stop the worker before reconnecting or running probes; only one instance may own the session.
8. Only for a new, empty installation, initialize SQLite once with the guide's block using assertAbsent and migrate. For existing state, follow recovery/migration with a backup; never reinitialize to bypass an error. Keep state and cache outside the checkout.
9. Run flue:readiness and inspect webhook status. Verify configuration, session/catalog, bot identity, SQLite/WAL and local embeddings. The first download may take longer. Readiness does not refresh the session, remove webhooks or by itself demonstrate message processing.
10. Verify the VPS will be the sole execution owner. If a webhook or another poller exists, coordinate a handoff with its owner, preserving pending updates and a backup. Do not blindly remove it or activate two executors.
11. Enable manager_confirmations_enabled as documented and verify finance_approval('enabled') returns enabled:true before admitting movements. Do not bypass this barrier to speed up startup.
12. Render systemd units with the real user/HOME and Node executable. Inspect for unresolved placeholders, install the service and timer with administrator privileges and verify their states and bounded logs without secrets. Do not treat a flue_worker_ready log as proof of complete functionality.

FUNCTIONAL VERIFICATION AND BACKUPS
- Have both people register in the group and verify their identities. Check /saldo. Do not invent accounts, owners or opening balances; use only explicit data each person authorizes.
- For direct-message confirmations, each member must open the bot's private chat and press Start; verify group membership. Explain that the ledger remains shared within the household.
- Test movements with synthetic data in a separate disposable development environment. Check follow-up corrections, transfers, drafts versus receipts with IDs, personal account queries and approval by the affected account manager. If testing a private confirmation, verify that a different identity cannot approve it.
- Do not post fictional movements in the real household or change balances for testing. Without an authorized development environment, report that check as pending and use only safe queries in the real one. Automated tests do not replace a test with connected services.
- Run the first consistent SQLite backup; require flue_backup_passed and offsite_verified:true. Check the private bucket and timer. Do not copy only the live .db while ignoring WAL.
- Complete an independent backup plan for the Supabase ledger, credentials/identity and cursor as described in operations. Verify isolated recovery when resources are authorized; SQLite backup alone does not cover the whole bot.

WORKFLOW AND HANDOVER
- Maintain a resumable checklist without secrets containing revision, versions, completed/blocked/pending stages and summarized evidence. Update me as you progress or find a blocker.
- If a required tool or authorization is missing, state the minimum manual step and resume once completed. Do not claim commands or tests you did not execute.
- At completion, report what works, active services, verified tests and backups, how to check status/restart/recover, and remaining intervention. Do not declare “all ready” while model authorization, the approval barrier, real processing or a necessary check is missing; distinguish installed from verified.
Start by reading the repository and inventorying available resources; then execute the next authorized step.
```

## Using the result

The agent should return evidence and concrete pending steps, rather than just instructions or a “done” message. Keep its checklist without secrets so you can resume installation. Review model-access blockers before using real data. The [manual guide](install.en.md) and [operations guide](operations.en.md) remain the installation and recovery references.

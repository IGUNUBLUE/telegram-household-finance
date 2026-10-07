# Installation

[Español](install.es.md) · [README](../README.md)

This guide installs a **new, empty household** using the VPS/SQLite runtime. Do not use it to replace an existing household without a separate migration and backup plan. Nothing in the repository contains working credentials or preloaded accounts.

Prefer an agent to execute these steps? Copy the [AI-agent installation prompt](agent-setup.en.md). It uses this guide and reports the checks completed and any manual authorization still needed.

## 1. Prepare the host

Use a Linux VPS with systemd, a persistent private disk, Git and Node.js 24 installed at `/usr/bin/node`. Check `node --version` and `command -v node`; adjust the unit templates if your executable has another path. CPU inference and initial model downloads need available memory and disk. A starting allocation of 2 vCPU and 4 GiB RAM is a planning recommendation, not a measured minimum or a latency guarantee.

Create a dedicated unprivileged user, such as `finance`, and log in as that user for dependency installation and authorization. All user commands below run as this user; administrator commands are marked with `sudo`.

```sh
mkdir -p "$HOME/finanzas-familiares"
git clone YOUR_REPOSITORY_URL "$HOME/finanzas-familiares/flue-current"
cd "$HOME/finanzas-familiares/flue-current"
npm ci
npm test
npm run typecheck
```

Replace `YOUR_REPOSITORY_URL` with this repository's clone URL. Keep the conventional `finanzas-familiares/flue-current` and `.config/finanzas-familiares` paths: the provided runtime and unit templates use them.

Outbound access is required to your Supabase project, Telegram, Deepgram, the authorization/model endpoints and Hugging Face model downloads. The worker uses Telegram long polling and needs no public HTTP listener. OAuth uses a temporary loopback callback.

## 2. Create Supabase and apply the schema

Create a dedicated hosted Supabase project. Use a separate development project while evaluating the bot. Its database must support the extensions used by the migrations: Vault, vector, pg_cron and pg_net. Never apply these migrations to a database belonging to another application without reviewing every change.

Install the pinned development dependencies with lifecycle scripts enabled. Supabase CLI is pinned in `package-lock.json`; check the actual binary and command help before running it:

```sh
npx supabase --version
npx supabase login
npx supabase link --help
npx supabase db push --help
npx supabase link --project-ref YOUR_PROJECT_REF
npx supabase db push --dry-run
npx supabase db push
```

Let the CLI request credentials interactively. Avoid command-line passwords and checked-in connection strings. Migrations must run in filename order. Some historical migrations create Edge cron jobs; immediately remove those two jobs in the project's SQL Editor, before configuring bot secrets:

```sql
select cron.unschedule(jobid)
from cron.job
where jobname in ('finance-worker', 'finance-memory');

select jobname from cron.job
where jobname in ('finance-worker', 'finance-memory');
```

The second query must return no rows. Do not deploy the historical `telegram`, `worker` or `memory` Edge functions for this installation. The final schema keeps financial data in Supabase and retires the previous Flue Postgres runtime.

## 3. Create the Telegram group

Create your own bot using Telegram's BotFather. Disable group privacy mode for that bot so it can receive ordinary finance messages. Create a private group containing exactly **two human members and this bot**. Avoid extra bots, anonymous administrator messages and additional members.

Obtain and verify the group's negative Telegram chat ID using your own bot's updates, not a third-party bot that would change membership. Do not run a second polling client after starting the worker. The first two eligible people who interact with the initialized group become its members; verify both identities before adding real accounts.

## 4. Configure Vault and initialize the household

In the Supabase Vault dashboard, create exactly one current secret for each required name. Enter actual values through the dashboard, not in source files or public SQL snippets.

| Vault name | Value |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Your BotFather token |
| `TELEGRAM_GROUP_ID` | The verified negative group ID |
| `DEEPGRAM_API_KEY` | Your transcription key |
| `FINANCE_EXECUTOR` | `vps_subscription` |

From SQL Editor, initialize once with that same verified group ID:

```sql
select public.finance_api('init', '{"group":"REPLACE_WITH_NEGATIVE_GROUP_ID"}'::jsonb);
```

Do not expose the private schema or grant its tables/functions to anonymous clients. This application calls restricted RPC functions with a backend service-role key.

## 5. Create private worker configuration

As the dedicated VPS user:

```sh
install -d -m 700 "$HOME/.config/finanzas-familiares"
install -m 600 deploy/worker.json.example "$HOME/.config/finanzas-familiares/worker.json"
```

Edit the private file with a local editor. Replace both placeholders with the project's HTTPS origin and backend **legacy service-role JWT**. The file must contain exactly the two keys shown in the example. Do not use the public anon/publishable key. Compatibility with the newer secret-key format is not asserted by this edition; the existing transport uses service-role authorization.

```json
{
  "SUPABASE_URL": "https://YOUR_PROJECT_REF.supabase.co",
  "SUPABASE_SERVICE_ROLE_KEY": "REPLACE_WITH_YOUR_BACKEND_SERVICE_ROLE_KEY"
}
```

Keep directory permissions `0700`, file permissions `0600` and ownership equal to the executing user. Do not use symlinks for the private configuration/state files.

## 6. Authorize and test the inference account

The adapter uses its own OAuth session. A ChatGPT subscription alone does not guarantee that this experimental client and its required model are available. The runtime currently requires `gpt-5.6-luna`; the catalog check must accept it. Stop here if authorization, catalog access or synthetic probes fail. Changing the provider requires code changes and tests, not merely editing `worker.json`.

For a headless VPS, open this tunnel **from your workstation** and leave it running:

```sh
ssh -L 8765:127.0.0.1:8765 finance@YOUR_SERVER
```

Then, **on the VPS as the dedicated user**, run:

```sh
npm run subscription:connect -- --no-open --port 8765 --model gpt-5.6-luna
```

Open the printed authorization URL in your workstation browser. Complete the flow with your own account. Do not share that URL, passwords, callback codes or token files. The command evaluates synthetic cases without posting financial entries. It saves protected credentials and the probe report under the private configuration directory. No credentials are imported from Codex CLI or other applications.

Only one process may own this session. Stop the worker before reconnecting or using `subscription:probe`. A normal running worker refreshes its session through the native provider adapter.

## 7. Initialize new SQLite state once

The worker deliberately refuses missing or empty runtime state. For this new installation, run the following command from the repository root with the worker stopped. It refuses an existing destination; never use it to replace lost history.

```sh
node --input-type=module <<'JS'
import { homedir } from 'node:os';
import { join } from 'node:path';
import { assertAbsent, createSecureFlueSqlite, flueStatePath } from './scripts/lib/flue-sqlite.ts';
const path = flueStatePath(join(homedir(), '.config', 'finanzas-familiares'));
await assertAbsent(path);
const db = await createSecureFlueSqlite(path);
try { await db.migrate(); } finally { db.close(); }
const check = await createSecureFlueSqlite(path, false);
check.close();
console.log('Private SQLite initialized.');
JS
```

For an existing deployment, restore a consistent backup instead; see [recovery](operations.en.md). SQLite state and model cache stay outside the Git checkout.

## 8. Readiness and single execution owner

```sh
npm run flue:readiness -- --config "$HOME/.config/finanzas-familiares/worker.json"
node scripts/flue-webhook-handoff.ts --config "$HOME/.config/finanzas-familiares/worker.json" status
```

Readiness checks backend configuration, the current authorization/catalog, SQLite integrity and WAL, bot identity and local embeddings. The first embedding run downloads the pinned model and can be slower. Readiness does not enable polling or create financial movements. Its success does **not** mean a pre-existing webhook was removed.

A fresh bot should have no webhook. If one exists, coordinate retirement of its old handler and remove the webhook while preserving pending updates; do not activate polling alongside another executor. The handoff script's `backup/remove/restore` modes are for an existing deployment with protected webhook backup and its historical secret, not a shortcut for an empty installation.

Enable the required manager-confirmation barrier in SQL Editor after completing setup:

```sql
update private.household
set manager_confirmations_enabled = true
where id = 1;
select public.finance_approval('enabled', '{}'::jsonb);
```

The response must contain `enabled: true`. Until this is enabled, the worker waits and does not admit financial traffic.

## 9. Install services and validate

Render templates while logged in as the dedicated user:

```sh
task_backend_user=$(id -un)
task_backend_home=$(getent passwd "$task_backend_user" | cut -d: -f6)
for unit in finanzas-flue-worker.service finanzas-flue-backup.service; do
  sed -e "s|@BACKEND_USER@|$task_backend_user|g" \
      -e "s|@BACKEND_HOME@|$task_backend_home|g" \
      "deploy/$unit" | sudo tee "/etc/systemd/system/$unit" >/dev/null
done
sudo install -m 644 deploy/finanzas-flue-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now finanzas-flue-worker.service
sudo systemctl enable --now finanzas-flue-backup.timer
sudo systemctl status finanzas-flue-worker.service --no-pager
```

This assumes a simple local username/home path without shell or sed metacharacters. Inspect rendered units for unresolved placeholders before starting them. The timer uses the application's `America/Bogota` zone; adjust scheduling if needed.

Have each member send `/start` in the group, check `/saldo`, then add their own explicitly named account and verify its owner and starting balance. Use a disposable development household for end-to-end financial examples. A recorded success message must include a transaction ID; a pending draft is not a ledger entry.

Run the first backup manually and check its status:

```sh
sudo systemctl start finanzas-flue-backup.service
sudo journalctl -u finanzas-flue-backup.service -n 20 --no-pager
```

Expected result: `flue_backup_passed` with `offsite_verified: true`. The backup tool creates/checks a private `flue-runtime-backups` bucket and verifies the downloaded copy's hash. It backs up SQLite, not the Supabase ledger or OAuth credentials. Complete the separate backup arrangements in [operations](operations.en.md).

## Official references

- [Supabase Vault](https://supabase.com/docs/guides/database/vault)
- [Supabase CLI reference](https://supabase.com/docs/reference/cli/introduction)
- [Telegram Bot API](https://core.telegram.org/bots/api)

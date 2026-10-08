# Operations and recovery

[Español](operations.es.md) · [README](../README.md)

## Routine checks

```sh
sudo systemctl status finanzas-flue-worker.service --no-pager
sudo journalctl -u finanzas-flue-worker.service -n 40 --no-pager
sudo systemctl list-timers finanzas-flue-backup.timer --all
sudo journalctl -u finanzas-flue-backup.service -n 20 --no-pager
```

The worker emits bounded status records such as `flue_worker_ready`, `flue_worker_start_or_runtime_failed` and `event_failed`. A ready startup log is emitted before the manager-confirmation barrier; check that the barrier is enabled and intake actually works. Do not paste full logs or private configuration into public issues.

Stop the worker before reconnecting the subscription, running a separate session probe, replacing SQLite or changing execution ownership. Configuration and session directories are protected and not intended to be shared across users or multiple processes.

```sh
sudo systemctl stop finanzas-flue-worker.service
npm run subscription:probe -- --model gpt-6-luna
npm run flue:readiness -- --config "$HOME/.config/finanzas-familiares/worker.json"
sudo systemctl start finanzas-flue-worker.service
```

Run npm commands as the dedicated service user, not root. A probe can invoke the inference provider with synthetic data. Readiness only checks the existing session and does not refresh it; reconnect/probe first if it has expired.

## What to back up

| Data | Location | Recovery responsibility |
| --- | --- | --- |
| Financial ledger, events, drafts and outbox | Supabase Postgres | Independent database backup/restore plan |
| Flue conversations and attachments | `.config/finanzas-familiares/flue-state/flue.db` | Provided online SQLite backup |
| OAuth credentials and host identity | Protected configuration directory | Secure separate backup or coordinated reauthorization |
| Telegram polling cursor | Protected configuration directory | Preserve with execution identity where possible |
| Model cache | Protected `model-cache` directory | Downloadable again; not a ledger backup |

The scheduled backup uses SQLite's online backup API so committed WAL changes are included. Do **not** copy only the live `.db` file while the worker writes. The resulting standalone backup is checked with `PRAGMA quick_check`, uploaded to a private Supabase Storage bucket, downloaded and SHA-256 verified. Seven matching snapshots are retained locally and remotely.

The timer runs daily near 03:00 `America/Bogota`, with a randomized delay and persistent scheduling. Inspect failure records and periodically rehearse recovery in isolation. `/exportar` provides ledger rows but does not replace a full Supabase database backup, including workflow state.

## Restore SQLite

Choose a verified standalone SQLite snapshot. Keep it private. Stop both the worker and backup timer/service; preserve the existing state directory as evidence rather than overwriting its WAL files.

```sh
sudo systemctl stop finanzas-flue-worker.service finanzas-flue-backup.timer finanzas-flue-backup.service
task_config_dir="$HOME/.config/finanzas-familiares"
task_retired_dir="$task_config_dir/flue-state-retired-$(date -u +%Y%m%dT%H%M%SZ)"
if [ -d "$task_config_dir/flue-state" ]; then
  mv "$task_config_dir/flue-state" "$task_retired_dir"
fi
install -d -m 700 "$task_config_dir/flue-state"
install -m 600 /PRIVATE/PATH/VERIFIED_BACKUP.db "$task_config_dir/flue-state/flue.db"
```

Run these filesystem commands as the service user. Replace the backup path. Validate the restored file without calling any financial RPC:

```sh
node --input-type=module <<'JS'
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createSecureFlueSqlite, flueStatePath } from './scripts/lib/flue-sqlite.ts';
const db = await createSecureFlueSqlite(flueStatePath(join(homedir(), '.config', 'finanzas-familiares')), false);
db.close();
console.log('Existing state validated.');
JS
npm run flue:readiness -- --config "$HOME/.config/finanzas-familiares/worker.json"
```

Check that the restored runtime version matches the deployed code, session/config permissions are correct, the backend ledger is intact and no other polling/webhook owner is active. Runtime and ledger backups may have different timestamps; do not roll back the financial ledger merely to match SQLite. Review pending events and receipts before resuming. Do not initialize empty state to bypass a lost-history error.

```sh
sudo systemctl start finanzas-flue-worker.service finanzas-flue-backup.timer
```

## Updates

Keep a tested release and its lockfile available for rollback. Prepare each candidate in a fresh checkout with its own dependency directory. If a copied candidate inherits a node_modules symlink, remove only that candidate link before installing; do not run npm ci through a link shared with an active or rollback release. Stop the worker, create a verified backup, review code/schema changes, install dependencies for the new revision and run tests/typecheck before restarting. Apply required migrations in order to the intended project. Keep state outside releases. Do not downgrade code against an incompatible schema or swap to the historical Edge executor without a coordinated handoff.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Startup failure | Node 24, file ownership, `0700`/`0600`, required Vault names, supported model/catalog |
| Worker waits without consuming messages | `finance_approval('enabled')` barrier and configured group identity |
| Polling conflict | Existing webhook, another poller, changed bot token |
| First readiness embedding times out | Model download access, free disk/RAM; retry after fixing the cause |
| Generic provider failure | Session expiry/catalog/model eligibility; stop worker before probe or reconnect |
| Slow replies | Separate transcription, inference rounds, RPC, queue wait, embedding cold start and Telegram latency |
| Incomplete balances | Missing/unverified opening balance; reconcile rather than inventing a total |
| Pending manager confirmation | Correct manager, current request revision, membership, private Start and expiry |
| Backup failure | Private bucket, service-role access, disk space, valid state and upload/download verification |

Runtime metrics record bounded durations, rounds and token counts without adding financial message text to the trace. Compare warmed-up turns of the same kind before changing context or models. Any optimization must retain draft continuity, exact ledger queries, permissions and duplicate/idempotency controls.

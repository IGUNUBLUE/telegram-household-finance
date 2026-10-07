# Public edition verification

[Español](release-check.es.md)

Verified on 2026-10-07 UTC before preparing the initial public snapshot:

| Check | Result |
| --- | --- |
| Complete default test suite | 441 passed, 0 failed, 0 skipped |
| TypeScript | `npm run typecheck` passed |
| New SQLite bootstrap | Passed with private permissions; accepted by production state validation |
| Existing-state protection | Reinitialization refused; original file unchanged |
| Standalone SQLite backup/recovery | Backup restored and integrity validated |
| Local documentation links | No missing targets |
| Known private identifiers and distinctive financial examples | Removed from distributed files |
| Credential patterns | No matches in distributed files |
| Release history | New public repository; previous private history is excluded |

Source examples and tests use fictional identities and account names. Internal operational reports, previous private history, credential files, databases, attachments and model cache are excluded. Deployment templates use installer placeholders.

These checks do not assert a live deployment for another household. The suite used the available pinned development dependencies. Supabase hosted extensions/cron, a new project's migrations, OAuth account eligibility, model download access and actual Telegram delivery must be checked by the installer in their own isolated environment. No production database or running bot was changed for this edition.

Secret-pattern scans are a review aid, not a guarantee that every possible encoded secret has been detected. Keep future contributions synthetic and review all public assets and history. GitHub displays the public identity of the account that owns the repository.

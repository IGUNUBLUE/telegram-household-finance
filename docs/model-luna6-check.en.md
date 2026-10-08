# Luna 6 model update

[Español](model-luna6-check.es.md) · [README](../README.md)

This revision selects `gpt-6-luna` for the Flue runtime. Provider selection, the default agent model, readiness output and recorded model traces use the same constant. A missing catalog entry stops startup; there is no automatic fallback. Legacy OAuth session model metadata does not override the runtime selection. Run the documented authorization and synthetic checks with your own account before deployment; access is account dependent.

The context window, history, memory, tool schemas, approval checks, execution limits and financial calculation rules remain in place. Prompt `finance-harness-19` clarifies who performed a reported transfer, distinguishes account administration from the sender, and distinguishes the author of a record from its recipient. Personal queries with an ambiguous relationship ask for clarification before selecting records.

The isolated evaluation harness now supports the existing batch-draft RPC as well as single drafts. This reflects a tool already available in production. It does not add an executable operation to the bot.

For an ambiguous request, the evaluation checks that the answer asks which relationship the user means, states no financial facts, and leaves the ledger unchanged. Internal household reads are permitted by the shared-read model and are not themselves a disclosure. All concrete-query cases still assert the SQL person filter, role, ordering and returned records.

Verification results are in [the synthetic model report](model-luna6-acceptance.json). The report contains scenario labels and metrics only. Earlier failures are retained in its initial-run summary. Synthetic model timings include fixture/tool work and are not measurements of Telegram delivery latency.

Deploy with a fresh candidate and its own dependencies, apply the trace migration, verify a backup and stop the sole worker before changing the release. Preserve SQLite, polling state and financial data. Verify `flue_worker_ready` and readiness both show `gpt-6-luna`, with the approval barrier enabled. See [operations and rollback](operations.en.md). The trace migration also accepts the previous model so a compatible previous release can be restored without rewriting the ledger.

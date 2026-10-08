# Using the bot

[Español](usage.es.md) · [README](../README.md)

The bot currently understands and replies in Spanish. These examples deliberately use fictional people and accounts. Try them in a disposable development household, not in a real ledger. Create accounts before posting operations against them.

## Accounts and movements

| Goal | Spanish message to the bot | Meaning |
| --- | --- | --- |
| Own account | `Crea mi cuenta Banco Alfa con saldo inicial 250000 COP hoy.` | Create my asset account and opening balance |
| Personal expense | `Gasté 18000 COP en transporte personal desde Banco Alfa hoy.` | Personal transport expense |
| Family expense | `Descuenta 75000 COP de Banco Alfa por mercado familiar hoy.` | Shared household groceries |
| New zero-balance account and transfer | `Crea mi cuenta Ahorro con saldo inicial cero y pasa 200000 COP de Banco Alfa a Ahorro hoy. Es personal.` | Keep account creation and linked transfer together |
| Transfer then expense | `Trasladé 450000 COP de Ahorro a Banco Alfa y desde Banco Alfa pagué 450000 COP de arriendo hoy. Ambos familiares.` | Two distinct operations, not an extra income |
| External rent income | `Recibí 900000 COP del arrendatario Taylor Example en Banco Alfa por arriendo familiar hoy.` | External payer is not a household member |
| Debt opening | `Crea mi cuenta Tarjeta Alfa: debo 125000.45 COP hoy. Es deuda inicial, no cupo.` | Exact liability balance |

The bot asks for essential missing information and saves a pending draft. A draft acknowledgement is not a registered movement. Final registration includes a transaction ID. When account ownership requires another member's approval, the operation waits until that member confirms the exact request.

## Follow-ups and corrections

You can send `Es familiar` or `Perdón, fueron 75000 pesos` as a follow-up to the active pending operation. Reply explicitly to the relevant bot message if there are multiple threads. Adjacent messages may produce one consolidated answer or an updated bot message rather than a stale question followed by a receipt. Different operations can still require separate replies.

For an already registered operation, specify its transaction ID and the corrected facts, for example `Corrige el movimiento #12: fueron 78000 COP, desde Banco Alfa`. The system records an audited reversal/replacement rather than deleting history. `/deshacer #ID` starts the reversal flow; provide a reason when requested. Do not resend the same payment casually to correct it: it may trigger duplicate checks or create a separate operation after confirmation.

## Queries and commands

| Request | Behavior |
| --- | --- |
| `¿Cómo están mis cuentas?` | Accounts managed by the verified requester |
| `Muéstrame el total de todas las cuentas del hogar` | Explicit household-wide overview |
| `¿Cuál es el saldo de Banco Alfa?` | Recorded balance and completeness indicators |
| `¿Qué movimientos explican ese saldo?` | Ledger-backed explanation |
| `¿Ya está registrado el traslado de 200000 COP de Banco Alfa a Ahorro?` | Search, without registering a new transfer |
| `/saldo` | Registered balances |
| `/exportar` | Ledger export; handle privately |
| `/pendientes` | Pending items; private channel focuses on authorized confirmations |

Registered balances reflect the book, not a live bank connection. Unknown/unverified opening balances must remain marked as such. Personal/family scope identifies financial attribution; it does not hide group messages from the other member.

## Queries about a person

| Spanish request | Relationship used |
| --- | --- |
| `Dame la última entrada que realicé` | Latest registration authored by the requester |
| `Dame el último ingreso que recibí` | Latest financial date of an income received by the requester |
| `Muéstrame los gastos que pagué` | Requester as the internal payer |
| `Movimientos de las cuentas que administro` | Requester as an affected account's manager |
| `Último ingreso registrado por Sam` | Explicit fictional member as author |
| `Último ingreso registrado de todo el hogar` | Both members, ordered by registration |

The author, internal payer/recipient and account manager can differ. Family/personal classification is an independent filter: a family income can still belong to one person. SQL filters by the requested relationship before selecting the latest entry or calculating period totals. “Latest registered” uses registration time; “most recent by date” uses the financial date, with numeric IDs to break ties. Corrections such as `Solo de Sam` preserve the requested movement type and relationship while changing the person. An ambiguous `mis movimientos` may require a short clarification. An empty own result does not fall back to the other member's records. Household reads remain available; this is not a privacy boundary.

## Manager confirmations

The group notice identifies the affected manager and summarizes the exact amount, accounts and operation. The manager can use Confirm/Reject buttons, or an unambiguous textual confirmation referring to that request. Another member's “yes” cannot substitute for the responsible manager's approval.

For private notices, the manager opens the bot's private chat and presses Start. The bot verifies that they are an existing member of the configured group. Use `/pendientes` there to see actionable confirmations. Confirmations can be completed in either authorized route; they are not separate financial operations. The first notice and at most two later hourly rounds stop after confirmation, rejection or expiry at 48 hours.

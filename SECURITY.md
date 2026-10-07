# Security and data handling / Seguridad y tratamiento de datos

## English

Use GitHub's private vulnerability reporting if enabled for this repository. Otherwise ask the maintainers for a private reporting channel without posting exploit details, tokens or personal data in a public issue. Ordinary bugs can be reported with synthetic reproductions.

Supabase service-role credentials are backend-only. Worker configuration directories require mode `0700`; credential and SQLite files require `0600` and the executing user's ownership. Do not commit the configuration directory, databases, model cache, attachments or backups. Ignore rules reduce accidents; they do not remove files already tracked by Git.

Financial data is shared within the household group. A personal account filter is not a confidentiality boundary. Private bot messages support verified account-manager confirmations; they do not create a private financial ledger.

Telegram carries messages and attachments. The inference provider receives the selected conversation context and supported images. Deepgram receives voice audio for transcription. Embedding inference runs locally; vectors and source text are indexed in Supabase. Flue conversation state and attachments are stored in private SQLite and its private backups. Successfully applied ledger events clear their raw payload, but pending/failed events and other persisted conversation records can retain text. This is not end-to-end encryption or a comprehensive data-erasure facility.

Rotate exposed credentials, review logs and provider sessions, and stop the affected worker during recovery. Removing a secret from the latest commit does not remove earlier copies or public Git history. Keep operational exports and incident reports private.

## Español

Usa el reporte privado de vulnerabilidades de GitHub si está habilitado. Si no, solicita a los mantenedores un canal privado sin publicar detalles de explotación, tokens ni datos personales en un issue. Los errores comunes pueden reportarse con reproducciones ficticias.

La clave service role de Supabase es exclusiva del backend. Los directorios de configuración requieren modo `0700`; las credenciales y SQLite requieren `0600` y pertenecer al usuario ejecutor. No subas configuración, bases, caché del modelo, adjuntos ni copias. Los archivos ignorados pueden seguir en Git si ya estaban rastreados.

Las finanzas se comparten dentro del grupo del hogar. Filtrar las cuentas propias no es un límite de confidencialidad. Los mensajes privados permiten confirmaciones de administradores verificados; no crean un libro financiero privado.

Telegram transporta mensajes y adjuntos. El proveedor de inferencia recibe el contexto seleccionado y las imágenes compatibles. Deepgram recibe audio para transcribirlo. La inferencia de embeddings es local; los vectores y su texto fuente se indexan en Supabase. Flue guarda conversaciones y adjuntos en SQLite privado y sus copias privadas. Los eventos aplicados limpian su payload bruto, pero los pendientes, fallidos y otros registros de conversación pueden conservar texto. No hay cifrado de extremo a extremo ni una función integral de borrado de datos.

Ante credenciales expuestas, rótalas, revisa logs y sesiones y detén el worker afectado durante la recuperación. Borrar un secreto del último commit no lo elimina de copias anteriores ni del historial público. Mantén privados los exports y los informes de incidentes.

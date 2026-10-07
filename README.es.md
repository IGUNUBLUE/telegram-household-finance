# Finanzas del hogar en Telegram

[English](README.md) · [Instalación](docs/install.es.md) · [Uso](docs/usage.es.md) · [Operación](docs/operations.es.md)

Bot conversacional de finanzas del hogar para Telegram. Convierte mensajes en español, notas de voz e imágenes compatibles en operaciones financieras revisadas. PostgreSQL valida permisos y registra asientos balanceados; el modelo propone acciones y no escribe saldos directamente.

El runtime actual funciona en un VPS Linux con Flue, Pi y estado privado en SQLite. Supabase conserva el libro financiero, la cola, la bandeja de salida y los vectores. Los embeddings multilingües se calculan localmente en CPU, directamente sobre texto en español.

## Funciones

- Cuentas, bolsillos, ingresos, gastos, traslados, deudas, correcciones y conciliación.
- Borradores persistentes que continúan entre mensajes e interrupciones.
- Confirmación del administrador de las cuentas afectadas de otro miembro, con un máximo de tres rondas de avisos separadas por una hora.
- Consultas de cuentas propias y resúmenes globales explícitos.
- Detección de duplicados, procesamiento idempotente, auditoría y exportación.
- Copias consistentes de SQLite, respaldo privado remoto y búsqueda semántica en español.

## Alcance y requisitos

Esta edición admite **un hogar, exactamente dos personas y un bot en su grupo de Telegram**. La conversación y las respuestas son en español; los importes usan COP y las fechas financieras usan `America/Bogota`. La documentación está en inglés y español. No se han implementado múltiples hogares, monedas configurables ni conversaciones del bot en inglés.

Necesitas Node.js 24, un VPS Linux con disco persistente, un proyecto Supabase, un bot de Telegram, una clave Deepgram y una sesión de ChatGPT autorizada por separado con acceso al modelo aceptado por el runtime. El transporte de suscripción es experimental y depende del catálogo y las capacidades de autorización de la cuenta. El código público no incluye acceso al modelo, credenciales, suscripciones ni inferencia gratuita.

Sigue la [guía completa de instalación](docs/install.es.md). Los comandos históricos de despliegue Edge no son el punto de partida.

## Instalar con un agente de IA

Copia el [prompt de instalación](docs/agent-setup.es.md) en un agente con terminal y SSH. Sigue la guía, ejecuta comprobaciones e informa bloqueos. Tú aportas tus recursos y completas los inicios de sesión/OAuth privados; un chat sin herramientas de ejecución no puede instalar el bot.

## Documentación

| Tema | Español | English |
| --- | --- | --- |
| Prompt de instalación para un agente de IA | [Copiar prompt](docs/agent-setup.es.md) | [Copy prompt](docs/agent-setup.en.md) |
| Instalación y configuración | [Instalación](docs/install.es.md) | [Install](docs/install.en.md) |
| Ejemplos y comandos | [Uso](docs/usage.es.md) | [Usage](docs/usage.en.md) |
| Componentes, permisos y embeddings | [Arquitectura](docs/architecture.es.md) | [Architecture](docs/architecture.en.md) |
| Servicios, copias, recuperación y diagnóstico | [Operación](docs/operations.es.md) | [Operations](docs/operations.en.md) |
| Desarrollo, pruebas y lista de publicación | [Desarrollo](docs/development.es.md) | [Development](docs/development.en.md) |
| Verificación del snapshot inicial | [Verificación](docs/release-check.es.md) | [Checks](docs/release-check.en.md) |

Las identidades, cuentas y datos financieros usados en ejemplos y pruebas son ficticios. Esta edición no contiene bases de datos operativas, conversaciones archivadas, archivos de credenciales ni historial Git privado anterior.

## Desarrollo local

```sh
npm ci
npm test
npm run typecheck
```

La suite predeterminada usa proveedores ficticios y bases temporales. No necesita credenciales de producción ni envía mensajes a Telegram. Las evaluaciones con proveedores reales y los scripts de migración operativa se ejecutan por separado y de forma explícita.

## Estructura

| Ruta | Responsabilidad |
| --- | --- |
| `scripts/flue-worker.ts` | Polling, inferencia, cola y notificaciones en el VPS |
| `scripts/lib/` | OAuth, SQLite, embeddings locales y adaptadores |
| `supabase/functions/_shared/` | Reglas, herramientas, formato y motor de ejecución |
| `supabase/migrations/` | Migraciones ordenadas del libro, permisos y flujos |
| `tests/` | Pruebas sintéticas de comportamiento, datos y recuperación |
| `deploy/` | Plantillas genéricas systemd con marcadores por sustituir |

Los puntos de entrada Edge y las herramientas anteriores de migración del runtime Postgres se conservan para compatibilidad y desarrollo. No son la ruta predeterminada de despliegue. Debe existir un solo ejecutor VPS.

## Licencia y seguridad

El código se distribuye bajo [licencia MIT](LICENSE). Los paquetes de terceros y los pesos del modelo tienen sus propias licencias. Consulta [contribuciones](CONTRIBUTING.md) y [seguridad y tratamiento de datos](SECURITY.md).

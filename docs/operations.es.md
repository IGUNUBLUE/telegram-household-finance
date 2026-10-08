# Operación y recuperación

[English](operations.en.md) · [README](../README.es.md)

## Comprobaciones habituales

```sh
sudo systemctl status finanzas-flue-worker.service --no-pager
sudo journalctl -u finanzas-flue-worker.service -n 40 --no-pager
sudo systemctl list-timers finanzas-flue-backup.timer --all
sudo journalctl -u finanzas-flue-backup.service -n 20 --no-pager
```

El worker emite estados limitados como `flue_worker_ready`, `flue_worker_start_or_runtime_failed` y `event_failed`. El log de inicio ready precede el control de activación de confirmaciones: verifica que esté activada y que la entrada funcione. No publiques logs completos ni configuración privada en issues.

Detén el worker antes de reconectar la suscripción, ejecutar otra prueba de sesión, reemplazar SQLite o cambiar de ejecutor. Los directorios protegidos no se comparten entre usuarios ni múltiples procesos.

```sh
sudo systemctl stop finanzas-flue-worker.service
npm run subscription:probe -- --model gpt-6-luna
npm run flue:readiness -- --config "$HOME/.config/finanzas-familiares/worker.json"
sudo systemctl start finanzas-flue-worker.service
```

Ejecuta npm con el usuario del servicio, no root. El probe puede llamar al proveedor con datos sintéticos. Readiness comprueba la sesión existente sin renovarla; si venció, reconecta/prueba primero.

## Qué respaldar

| Datos | Ubicación | Recuperación |
| --- | --- | --- |
| Libro, eventos, borradores y outbox | Postgres Supabase | Plan independiente de backup/restore de base |
| Conversaciones y adjuntos Flue | `.config/finanzas-familiares/flue-state/flue.db` | Copia SQLite online proporcionada |
| Credenciales OAuth e identidad del host | Directorio protegido | Copia segura separada o reautorización coordinada |
| Cursor de polling Telegram | Directorio protegido | Conservar junto con la identidad de ejecución si es posible |
| Caché del modelo | Directorio privado `model-cache` | Se puede descargar de nuevo; no respalda el libro |

El respaldo programado usa la API online de SQLite para incluir cambios WAL confirmados. **No** copies solamente el `.db` vivo mientras escribe el worker. La copia independiente se comprueba con `PRAGMA quick_check`, se sube a un bucket privado, se descarga y se verifica por SHA-256. Se conservan siete snapshots coincidentes localmente y siete remotos.

El timer corre diariamente cerca de las 03:00 `America/Bogota`, con retraso aleatorio y programación persistente. Revisa fallos y ensaya recuperación aislada periódicamente. `/exportar` entrega filas del libro, pero no sustituye un respaldo completo de Supabase con su estado de flujos.

## Restaurar SQLite

Elige un snapshot independiente verificado y privado. Detén worker y timer/servicio de respaldo. Conserva el directorio anterior en vez de sobrescribir sus archivos WAL.

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

Ejecuta los comandos de archivos como usuario del servicio y sustituye la ruta de la copia. Valida el archivo restaurado sin invocar RPC financieras:

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

Comprueba que versión del estado y código coincidan, permisos/sesión sean correctos, el libro permanezca intacto y no exista otro webhook/poller activo. Los respaldos de runtime y libro pueden tener fechas diferentes: no reviertas el libro solamente para igualarlo a SQLite. Revisa pendientes y comprobantes antes de continuar. No inicialices un estado vacío para saltarte el error de historial perdido.

```sh
sudo systemctl start finanzas-flue-worker.service finanzas-flue-backup.timer
```

## Actualizaciones

Conserva una versión probada y su lockfile para reversión. Detén el worker, crea un respaldo verificado, revisa código/esquema, instala dependencias y ejecuta pruebas/typecheck antes de reiniciar. Aplica migraciones requeridas en orden al proyecto correcto. Mantén el estado fuera de los releases. No vuelvas a código incompatible con el esquema ni cambies al ejecutor Edge histórico sin un relevo coordinado. Prepara cada candidato en un checkout nuevo con su propio directorio de dependencias. Si una copia hereda un enlace node_modules, retira solo el enlace del candidato antes de instalar; no ejecutes npm ci mediante un enlace compartido con una versión activa o de reversión.

## Diagnóstico

| Síntoma | Revisar |
| --- | --- |
| Falla al iniciar | Node 24, propietario, modos `0700`/`0600`, nombres Vault y modelo/catálogo |
| Espera sin consumir mensajes | Control `finance_approval('enabled')` e identidad del grupo |
| Conflicto de polling | Webhook anterior, otro poller o cambio de token |
| Timeout inicial de embeddings | Descarga, disco/RAM; reintentar después de resolver la causa |
| Fallo genérico del proveedor | Sesión, catálogo y elegibilidad; detener antes de probe/reconexión |
| Respuestas lentas | Separar transcripción, rondas de inferencia, RPC, cola, arranque del embedding y Telegram |
| Saldos incompletos | Saldo inicial desconocido/no verificado; conciliar sin inventar total |
| Confirmación pendiente | Administrador correcto, revisión vigente, membresía, Start privado y vencimiento |
| Fallo de respaldo | Bucket privado, permisos service role, disco, estado e integridad de subida/descarga |

Las métricas registran duraciones, rondas y tokens limitados sin añadir el texto financiero a la traza. Compara turnos similares con el modelo ya cargado antes de reducir contexto o cambiar de modelo. Las optimizaciones deben conservar continuidad, consultas exactas al libro, permisos, duplicados e idempotencia.

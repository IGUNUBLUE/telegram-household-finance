# Instalación

[English](install.en.md) · [README](../README.es.md)

Esta guía instala **un hogar nuevo y vacío** con el runtime VPS/SQLite. No la uses para reemplazar un hogar existente sin un plan separado de migración y respaldo. El repositorio no contiene credenciales funcionales ni cuentas precargadas.

¿Prefieres que un agente ejecute estos pasos? Copia el [prompt de instalación para IA](agent-setup.es.md). Usa esta guía e informa las comprobaciones completadas y las autorizaciones manuales pendientes.

## 1. Preparar el servidor

Usa un VPS Linux con systemd, disco privado persistente, Git y Node.js 24 en `/usr/bin/node`. Verifica `node --version` y `command -v node`; adapta las unidades si el ejecutable está en otra ruta. La inferencia en CPU y la descarga inicial requieren memoria y disco disponibles. Empezar con 2 vCPU y 4 GiB RAM es una recomendación de planificación, no un mínimo medido ni una garantía de latencia.

Crea un usuario dedicado sin privilegios, por ejemplo `finance`, e inicia sesión con él para instalar dependencias y autorizar la cuenta. Todos los comandos de usuario siguientes se ejecutan con ese usuario; los administrativos llevan `sudo`.

```sh
mkdir -p "$HOME/finanzas-familiares"
git clone YOUR_REPOSITORY_URL "$HOME/finanzas-familiares/flue-current"
cd "$HOME/finanzas-familiares/flue-current"
npm ci
npm test
npm run typecheck
```

Sustituye `YOUR_REPOSITORY_URL` por la URL de clonación de este repositorio. Conserva las rutas convencionales `finanzas-familiares/flue-current` y `.config/finanzas-familiares`: el runtime y las plantillas las utilizan.

Se requiere acceso saliente a tu proyecto Supabase, Telegram, Deepgram, los servicios de autorización/modelo y las descargas de Hugging Face. El worker usa long polling y no necesita exponer un servidor HTTP. OAuth usa temporalmente un callback local.

## 2. Crear Supabase y aplicar el esquema

Crea un proyecto Supabase alojado dedicado. Usa otro proyecto de desarrollo para evaluar el bot. La base debe admitir las extensiones de las migraciones: Vault, vector, pg_cron y pg_net. No apliques las migraciones a una base de otra aplicación sin revisar todos los cambios.

Instala las dependencias fijadas permitiendo scripts de instalación. La versión de Supabase CLI está en `package-lock.json`; comprueba el ejecutable y su ayuda:

```sh
npx supabase --version
npx supabase login
npx supabase link --help
npx supabase db push --help
npx supabase link --project-ref YOUR_PROJECT_REF
npx supabase db push --dry-run
npx supabase db push
```

Permite que la CLI solicite las credenciales interactivamente. Evita contraseñas en argumentos y cadenas de conexión en Git. Las migraciones se aplican en orden de nombre. Algunas migraciones históricas crean cron Edge; elimina inmediatamente esos dos trabajos en SQL Editor, antes de configurar los secretos del bot:

```sql
select cron.unschedule(jobid)
from cron.job
where jobname in ('finance-worker', 'finance-memory');

select jobname from cron.job
where jobname in ('finance-worker', 'finance-memory');
```

La segunda consulta debe devolver cero filas. No despliegues las funciones Edge históricas `telegram`, `worker` ni `memory` en esta instalación. El esquema final conserva las finanzas en Supabase y retira el runtime Postgres anterior de Flue.

## 3. Crear el grupo de Telegram

Crea tu bot con BotFather y desactiva su modo de privacidad de grupo para recibir mensajes normales de finanzas. Crea un grupo privado con exactamente **dos personas y este bot**. Evita otros bots, administradores anónimos y miembros adicionales.

Obtén y verifica el ID negativo del grupo usando los updates de tu propio bot, no un bot externo que cambiaría la cantidad de miembros. No ejecutes un segundo cliente de polling cuando el worker esté activo. Las primeras dos personas elegibles que interactúen con el grupo inicializado se incorporan como miembros; verifica sus identidades antes de crear cuentas reales.

## 4. Configurar Vault e inicializar el hogar

Desde el panel Vault de Supabase, crea un único secreto vigente por nombre. Introduce los valores reales en el panel, no en código ni ejemplos SQL públicos.

| Nombre en Vault | Valor |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Token de BotFather |
| `TELEGRAM_GROUP_ID` | ID negativo verificado del grupo |
| `DEEPGRAM_API_KEY` | Clave de transcripción |
| `FINANCE_EXECUTOR` | `vps_subscription` |

Inicializa una sola vez en SQL Editor con el mismo ID de grupo:

```sql
select public.finance_api('init', '{"group":"REPLACE_WITH_NEGATIVE_GROUP_ID"}'::jsonb);
```

No expongas el esquema privado ni concedas sus tablas/funciones a clientes anónimos. La aplicación invoca RPC restringidas con la clave service role del backend.

## 5. Crear la configuración privada

Con el usuario dedicado del VPS:

```sh
install -d -m 700 "$HOME/.config/finanzas-familiares"
install -m 600 deploy/worker.json.example "$HOME/.config/finanzas-familiares/worker.json"
```

Edita el archivo privado localmente. Sustituye los marcadores por el origen HTTPS del proyecto y su **JWT service role heredado**. El archivo debe tener exactamente estas dos claves. No uses la clave pública anon/publishable. Esta edición no afirma compatibilidad con el formato nuevo de secret keys; el transporte existente usa autorización service role.

```json
{
  "SUPABASE_URL": "https://YOUR_PROJECT_REF.supabase.co",
  "SUPABASE_SERVICE_ROLE_KEY": "REPLACE_WITH_YOUR_BACKEND_SERVICE_ROLE_KEY"
}
```

Conserva directorio `0700`, archivo `0600` y propietario igual al usuario ejecutor. No uses enlaces simbólicos en archivos privados de configuración/estado.

## 6. Autorizar y probar la cuenta de inferencia

El adaptador usa una sesión OAuth propia. Tener una suscripción de ChatGPT no garantiza acceso a este cliente experimental ni al modelo requerido. El runtime requiere actualmente `gpt-5.6-luna`; su catálogo debe aceptarlo. Detente si falla la autorización, el catálogo o las pruebas sintéticas. Cambiar de proveedor requiere código y pruebas, no editar solamente `worker.json`.

En un VPS sin navegador, abre este túnel **desde tu equipo** y mantenlo activo:

```sh
ssh -L 8765:127.0.0.1:8765 finance@YOUR_SERVER
```

Después, **en el VPS con el usuario dedicado**:

```sh
npm run subscription:connect -- --no-open --port 8765 --model gpt-5.6-luna
```

Abre el enlace mostrado en el navegador de tu equipo y autoriza tu propia cuenta. No compartas URL, contraseñas, códigos ni archivos de tokens. El comando evalúa casos ficticios sin crear asientos financieros y guarda credenciales y reporte protegidos. No importa sesiones de Codex CLI ni de otras aplicaciones.

Solo un proceso puede poseer esa sesión. Detén el worker antes de reconectar o ejecutar `subscription:probe`. El worker activo renueva su sesión mediante el adaptador nativo.

## 7. Inicializar SQLite una sola vez

El worker rechaza deliberadamente un estado faltante o vacío. En esta instalación nueva, ejecuta desde la raíz del repositorio y con el worker detenido. El comando rechaza un destino existente; no lo uses para reemplazar historial perdido.

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

En una instalación existente, restaura una copia consistente; consulta [recuperación](operations.es.md). El estado SQLite y la caché del modelo se mantienen fuera del checkout Git.

## 8. Readiness y ejecutor único

```sh
npm run flue:readiness -- --config "$HOME/.config/finanzas-familiares/worker.json"
node scripts/flue-webhook-handoff.ts --config "$HOME/.config/finanzas-familiares/worker.json" status
```

Readiness comprueba configuración, autorización/catálogo, integridad SQLite y WAL, identidad del bot y embeddings locales. El primer uso descarga el modelo fijado y puede tardar más. No activa polling ni crea movimientos. Su resultado exitoso **no** significa que eliminó un webhook existente.

Un bot nuevo debe carecer de webhook. Si ya tiene uno, coordina el retiro del ejecutor anterior y elimínalo conservando updates pendientes; no actives polling junto con otro ejecutor. Los modos `backup/remove/restore` del script de handoff requieren una instalación anterior con copia protegida del webhook y su secreto histórico; no son un atajo para una instalación vacía.

Activa en SQL Editor el control de activación de confirmaciones después de terminar la configuración:

```sql
update private.household
set manager_confirmations_enabled = true
where id = 1;
select public.finance_approval('enabled', '{}'::jsonb);
```

La respuesta debe contener `enabled: true`. Mientras esté desactivada, el worker espera y no admite tráfico financiero.

## 9. Instalar servicios y validar

Genera las unidades con la sesión del usuario dedicado:

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

Esto supone un usuario y una ruta local simples, sin metacaracteres de shell/sed. Revisa que no queden marcadores sin sustituir antes de iniciar. El timer usa `America/Bogota`; ajusta el horario si lo necesitas.

Cada miembro debe enviar `/start` en el grupo y consultar `/saldo`. Después crea su cuenta con nombre explícito y verifica administrador y saldo inicial. Usa un hogar de desarrollo desechable para probar operaciones financieras completas. Un registro exitoso incluye ID de transacción; un borrador pendiente no es un asiento.

Ejecuta la primera copia y verifica el resultado:

```sh
sudo systemctl start finanzas-flue-backup.service
sudo journalctl -u finanzas-flue-backup.service -n 20 --no-pager
```

Resultado esperado: `flue_backup_passed` y `offsite_verified: true`. El script crea/comprueba el bucket privado `flue-runtime-backups` y verifica el hash de la copia descargada. Respalda SQLite, no el libro Supabase ni las credenciales OAuth. Completa los respaldos separados de la [guía de operación](operations.es.md).

## Referencias oficiales

- [Supabase Vault](https://supabase.com/docs/guides/database/vault)
- [Referencia de Supabase CLI](https://supabase.com/docs/reference/cli/introduction)
- [Telegram Bot API](https://core.telegram.org/bots/api)

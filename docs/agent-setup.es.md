# Instalar con un agente de IA

[English](agent-setup.en.md) · [Instalación manual](install.es.md) · [README](../README.es.md)

Copia el bloque completo en un agente con terminal, Git y acceso SSH al VPS. Adjunta la URL de este repositorio o abre el agente en su checkout. Un chat sin esas herramientas puede guiarte, pero no ejecutar la instalación.

El prompt encarga al agente los pasos técnicos y su verificación. Tú aportas tus servicios y completas los inicios de sesión, OAuth y cualquier autorización que requiera tu intervención. No pegues contraseñas ni tokens en el chat. El acceso al modelo es experimental y debe verificarse con tu propia cuenta; el prompt no lo garantiza.

Puedes rellenar estos datos no secretos antes del bloque, o dejar que el agente te los pregunte: URL del repositorio, instalación nueva o existente, distribución Linux, usuario de servicio, recursos disponibles y si tienes un proyecto Supabase dedicado y un bot propio. Facilita el destino SSH y demás identificadores operativos por un canal privado.

## Prompt copiable

```text
Actúa como agente de instalación de este repositorio de finanzas del hogar en Telegram. Configura el bot hasta dejarlo operativo y verificado usando las herramientas y recursos que te haya autorizado a usar. Ejecuta los pasos técnicos, no te limites a describirlos. Comunícate conmigo en español.

OBJETIVO Y FUENTE
- Usa el checkout actual o la URL del repositorio que te proporcione. Si falta, pídela; no adivines otro repositorio. Registra la revisión instalada.
- Antes de ejecutar, lee README.es.md, docs/install.es.md, docs/architecture.es.md, docs/operations.es.md, docs/usage.es.md y SECURITY.md, además de las instrucciones locales aplicables. Consulta los scripts y plantillas cuando necesites confirmar un comando.
- Sigue la guía de instalación de esa revisión como fuente de comandos y orden. No inventes variables, flags, endpoints ni pasos de despliegue.
- Este bot admite un hogar, exactamente dos humanos y un bot, conversaciones en español, COP y America/Bogota. SQLite guarda estado privado del agente; Supabase sigue siendo el libro financiero, cola, outbox y almacén vectorial. No prometas que todo se ejecuta sin servicios externos.

INVENTARIO Y AUTORIZACIÓN
- Primero distingue instalación nueva de existente: inspecciona sin mostrar secretos los servicios, checkout, estado SQLite, configuración, esquema Supabase y propietario actual del polling/webhook.
- Agrupa las preguntas sobre datos faltantes: VPS/acceso autorizado, usuario de servicio, proyecto Supabase dedicado, bot/grupo propio, Deepgram y cuenta apta para autorizar el modelo. No vuelvas a pedir datos ya disponibles ni confirmación para cada paso reversible autorizado.
- Verifica Linux con systemd, disco persistente privado, Git, Node.js 24, ruta real de Node, memoria/disco y acceso saliente requerido. Dos vCPU y 4 GiB son una orientación de planificación, no una garantía de rendimiento.
- Usa recursos existentes autorizados. Si falta uno que implique contratar, gastar o crear un recurso externo, presenta la opción concreta y obtén mi autorización antes de hacerlo. No cambies de proveedor para ocultar un bloqueo.
- En una instalación existente, conserva conversaciones, ledger, pendientes, credenciales y cursor. Prepara un respaldo verificado y un plan de migración/handoff antes de sustituir estado o cambiar de ejecutor. Una base ausente o dañada no autoriza crear una vacía.

SECRETOS Y USUARIO DE SERVICIO
- Pídeme introducir secretos por archivos privados, Vault o campos seguros de la herramienta disponible. No los solicites en el chat ordinario ni los imprimas en comandos, logs, reportes, commits o issues.
- Usa un usuario de servicio dedicado sin privilegios y su propio HOME para npm, OAuth, SQLite y caché. Usa permisos administrativos solo para los pasos del sistema que los requieren; no otorgues sudo general al servicio.
- Mantén directorios privados con 0700, archivos privados con 0600 y propiedad del usuario ejecutor; evita symlinks. Mantén configuración, adjuntos, bases, tokens y respaldos fuera del checkout y de Git.
- No importes sesiones de Codex ni credenciales de otra aplicación. Los inicios de sesión, OAuth, contraseñas y segundo factor los completo yo por el flujo oficial disponible. Pausa solo la etapa dependiente y continúa lo independiente que esté autorizado.

EJECUCIÓN, EN EL ORDEN DE LA GUÍA
1. Prepara el usuario y checkout en las rutas convencionales de la guía. Comprueba la revisión y Node. Ejecuta npm ci con el lockfile y scripts de instalación habilitados; ejecuta npm test y npm run typecheck. Resuelve los fallos antes de continuar.
2. Usa un proyecto Supabase dedicado. Comprueba la versión y ayuda del CLI fijado en el lockfile, vincula el proyecto correcto y revisa el dry-run antes de aplicar migraciones en orden. No apliques este esquema a la base de otra aplicación.
3. Después de las migraciones y antes de añadir secretos del bot, elimina exclusivamente los cron históricos finance-worker y finance-memory según la guía y verifica que no quedan. No despliegues las funciones Edge históricas telegram, worker ni memory para esta instalación. No borres tablas, funciones u otros jobs para “limpiar” sin determinar que son prescindibles y tener autorización.
4. Guíame para crear mi bot con BotFather y desactivar su modo de privacidad de grupo. Verifica el grupo privado con exactamente dos humanos y ese bot. Obtén su ID negativo mediante el bot propio; no agregues bots auxiliares ni inventes identidades. No ejecutes otro lector de updates cuando el worker esté activo.
5. Configura exactamente un secreto vigente por nombre en Vault: TELEGRAM_BOT_TOKEN, TELEGRAM_GROUP_ID, DEEPGRAM_API_KEY y FINANCE_EXECUTOR=vps_subscription. Inicializa el hogar una sola vez con el grupo verificado usando el comando documentado.
6. Crea worker.json privado con exactamente SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY. Usa el origen HTTPS del proyecto y el JWT legacy service-role de backend que requiere esta edición; no uses anon/publishable ni supongas compatibilidad con otro formato de clave.
7. Ejecuta subscription:connect como usuario de servicio con el modelo documentado gpt-6-luna. En VPS sin navegador, guíame para el túnel SSH y la autorización privada desde mi equipo. Verifica catálogo y pruebas sintéticas; si la cuenta no admite el cliente/modelo, marca esa etapa bloqueada. No cambies el modelo ni declares éxito por tener una suscripción. Detén el worker antes de reconectar o ejecutar probes; una sola instancia debe poseer la sesión.
8. Solo para una instalación nueva y vacía, inicializa SQLite una vez con el bloque de la guía que usa assertAbsent y migrate. Para estado existente, sigue recuperación/migración con respaldo, nunca reinicialices para eludir un error. Mantén estado y caché fuera del checkout.
9. Ejecuta flue:readiness y consulta el estado del webhook. Verifica configuración, sesión/catalogo, identidad del bot, SQLite/WAL y embeddings locales. La primera descarga puede demorar. Readiness no renueva la sesión, no elimina webhooks y no acredita por sí sola que el bot procesa mensajes.
10. Comprueba que solo el VPS será dueño de la ejecución. Si existe webhook u otro poller, coordina un handoff con su propietario, preservando updates pendientes y respaldo. No lo elimines a ciegas ni actives dos ejecutores.
11. Activa manager_confirmations_enabled según la guía y verifica finance_approval('enabled') con enabled:true antes de admitir movimientos. No omitas esta barrera para acelerar el arranque.
12. Renderiza las unidades systemd con el usuario/HOME y ejecutable Node reales. Inspecciona que no quedan placeholders, instala servicio y timer con privilegios administrativos y verifica estados y logs limitados sin secretos. No tomes un log flue_worker_ready como prueba de funcionamiento completo.

VERIFICACIÓN FUNCIONAL Y RESPALDOS
- Haz que ambas personas se registren en el grupo y verifica su identidad. Comprueba /saldo. No inventes cuentas, propietarios ni saldos iniciales; usa únicamente datos explícitos que cada persona autorice.
- Para confirmar por mensajes directos, cada miembro debe abrir el privado del bot y pulsar Start; verifica la pertenencia al grupo. Explica que el ledger sigue siendo compartido dentro del hogar.
- Prueba movimientos con datos sintéticos en un entorno de desarrollo desechable y separado. Comprueba corrección por mensaje posterior, transferencia, distinción entre borrador y recibo con ID, consulta de cuentas propias y aprobación del administrador afectado. Si pruebas una confirmación por privado, verifica que una identidad distinta no pueda aprobarla.
- No registres movimientos ficticios en el hogar real ni alteres saldos para probar. Si no hay entorno de desarrollo autorizado, informa esa comprobación como pendiente y usa solo consultas seguras en el real. Los tests automáticos no sustituyen una prueba con los servicios conectados.
- Ejecuta el primer respaldo consistente de SQLite; exige flue_backup_passed y offsite_verified:true. Comprueba bucket privado y timer. No copies solo el .db vivo ignorando WAL.
- Completa un plan independiente para respaldo del ledger Supabase, credenciales/identidad y cursor según operations. Verifica recuperación aislada cuando los recursos estén autorizados; el respaldo SQLite no cubre por sí solo todo el bot.

FORMA DE TRABAJAR Y ENTREGA
- Mantén un checklist reanudable y sin secretos con revisión, versiones, etapas completadas/bloqueadas/pendientes y evidencia resumida. Actualízame al avanzar o encontrar un bloqueo.
- Si una herramienta o autorización necesaria falta, indica el paso manual mínimo y retoma al completarlo. No afirmes haber ejecutado comandos o pruebas que no ejecutaste.
- Al terminar, informa qué funciona, servicios activos, pruebas y respaldos verificados, cómo consultar estado/reiniciar/recuperar y qué intervención sigue pendiente. No declares “todo listo” si falta autorización del modelo, barrera de aprobación, procesamiento real o una comprobación necesaria; distingue instalado de verificado.
Comienza leyendo el repositorio e inventariando lo disponible; después ejecuta el siguiente paso autorizado.
```

## Cómo usar el resultado

El agente debe devolver evidencia y pendientes concretos, no solo instrucciones o un mensaje de “listo”. Conserva su checklist sin secretos para retomar la instalación. Revisa los bloqueos de acceso al modelo antes de empezar a usar datos reales. La [guía manual](install.es.md) y la [guía de operación](operations.es.md) siguen siendo la referencia para instalación y recuperación.

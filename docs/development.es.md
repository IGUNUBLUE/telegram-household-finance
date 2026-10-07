# Desarrollo y comprobaciones de publicación

[English](development.en.md) · [README](../README.es.md)

## Reproducir el entorno

Usa Node.js 24 e instala las dependencias exactas del lockfile:

```sh
npm ci
npm test
npm run typecheck
```

La suite usa el runner de Node, PGlite con vector, proveedores ficticios, llamadas de red simuladas y SQLite temporal. Varios archivos concurrentes pueden consumir bastante memoria. En un servidor limitado puedes ejecutar la misma suite con menor concurrencia:

```sh
node --test --test-concurrency=2 tests/*.test.ts
```

Las pruebas predeterminadas no autorizan una cuenta de inferencia, no leen finanzas de producción ni envían mensajes Telegram. Demuestran los contratos ejercitados, no el acceso al catálogo real, las extensiones desplegadas ni el flujo Telegram completo.

## Hacer cambios

Crea una rama y usa nombres, IDs, saldos y conversaciones ficticios. Conserva centavos exactos, asientos inmutables, verificación de administradores, revisiones e idempotencia de cola/outbox. Añade regresiones de comportamiento si cambias esos contratos; las correcciones de documentación no requieren pruebas que repitan su texto.

Para cambios de base, inspecciona la ayuda de la CLI fijada y crea la migración con `npx supabase migration new DESCRIPTIVE_NAME`. No reescribas migraciones aplicadas. Prueba la cadena ordenada en un proyecto de desarrollo aislado y ejecuta las pruebas pertinentes. Los fixtures PGlite simulan roles/Vault y omiten las migraciones de cron alojado: valida por separado cron y extensiones antes del despliegue.

Actualiza ambos idiomas cuando cambien configuración, comportamiento o comandos. Los textos españoles del bot son parte del contrato actual; una documentación bilingüe no vuelve multilingüe la conversación.

## Herramientas reales opcionales

| Herramienta | Alcance |
| --- | --- |
| `subscription:connect` / `subscription:probe` | Autorizar cuenta propia y probar proveedor con casos sintéticos |
| `flue:readiness` | Configuración/sesión actuales, identidad del bot, SQLite y embeddings |
| `scripts/flue-evaluation.ts` | Evaluación explícita; revisar argumentos y fixtures |
| `scripts/agent-general-eval.ts` / `scripts/account-scope-eval.ts` | Evaluación sintética explícita con modelo real |
| Scripts de evaluación/reindexación | Revisar código; reindexar puede modificar vectores del proyecto |
| Migración de estado / replay archivado | Herramientas históricas Postgres con origen explícito y destino aislado |

No ejecutes todos los scripts como una suite genérica. Algunos acceden a servicios reales o hacen escrituras operativas. Consultas y documentos necesitan el mismo modelo fijado al reindexar. Las migraciones de estado no pueden usar un esquema fuente ya retirado sin un respaldo privado apropiado.

## Lista para una publicación pública

1. Exporta solo código, migraciones, pruebas y plantillas revisadas. Excluye credenciales, estado, archivos de conversaciones, informes internos, adjuntos y caché.
2. Escanea todos los archivos rastreados, incluidos ejemplos, fixtures, certificados y metadatos, buscando secretos e identificadores personales/de infraestructura. Revisa resultados sin imprimir secretos reales.
3. Revisa historial, autores, remotos, ramas, tags y archivos grandes/binarios. Un árbol limpio no limpia objetos Git antiguos. Un snapshot público nuevo no debe importar historial privado.
4. Ejecuta la suite completa, typecheck, enlaces de documentación e inicialización/backup/recuperación SQLite aislados. Revisa todos los fallos y corrige sus causas.
5. Revisa descripción, plantillas de issues, archivos de releases y metadatos de commits. GitHub sigue mostrando la identidad pública de la cuenta propietaria; limpiar código no anonimiza esa cuenta.
6. Publica solamente el snapshot revisado, verifica visibilidad y árbol remoto, y separa configuración de producción. No añadas datos privados a logs CI, pull requests ni notas públicas.

MIT licencia el código del proyecto. Las dependencias y el modelo descargado conservan sus licencias; consulta sus avisos si los redistribuyes. El texto estándar de `LICENSE` es el que aplica; la documentación española explica su uso sin reemplazarlo por una traducción legal.

# Verificación de la edición pública

[English](release-check.en.md)

Comprobado el 2026-10-07 UTC antes de preparar el snapshot público inicial:

| Comprobación | Resultado |
| --- | --- |
| Suite predeterminada completa | 441 aprobadas, 0 fallos, 0 omitidas |
| TypeScript | `npm run typecheck` aprobado |
| Inicialización SQLite nueva | Permisos privados y aceptación por la validación de producción |
| Protección del estado existente | Rechaza reinicialización y conserva el archivo original |
| Copia/recuperación SQLite independiente | Restauración e integridad verificadas |
| Enlaces locales de documentación | Sin destinos faltantes |
| Identificadores privados conocidos y ejemplos financieros distintivos | Retirados de los archivos distribuidos |
| Patrones de credenciales | Sin coincidencias en los archivos distribuidos |
| Historial de publicación | Repositorio público nuevo sin importar el historial privado anterior |

Los ejemplos y pruebas usan identidades y cuentas ficticias. Se excluyen informes internos, historial privado anterior, credenciales, bases, adjuntos y caché. Las plantillas de despliegue usan marcadores del instalador.

Estas comprobaciones no certifican un despliegue real para otro hogar. La suite usó las dependencias fijadas disponibles. El instalador debe comprobar extensiones/cron alojados, migraciones en su proyecto nuevo, elegibilidad OAuth/modelo, descarga y entrega Telegram en su propio entorno aislado. No se modificó la base de producción ni el bot operativo para preparar esta edición.

Buscar patrones de secretos ayuda a revisar, pero no garantiza detectar todo secreto codificado posible. Mantén ficticias las contribuciones y revisa archivos e historial publicados. GitHub muestra la identidad pública de la cuenta propietaria del repositorio.

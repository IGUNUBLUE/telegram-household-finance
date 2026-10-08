# Cambio de modelo a Luna 6

[English](model-luna6-check.en.md) · [README](../README.es.md)

Esta revisión selecciona `gpt-6-luna` para el runtime Flue. El proveedor, el modelo por defecto del agente, la comprobación de arranque y las trazas usan la misma constante. Si no aparece en el catálogo, el arranque se detiene; no hay cambio automático a otro modelo. El modelo almacenado en una sesión OAuth anterior no sustituye la selección del runtime. Verifica autorización y casos sintéticos con tu propia cuenta antes del despliegue; el acceso depende de cada cuenta.

Se conservan la ventana de contexto, historial, memoria, esquemas de herramientas, autorizaciones, límites de ejecución y reglas de cálculo financiero. El prompt `finance-harness-19` aclara quién realizó un traslado, distingue administrador de cuenta y remitente, y distingue autor del registro y receptor. Si la relación de una consulta personal es ambigua, pregunta antes de seleccionar registros.

El simulador aislado ahora admite la RPC existente para guardar varios borradores además de uno solo. Esto refleja una herramienta que ya estaba disponible en producción. No agrega una operación ejecutable al bot.

Ante un pedido ambiguo, la evaluación comprueba que la respuesta pregunte qué relación quiere consultar, no atribuya datos financieros y conserve el libro. Una lectura interna del hogar está permitida por el modelo de acceso compartido y no equivale a mostrar esos datos. Las consultas concretas siguen comprobando el filtro SQL por persona, relación, orden y registros devueltos.

Los resultados están en [el informe sintético del modelo](model-luna6-acceptance.json). Contiene únicamente nombres de escenarios y métricas. Su resumen de la primera corrida conserva los fallos iniciales. Los tiempos incluyen trabajo con herramientas y datos ficticios; no miden la entrega completa por Telegram.

Despliega con una versión candidata y dependencias propias, aplica la migración de trazas, verifica una copia y detén el único worker antes de cambiar la versión. Conserva SQLite, estado de polling y datos financieros. Comprueba que `flue_worker_ready` y readiness indiquen `gpt-6-luna`, con la autorización de administradores habilitada. Consulta [operación y reversión](operations.es.md). La migración también admite el modelo anterior para restaurar una versión compatible sin reescribir el libro.

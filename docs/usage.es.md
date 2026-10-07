# Uso del bot

[English](usage.en.md) · [README](../README.es.md)

El bot entiende y responde actualmente en español. Todos estos nombres y cuentas son ficticios. Prueba los ejemplos en un hogar de desarrollo desechable, no en un libro real. Crea las cuentas antes de registrar operaciones sobre ellas.

## Cuentas y movimientos

| Objetivo | Mensaje al bot |
| --- | --- |
| Cuenta propia | `Crea mi cuenta Banco Alfa con saldo inicial 250000 COP hoy.` |
| Gasto personal | `Gasté 18000 COP en transporte personal desde Banco Alfa hoy.` |
| Gasto familiar | `Descuenta 75000 COP de Banco Alfa por mercado familiar hoy.` |
| Cuenta nueva y traslado enlazado | `Crea mi cuenta Ahorro con saldo inicial cero y pasa 200000 COP de Banco Alfa a Ahorro hoy. Es personal.` |
| Traslado y pago posterior | `Trasladé 450000 COP de Ahorro a Banco Alfa y desde Banco Alfa pagué 450000 COP de arriendo hoy. Ambos familiares.` |
| Ingreso de contraparte externa | `Recibí 900000 COP del arrendatario Taylor Example en Banco Alfa por arriendo familiar hoy.` |
| Saldo inicial de deuda | `Crea mi cuenta Tarjeta Alfa: debo 125000.45 COP hoy. Es deuda inicial, no cupo.` |

El traslado y el pago son operaciones diferentes, no un ingreso adicional. La contraparte externa no debe convertirse en miembro del hogar. Si faltan datos esenciales, el bot pregunta y conserva un borrador. La confirmación del borrador no equivale a un movimiento registrado. El registro final incluye ID de transacción. Si se requiere aprobación de otro administrador, espera su confirmación de la solicitud exacta.

## Continuaciones y correcciones

Puedes enviar `Es familiar` o `Perdón, fueron 75000 pesos` como continuación del pendiente activo. Responde explícitamente al mensaje correspondiente cuando existan varios hilos. Los mensajes seguidos pueden generar una respuesta consolidada o una actualización del mensaje del bot, en vez de una pregunta obsoleta seguida del comprobante. Operaciones diferentes todavía pueden necesitar respuestas separadas.

Para un movimiento ya registrado, indica su ID y los datos correctos: `Corrige el movimiento #12: fueron 78000 COP, desde Banco Alfa`. El sistema registra reversión y reemplazo auditados, sin borrar el historial. `/deshacer #ID` inicia la reversión; proporciona el motivo si lo solicita. No reenvíes el mismo pago para corregirlo informalmente: puede activar duplicados o crear otra operación tras confirmarla.

## Consultas y comandos

| Solicitud | Comportamiento |
| --- | --- |
| `¿Cómo están mis cuentas?` | Cuentas administradas por el solicitante verificado |
| `Muéstrame el total de todas las cuentas del hogar` | Panorama global explícito |
| `¿Cuál es el saldo de Banco Alfa?` | Saldo registrado e indicadores de completitud |
| `¿Qué movimientos explican ese saldo?` | Explicación basada en el libro |
| `¿Ya está registrado el traslado de 200000 COP de Banco Alfa a Ahorro?` | Búsqueda sin crear otro traslado |
| `/saldo` | Saldos registrados |
| `/exportar` | Exportación del libro; manéjala en privado |
| `/pendientes` | Pendientes; por privado se limita a confirmaciones autorizadas |

Los saldos reflejan el libro, no una conexión bancaria en vivo. Los saldos iniciales desconocidos/no verificados conservan esa indicación. El alcance personal/familiar atribuye el movimiento; no oculta los mensajes al otro miembro del grupo.

## Confirmaciones de administradores

El aviso del grupo identifica al administrador afectado y resume importe, cuentas y operación exacta. El responsable puede usar los botones Confirmar/Rechazar o una confirmación textual inequívoca de esa solicitud. El “sí” de otra persona no reemplaza su aprobación.

Para avisos privados, abre el chat del bot y pulsa Iniciar. El bot verifica que seas miembro existente del grupo configurado. `/pendientes` muestra allí las confirmaciones que puedes resolver. Puedes confirmar por cualquiera de los canales autorizados; no son operaciones financieras separadas. El primer aviso y como máximo dos rondas posteriores por hora se detienen al confirmar, rechazar o vencer a las 48 horas.

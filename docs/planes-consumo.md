# Nexo IA: planes y consumo — incremento local del 22 de octubre de 2026

El backend ahora valida el plan, modelo y cupo antes de cada llamada de web, móvil o Alexa. La app incorpora **Mi plan y consumo**, conectada a `GET /me/usage`. Los cambios están en `feature/planes-consumo` en ambos repositorios. No se han publicado ni activado pagos.

## Carpetas reales

- Backend/web: `C:\Users\polom\Proyectos\Escuela\Nexo_IA\Backend`.
- App: `C:\Users\polom\Proyectos\Escuela\Nexo_IA\App_movil\laboratorio-naranja-app`.

Las rutas anteriores de `Documents` son junctions a estas carpetas. Ejecutar Expo desde la ruta real: la exportación desde el junction duplicó React en el bundle y falló en el navegador; la exportación desde la carpeta real pasó la comprobación visual.

## Decisiones

- **Unidad del cupo: consultas**, con valores de beta configurables: Básico 20, Pro 200 y límite global 1000 por mes calendario UTC. No son cuotas comerciales ni un límite de gasto en moneda.
- Se registran separadamente los tokens de entrada, salida y total que informa cada proveedor, junto con el modelo real. No se inventan cifras si faltan metadatos. Todavía falta convertir esos datos en costos y definir precios.
- Básico incluye Groq rápido. Pro incluye los cuatro modelos ya presentes en el proyecto. `auto` elige Groq rápido; un fallo no dispara automáticamente otra llamada de pago.
- El plan se obtiene de `ai_accounts`, con Básico como valor inicial. El cliente no puede concederse Pro. No existe todavía un endpoint de compra ni verificación de suscripciones.
- Las reservas se confirman en PostgreSQL antes de llamar al proveedor. Un bloqueo por cuenta protege su cupo entre canales y un bloqueo compartido protege el cupo global entre usuarios y procesos. El presupuesto global conserva el consumo aunque una cuenta se elimine.
- Cada llamada tiene un identificador de idempotencia. Repetirlo con el mismo contenido devuelve la respuesta guardada o el estado pendiente, sin una segunda llamada; usarlo con otro contenido responde 409. Web/móvil lo envían en `request_id`; también se admite `Idempotency-Key`. Alexa usa `request.requestId`.
- El cliente conserva ese identificador para reintentar después de un error incierto durante la sesión. Los clientes antiguos sin identificador siguen siendo compatibles, pero no pueden deduplicar reintentos. La persistencia del intento móvil entre cierres de la app queda pendiente.
- Un rechazo confirmado del proveedor libera la reserva. Un timeout, desconexión, 5xx o respuesta incierta la mantiene: liberar automáticamente podría admitir una segunda consulta ya facturada. La conciliación administrativa de reservas inciertas queda pendiente; no caducan automáticamente.
- Respuesta, historial y tokens se guardan en una transacción. Si falla el guardado después de la llamada, la reserva permanece y el proveedor no se vuelve a consultar.
- Contexto limitado a `AI_MAX_INPUT_BYTES` (16000 por defecto), pregunta a la mitad de ese tamaño y salida a `AI_MAX_OUTPUT_TOKENS` (512). Son límites de texto, no equivalencias de precio entre modelos.

## Archivos propios de este incremento

- `index.js`: fábrica de app importable sin cargar `.env`, sin conectar automáticamente y sin iniciar el servidor; rutas conectadas al control común; errores de chat sin detalles privados del proveedor.
- `lib/plans.js`: planes, modelos y configuración validada.
- `lib/usage-store.js`: reservas, registros y consulta del consumo.
- `lib/chat-service.js`: validación y flujo común.
- `lib/providers.js`: una llamada por intento, topes, timeout y normalización de metadatos de OpenAI/Groq/Gemini.
- `migrations/001-plans-consumption.sql`: nuevas tablas, sin ejecución automática.
- `scripts/test-isolated.mjs` y `test/*.test.js`: pruebas con PostgreSQL temporal y proveedores simulados.
- `scripts/migrate-local.mjs`: preparación explícita de una base de desarrollo local.
- `frontend/index.html`: identificador estable para reintentos de web.
- `env.example` y `package.json`: configuración de beta y comandos.
- En la app: `app/(tabs)/index.tsx`, `components/plan-usage.tsx` y `hooks/use-plan-usage.ts`.

Se conservaron los cambios previos de `.gitignore`, dependencias/lockfile, pruebas Playwright, `app.json` y `eas.json`. Las pruebas Playwright anteriores apuntan al sitio público y no se ejecutaron.

## Comandos de verificación

En el backend:

```powershell
npm run test:consumption
node --check index.js
git diff --check
```

El primer comando crea un cluster NUEVO de PostgreSQL en `%TEMP%`, en un puerto libre de `127.0.0.1`, crea exclusivamente `nexo_plans_test`, prueba y detiene ese cluster. No lee `.env` ni utiliza `DATABASE_URL`; tampoco consulta las APIs reales. Detecta PostgreSQL bajo `C:\Program Files\PostgreSQL`, o admite `NEXO_TEST_PG_BIN`. No modifica el servicio de PostgreSQL que ya pueda existir.

En la carpeta real de la app:

```powershell
.\node_modules\.bin\tsc.cmd --noEmit
.\node_modules\.bin\eslint.cmd components/plan-usage.tsx hooks/use-plan-usage.ts
$env:EXPO_NO_DOTENV = '1'
$env:EXPO_PUBLIC_API_URL = 'http://127.0.0.1:57641'
.\node_modules\.bin\expo.cmd export --platform web --output-dir <carpeta-temporal>
```

La URL anterior fue una fixture local con datos sintéticos para revisar la UI, no un servidor de IA ni una cuenta real. No usarla en una compilación de distribución. La app admite `EXPO_PUBLIC_API_URL` para desarrollo; si falta mantiene la URL pública anterior. La vista de consumo muestra un error entendible si el backend público aún no tiene el endpoint.

## Preparación local y migración

**El arranque del servidor ya no crea ni altera tablas.** Comprueba que exista `ai_requests` y se detiene si falta el esquema. La migración 001 debe aplicarse explícitamente antes de utilizar esta rama. No se ejecutó sobre ninguna base existente.

Para una base local nueva llamada `nexo_ia_dev`, creada previamente en PostgreSQL:

```powershell
$env:NEXO_LOCAL_DATABASE_URL = 'postgresql://usuario:password@127.0.0.1:5432/nexo_ia_dev'
npm run db:prepare:local
```

Este comando rechaza hosts remotos y nombres distintos de `nexo_ia_dev`; prepara el esquema anterior y las tablas nuevas. No se ejecutó en esta entrega. Para iniciar desarrollo después, configurar el backend exclusivamente con esa base local y comprobar sus variables antes de arrancar. No usar el `.env` existente sin revisar su destino.

El archivo SQL crea tablas nuevas y puede revisarse para una futura migración de producción. No hay orden de despliegue automático. El plan Pro se puede sembrar manualmente sólo en la base local de pruebas; la asignación pública dependerá de compras verificadas en servidor.

## Resultados y límites

La verificación final y la captura visual se documentan en el informe de entrega. La comprobación visual usa la versión web de Expo a 390 × 844; todavía falta validar Android físico, dispositivos Alexa reales y disponibilidad actual de los modelos con credenciales de un entorno controlado.

Antes de una beta pública quedan OAuth/Account Linking y autenticación de solicitudes Alexa, auditoría de sesiones y administración, conciliación de consumos inciertos, medición de costos, límites por costo, verificación de compras Google Play y preparación de publicación. La vinculación por código actual permanece como estaba.

Referencias utilizadas para la implementación: [OpenAI Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create), [Groq](https://console.groq.com/docs/api-reference), [Gemini](https://ai.google.dev/api/generate-content), [bloqueos PostgreSQL](https://www.postgresql.org/docs/current/explicit-locking.html) y [fuente versionada Expo SDK 54](https://github.com/expo/expo/tree/sdk-54/docs/pages/versions/v54.0.0).

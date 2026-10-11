# Presentación con subtítulos IA (Cloudflare + OpenAI gpt-live-transcribe)

PDF (PDF.js) o PPTX + subtítulos en vivo: micrófono → PCM 24 kHz → Worker → OpenAI Realtime (`gpt-live-transcribe`, `delay: minimal`) → pantalla.

## Local

```bash
npm install
cp .dev.vars.example .dev.vars   # pon tu OPENAI_API_KEY
npm run dev                      # http://localhost:8787
```

## Producción

```bash
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put ACCESS_TOKEN   # opcional, recomendado
npm run deploy                         # abre https://<worker>.workers.dev/?token=<ACCESS_TOKEN>
```

## Atajos

| Tecla | Acción |
|---|---|
| → / Espacio / PageDown | Siguiente diapositiva (compatible con clickers) |
| ← / PageUp | Anterior |
| F | Pantalla completa |
| H / doble clic | Ocultar/mostrar controles |

El PDF o PPTX también se puede arrastrar sobre la zona de diapositivas.
Los `.pptx` se dibujan en el navegador con [pptx-preview](https://www.npmjs.com/package/pptx-preview): sin animaciones ni transiciones,
y con las fuentes instaladas en el equipo, así que si el diseño importa exporta a PDF. Si OpenAI cierra la sesión (tiene duración máxima), el cliente reconecta solo mientras el micrófono esté activo.

## Modos de subtítulos

En la barra de controles se elige por charla (se recuerda en el navegador):

| Opción | Cómo funciona | Retraso medido | Calidad |
|---|---|---|---|
| ⚡ Traducir al español (por defecto) | `gpt-live-transcribe` + traducción de texto `gpt-oss-120b` vía OpenRouter | Al terminar cada oración (o la frase: pausa de 0,6 s, 12 s máx.) + ~0,5–1 s de traducción; cada frase queda en pantalla 1,5–6 s según su largo (~20 car/s) | Fiel y completa |
| 🌐 Traducir (traductor OpenAI) | `gpt-realtime-translate` | ~0,7–2 s | A veces inventa u omite frases |
| 🧠 Traducir con GPT-Live (prueba) | `gpt-live-1` como intérprete | 5–8 s | Muy buena |
| 🇪🇸 Orador en español (sin traducir) | `gpt-live-transcribe` | ~0,7 s | Literal |

En el modo ⚡ el navegador traduce cada frase llamando a `POST /api/translate`, que usa OpenRouter
(secreto `OPENROUTER_API_KEY`) restringido a los proveedores rápidos de `TRANSLATE_LLM_HOSTS` y elige el de menor latencia.
Al encender el micrófono se hace una traducción de calentamiento (la primera en frío tarda 4–9 s) y se repite tras 45 s sin actividad.
Alternativa: `TRANSLATE_LLM_PROVIDER = "groq"` con `GROQ_API_KEY`; en el plan gratis de Groq pon `TRANSLATE_MIN_INTERVAL_MS = "2100"`
(30 peticiones/min, 1.000/día ≈ 35 min de charla).

No uses los traductores con oradores en español: reescriben el discurso en vez de repetirlo.
Para diagnosticar, agrega `?debug` a la URL del WebSocket y el Worker reenvía cada evento de OpenAI.

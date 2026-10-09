// Edge Presentation & Captioning System
// Proxy WebSocket bidireccional: navegador (PCM 24 kHz) <-> OpenAI. Cuatro modos (?mode=):
//   hybrid     -> gpt-live-transcribe + traducción de texto rápida vía OpenRouter (fiel y rápido)
//   translate  -> gpt-realtime-translate: traductor simultáneo (subtítulos en TRANSLATE_TO)
//   live       -> gpt-live-1 con instrucciones de intérprete (subtítulos en TRANSLATE_TO)
//   transcribe -> gpt-live-transcribe: subtítulos literales en el idioma original
// Los archivos estáticos de /public los sirve Cloudflare directamente (ver [assets] en wrangler.toml).

const TRANSCRIBE_URL = "https://api.openai.com/v1/realtime?intent=transcription";
const TRANSLATE_URL = "https://api.openai.com/v1/realtime/translations?model=";
const LIVE_URL = "https://api.openai.com/v1/live/sessions";

const LANGUAGE_NAMES = { es: "Spanish", en: "English", pt: "Portuguese", fr: "French" };
const interpreterPrompt = (lang) =>
  `You are a professional simultaneous interpreter at a medical congress. ` +
  `Translate everything the speaker says into ${LANGUAGE_NAMES[lang] || lang}, faithfully and completely, ` +
  `as soon as you have enough context. Keep technical and medical terms precise. ` +
  `Never answer questions, greet, comment, summarize or add anything of your own: you only interpret. ` +
  `If the speaker already speaks ${LANGUAGE_NAMES[lang] || lang}, repeat their words verbatim.`;

// gpt-live-transcribe no admite VAD del servidor: el Worker decide cuándo cerrar cada frase
// (commit) detectando silencio. Los deltas parciales llegan antes, sin esperar al commit.
const SAMPLE_RATE = 24000;        // OpenAI exige >= 24 kHz
const SPEECH_RMS = 0.015;          // energía (0..1) a partir de la cual se considera voz
const SILENCE_COMMIT_MS = 600;     // silencio tras hablar que cierra la frase
const MAX_SEGMENT_MS = 12000;      // tope por frase aunque el orador no haga pausas

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/translate" && request.method === "POST") {
      return handleTranslate(request, env, url);
    }
    if (url.pathname !== "/ws/stream") {
      return new Response("Not found", { status: 404 });
    }
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Se requiere un canal WebSocket.", { status: 426 });
    }
    // Token opcional para que nadie más consuma tu cuota de OpenAI con la URL pública.
    if (env.ACCESS_TOKEN && url.searchParams.get("token") !== env.ACCESS_TOKEN) {
      return new Response("No autorizado", { status: 401 });
    }
    if (!env.OPENAI_API_KEY) {
      return new Response("Falta el secreto OPENAI_API_KEY", { status: 500 });
    }

    // El operador elige el modo por charla desde la página. Traducir español a español reescribe
    // el discurso, por eso a un orador en español se le transcribe en vez de traducirlo.
    const mode = ["hybrid", "translate", "live", "transcribe"].includes(url.searchParams.get("mode"))
      ? url.searchParams.get("mode")
      : env.DEFAULT_MODE || "hybrid";
    const translateTo = (env.TRANSLATE_TO || "es").trim();
    const upstreamUrl = {
      hybrid: TRANSCRIBE_URL,
      translate: TRANSLATE_URL + encodeURIComponent(env.TRANSLATE_MODEL || "gpt-realtime-translate"),
      live: LIVE_URL,
      transcribe: TRANSCRIBE_URL,
    }[mode];
    const llmKey = env.TRANSLATE_LLM_PROVIDER === "groq" ? "GROQ_API_KEY" : "OPENROUTER_API_KEY";
    if (mode === "hybrid" && !env[llmKey]) {
      return new Response(`Falta el secreto ${llmKey}`, { status: 500 });
    }

    // Abrir primero el socket hacia OpenAI para poder informar errores antes del 101.
    let upstream;
    try {
      const resp = await fetch(upstreamUrl, {
        headers: { Upgrade: "websocket", Authorization: `Bearer ${env.OPENAI_API_KEY}` },
      });
      upstream = resp.webSocket;
      if (!upstream) {
        return new Response(`OpenAI rechazó la conexión (HTTP ${resp.status})`, { status: 502 });
      }
    } catch (err) {
      return new Response(`No se pudo conectar con OpenAI: ${err}`, { status: 502 });
    }
    upstream.accept();

    const { 0: client, 1: server } = new WebSocketPair();
    server.accept();
    // Con fechas de compatibilidad recientes los frames binarios llegan como Blob por defecto.
    server.binaryType = "arraybuffer";
    upstream.binaryType = "arraybuffer";

    const sendClient = (msg) => {
      try { server.send(JSON.stringify(msg)); } catch {}
    };
    const sendUpstream = (msg) => {
      try { upstream.send(JSON.stringify(msg)); } catch {}
    };

    const debug = url.searchParams.has("debug");
    // En modo hybrid se transcribe el idioma del orador (SOURCE_LANGUAGES) y luego se traduce.
    const languages = ((mode === "hybrid" ? env.SOURCE_LANGUAGES : env.TRANSCRIBE_LANGUAGES) || "es")
      .split(",").map((l) => l.trim()).filter(Boolean);

    // En modo hybrid el Worker solo entrega la transcripción original (source: true); el navegador
    // la traduce pidiendo POST /api/translate. Así cada traducción es una invocación aparte y no
    // agota el límite de subpeticiones de esta conexión WebSocket, que dura toda la charla.

    if (mode === "translate") {
      sendUpstream({
        type: "session.update",
        session: { audio: { output: { language: translateTo } } },
      });
    } else if (mode === "live") {
      // gpt-live-1 siempre genera voz; el Worker la descarta y solo usa su transcripción.
      sendUpstream({
        type: "session.start",
        session: {
          model: env.LIVE_MODEL || "gpt-live-1",
          instructions: interpreterPrompt(translateTo),
          audio: { format: { type: "audio/pcm", rate: SAMPLE_RATE } },
        },
      });
    } else sendUpstream({
      type: "session.update",
      session: {
        type: "transcription",
        audio: {
          input: {
            format: { type: "audio/pcm", rate: SAMPLE_RATE },
            transcription: {
              model: env.TRANSCRIBE_MODEL || "gpt-live-transcribe",
              delay: env.TRANSCRIBE_DELAY || "minimal",
              languages,
              // Contexto para que reconozca bien la terminología (p. ej. "anterior cruciate ligament").
              ...(mode === "hybrid" && env.TRANSCRIBE_PROMPT ? { prompt: env.TRANSCRIBE_PROMPT } : {}),
            },
            turn_detection: null,
          },
        },
      },
    });

    // El audio que llega antes de session.updated se encola para no perder las primeras palabras.
    let ready = false;
    const pending = [];

    let hadSpeech = false;
    let silenceMs = 0;
    let segmentMs = 0;

    // La traducción no tiene items: el Worker numera segmentos y abre uno nuevo tras cada fin de oración.
    let segment = 0;
    const segmentId = () => `t${segment}`;

    const forwardAudio = (buf) => {
      // Traductor y GPT-Live siguen el ritmo del orador por sí solos: sin detección de silencios ni commits.
      if (mode === "translate") {
        sendUpstream({ type: "session.input_audio_buffer.append", audio: toBase64(buf) });
        return;
      }
      if (mode === "live") {
        sendUpstream({ type: "session.input_audio.append", audio: toBase64(buf) });
        return;
      }
      sendUpstream({ type: "input_audio_buffer.append", audio: toBase64(buf) });

      const samples = new Int16Array(buf);
      const chunkMs = (samples.length / SAMPLE_RATE) * 1000;
      segmentMs += chunkMs;
      if (rms(samples) >= SPEECH_RMS) {
        hadSpeech = true;
        silenceMs = 0;
      } else {
        silenceMs += chunkMs;
      }

      if (debug && Math.round(segmentMs) % 1000 < chunkMs) {
        sendClient({ type: "debug", event: "worker.audio", detail: `rms=${rms(samples).toFixed(4)} bytes=${buf.byteLength} habla=${hadSpeech}` });
      }

      if ((hadSpeech && silenceMs >= SILENCE_COMMIT_MS) || segmentMs >= MAX_SEGMENT_MS) {
        if (debug) sendClient({ type: "debug", event: "worker.commit", detail: `habla=${hadSpeech} ms=${Math.round(segmentMs)}` });
        // Solo se cierra un segmento con voz: OpenAI rechaza commits vacíos y el silencio no aporta.
        if (hadSpeech) sendUpstream({ type: "input_audio_buffer.commit" });
        else sendUpstream({ type: "input_audio_buffer.clear" });
        hadSpeech = false;
        silenceMs = 0;
        segmentMs = 0;
      }
    };

    upstream.addEventListener("message", (event) => {
      let payload;
      try {
        payload = JSON.parse(typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data));
      } catch (err) {
        console.error("Mensaje de OpenAI ilegible:", err);
        return;
      }

      // Con ?debug en la URL se reenvía al navegador el tipo de cada evento de OpenAI (salvo el audio traducido).
      if (debug && payload.type !== "session.output_audio.delta") sendClient({ type: "debug", event: payload.type, detail: JSON.stringify(payload).slice(0, 300) });

      switch (payload.type) {
        case "session.updated":
        case "transcription_session.updated":
        case "session.started":
          if (!ready) {
            ready = true;
            for (const buf of pending.splice(0)) forwardAudio(buf);
            // Pausa mínima entre traducciones del modo hybrid (TRANSLATE_MIN_INTERVAL_MS).
            sendClient({ type: "ready", translateMinIntervalMs: Number(env.TRANSLATE_MIN_INTERVAL_MS) || 0 });
          }
          break;
        case "conversation.item.input_audio_transcription.delta":
          sendClient({ type: "caption", item: payload.item_id, text: payload.delta, source: mode === "hybrid" });
          break;
        case "conversation.item.input_audio_transcription.completed":
          sendClient({ type: "final", item: payload.item_id, text: payload.transcript, source: mode === "hybrid" });
          break;
        case "session.output_transcript.delta":
          sendClient({ type: "caption", item: segmentId(), text: payload.delta });
          if (/[.!?…]\s*$/.test(payload.delta)) segment++;
          break;
        case "error":
          console.warn("OpenAI:", JSON.stringify(payload.error));
          sendClient({ type: "error", message: payload.error?.message || "Error de OpenAI" });
          break;
      }
    });

    server.addEventListener("message", (event) => {
      if (!(event.data instanceof ArrayBuffer)) return;
      try {
        if (ready) forwardAudio(event.data);
        else if (pending.length < 100) pending.push(event.data);
      } catch (err) {
        console.error("Error procesando audio:", err);
        if (debug) sendClient({ type: "debug", event: "worker.exception", detail: String(err) });
      }
    });

    const shutdown = (code, reason) => {
      try { server.close(code, reason); } catch {}
      try { upstream.close(code, reason); } catch {}
    };
    server.addEventListener("close", () => shutdown(1000, "cliente desconectado"));
    server.addEventListener("error", () => shutdown(1011, "error cliente"));
    upstream.addEventListener("close", (e) => {
      if (e.reason) console.warn("OpenAI cerró la sesión:", e.code, e.reason);
      sendClient({ type: "error", message: e.reason || "OpenAI cerró la sesión" });
      shutdown(1000, "openai desconectado");
    });
    upstream.addEventListener("error", () => shutdown(1011, "error openai"));

    return new Response(null, { status: 101, webSocket: client });
  },
};

// POST /api/translate { text, context } -> { text }. Un 429 del proveedor se devuelve tal cual
// (con retry-after) para que el navegador espere antes de volver a pedir.
async function handleTranslate(request, env, url) {
  if (env.ACCESS_TOKEN && url.searchParams.get("token") !== env.ACCESS_TOKEN) {
    return new Response("No autorizado", { status: 401 });
  }
  let body;
  try { body = await request.json(); } catch { return new Response("JSON inválido", { status: 400 }); }
  const text = String(body.text || "").slice(0, 2000);
  if (!text.trim()) return Response.json({ text: "" });
  try {
    const translated = await translateText(env, (env.TRANSLATE_TO || "es").trim(), text, String(body.context || "").slice(0, 1000));
    return Response.json({ text: translated });
  } catch (err) {
    const status = err.status === 429 ? 429 : 502;
    return Response.json({ error: String(err.message || err) }, {
      status,
      headers: err.retryAfter ? { "retry-after": err.retryAfter } : {},
    });
  }
}

// Traduce un fragmento (quizá a medio decir) con un modelo de texto rápido.
// Por defecto vía OpenRouter (se paga con créditos, sin el tope diario del plan gratis de Groq),
// restringido a proveedores de inferencia rápida y eligiendo el de menor latencia en cada momento.
// Con TRANSLATE_LLM_PROVIDER = "groq" llama a Groq directo con GROQ_API_KEY.
async function translateText(env, lang, text, context) {
  const target = LANGUAGE_NAMES[lang] || lang;
  const viaGroq = env.TRANSLATE_LLM_PROVIDER === "groq";
  const routing = viaGroq
    ? { reasoning_effort: "low" }
    : {
        reasoning: { effort: "low" },
        provider: {
          only: (env.TRANSLATE_LLM_HOSTS || "groq,cerebras,sambanova").split(",").map((h) => h.trim()),
          sort: "latency",
        },
      };
  const resp = await fetch(viaGroq ? "https://api.groq.com/openai/v1/chat/completions" : "https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${viaGroq ? env.GROQ_API_KEY : env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: env.TRANSLATE_LLM_MODEL || "openai/gpt-oss-120b",
      ...routing,
      temperature: 0,
      messages: [
        {
          role: "system",
          content:
            `You translate live speech transcripts from a sports medicine congress into ${target} subtitles. ` +
            `The text may end mid-sentence: translate only what is there and never complete or add anything. ` +
            `Keep medical and technical terms precise. Output only the ${target} translation.` +
            (context ? `\nPrevious sentence, for context only (do not translate it): ${context}` : ""),
        },
        { role: "user", content: text },
      ],
    }),
  });
  if (!resp.ok) {
    const err = new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    err.status = resp.status;
    err.retryAfter = resp.headers.get("retry-after");
    throw err;
  }
  const data = await resp.json();
  return data.choices?.[0]?.message?.content?.trim() || "";
}

function rms(samples) {
  if (!samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i] / 32768;
    sum += s * s;
  }
  return Math.sqrt(sum / samples.length);
}

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

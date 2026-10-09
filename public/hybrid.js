// Traducción en vivo del modo hybrid: recibe la transcripción original por frases (item) y la va
// traduciendo mientras crece. Cada traducción nueva reemplaza a la anterior de esa frase en pantalla.
// Sin DOM: lo usan la página y el script de pruebas.

export class LiveTranslator {
  /**
   * @param {object} opts
   * @param {(text: string, context: string) => Promise<string>} opts.translate  lanza {status, retryAfter} en 429
   * @param {(item: string, text: string) => void} opts.onText  muestra/reemplaza la traducción de una frase
   * @param {number} [opts.minIntervalMs]  pausa mínima entre peticiones (límite por minuto del proveedor)
   * @param {number} [opts.minNewWords]  palabras nuevas necesarias para re-traducir una frase sin terminar
   */
  constructor({ translate, onText, minIntervalMs = 0, minNewWords = 3 }) {
    Object.assign(this, { translate, onText, minIntervalMs, minNewWords });
    this.phrases = new Map(); // item -> { source, version, shown, shownWords, final, context }
    this.lastFinal = '';
    this.busy = false;
    this.nextAt = 0;
    this.timer = null;
    // Calentamiento: la primera petición en frío (Worker + conexión al proveedor) tarda 4–9 s; se hace
    // ahora, antes de que el orador hable, y se repite tras 45 s sin traducir (pausas largas, preguntas).
    this.lastRequest = 0;
    this.ready = this.warmUp();
    this.keepWarm = setInterval(() => {
      if (!this.busy && Date.now() - this.lastRequest > 45000) this.warmUp();
    }, 15000);
  }

  warmUp() {
    this.busy = true;
    this.lastRequest = Date.now();
    return this.translate('Good morning.', '').catch(() => {}).finally(() => { this.busy = false; this.pump(); });
  }

  close() {
    clearInterval(this.keepWarm);
    clearTimeout(this.timer);
  }

  push(item, text, isFinal) {
    let p = this.phrases.get(item);
    if (!p) {
      p = { source: '', version: 0, shown: 0, shownWords: 0, final: false, context: this.lastFinal };
      this.phrases.set(item, p);
      if (this.phrases.size > 20) this.phrases.delete(this.phrases.keys().next().value);
    }
    p.source = isFinal ? text : p.source + text;
    p.final ||= isFinal;
    p.version++;
    if (isFinal) this.lastFinal = text;
    this.pump();
  }

  // Elige qué traducir: primero frases terminadas pendientes (texto definitivo), luego la frase en curso
  // si ganó suficientes palabras o llegó a una pausa (coma, punto).
  next() {
    for (const [item, p] of this.phrases) {
      if (p.final && p.version > p.shown && p.source.trim()) return [item, p];
    }
    const entries = [...this.phrases].reverse();
    for (const [item, p] of entries) {
      if (p.final || p.version === p.shown) continue;
      const words = p.source.trim().split(/\s+/).length;
      if (words - p.shownWords >= this.minNewWords || /[,.;:!?]\s*$/.test(p.source)) return [item, p];
    }
    return null;
  }

  pump() {
    if (this.busy || this.timer) return;
    const wait = this.nextAt - Date.now();
    if (wait > 0) {
      this.timer = setTimeout(() => { this.timer = null; this.pump(); }, wait);
      return;
    }
    const target = this.next();
    if (!target) return;
    this.run(...target);
  }

  async run(item, p) {
    this.busy = true;
    this.lastRequest = Date.now();
    const version = p.version;
    const source = p.source;
    this.nextAt = Date.now() + this.minIntervalMs;
    try {
      const text = await this.translate(source, p.context);
      if (text && version > p.shown) {
        p.shown = version;
        p.shownWords = source.trim().split(/\s+/).length;
        this.onText(item, text);
      }
    } catch (err) {
      // 429: esperar lo que pida el proveedor (o 2 s) antes de la próxima petición.
      if (err?.status === 429) this.nextAt = Date.now() + (Number(err.retryAfter) || 2) * 1000;
      else console.warn('Traducción fallida:', err);
    } finally {
      this.busy = false;
      this.pump();
    }
  }
}

// Separa la transcripción en oraciones a medida que llega, para traducir cada una apenas termina en vez de
// esperar el cierre de la frase (que con un orador sin pausas llega recién a los 12 s, MAX_SEGMENT_MS).
// Una oración se da por terminada cuando tras su punto ya llegó la palabra siguiente. Al cerrarse la frase,
// lo que falta del texto final se entrega como última oración; se alinea por palabras porque el texto final
// puede diferir levemente de los deltas.
export class SentenceSplitter {
  /**
   * @param {(id: string, text: string) => void} onSentence  recibe cada oración terminada (id único)
   * @param {number} [minWords]  oraciones más cortas se juntan con la siguiente ("Dr. Smith", "Yes.")
   */
  constructor(onSentence, minWords = 4) {
    Object.assign(this, { onSentence, minWords });
    this.items = new Map(); // item -> { text, cut, words, n }
  }

  delta(item, text) {
    let s = this.items.get(item);
    if (!s) this.items.set(item, (s = { text: '', cut: 0, words: 0, n: 0 }));
    s.text += text;
    for (const m of s.text.slice(s.cut).matchAll(/[.?!]["')\]]*\s+(?=\S)/g)) {
      const sentence = s.text.slice(s.cut, s.cut + m.index + m[0].length).trim();
      const words = sentence.split(/\s+/).length;
      if (words < this.minWords) continue;
      this.onSentence(`${item}#${s.n++}`, sentence);
      s.cut += m.index + m[0].length;
      s.words += words;
      this.delta(item, ''); // seguir buscando en el resto con el nuevo corte
      return;
    }
  }

  final(item, text) {
    const s = this.items.get(item);
    this.items.delete(item);
    const rest = text.trim().split(/\s+/).slice(s?.words || 0).join(' ');
    if (rest) this.onSentence(`${item}#f`, rest);
  }
}

// Cliente HTTP del endpoint del Worker.
export function workerTranslate(baseUrl, token) {
  return async (text, context) => {
    const qs = token ? `?token=${encodeURIComponent(token)}` : '';
    const resp = await fetch(`${baseUrl}/api/translate${qs}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, context }),
    });
    if (!resp.ok) throw { status: resp.status, retryAfter: resp.headers.get('retry-after'), message: await resp.text() };
    return (await resp.json()).text;
  };
}

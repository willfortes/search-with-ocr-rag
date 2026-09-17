/**
 * Embeddings via Ollama para RAG / busca híbrida no Meilisearch.
 */

import { OLLAMA_URL, OLLAMA_MODEL, checkOllama } from './ollama.js';

const EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text';
const PREFERRED_EMBED = [
  EMBED_MODEL,
  'nomic-embed-text',
  'nomic-embed-text:latest',
  'mxbai-embed-large',
  'all-minilm',
  'bge-m3',
];

let cachedEmbedModel = null;
let embedCheckedAt = 0;

function pickEmbedModel(models) {
  for (const preferred of PREFERRED_EMBED) {
    if (models.includes(preferred)) return preferred;
    const base = preferred.split(':')[0];
    const hit = models.find((m) => m === base || m.startsWith(`${base}:`));
    if (hit) return hit;
  }
  // qualquer modelo com "embed" no nome
  return models.find((m) => /embed/i.test(m)) || null;
}

export async function resolveEmbedModel() {
  const now = Date.now();
  if (cachedEmbedModel && now - embedCheckedAt < 60_000) {
    return cachedEmbedModel;
  }
  const ollama = await checkOllama();
  if (!ollama.ok) {
    cachedEmbedModel = null;
    embedCheckedAt = now;
    return null;
  }
  cachedEmbedModel = pickEmbedModel(ollama.models || []);
  embedCheckedAt = now;
  return cachedEmbedModel;
}

export async function embedText(text, model) {
  const input = String(text || '').trim().slice(0, 4000);
  if (!input) return null;

  const resolved = model || (await resolveEmbedModel());
  if (!resolved) return null;

  const res = await fetch(`${OLLAMA_URL}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: resolved, prompt: input }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Embedding falhou (${res.status}): ${errText.slice(0, 200)}`);
  }

  const data = await res.json();
  const vector = data.embedding || data.embeddings?.[0];
  if (!Array.isArray(vector) || !vector.length) return null;
  return vector;
}

/** Texto único para RAG: produto + tags + OCR. */
export function buildRagText({ product = '', folder = '', file = '', tags = [], ocrText = '' } = {}) {
  const parts = [
    product,
    folder,
    file?.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' '),
    ...(tags || []),
    ocrText,
  ]
    .map((p) => String(p || '').trim())
    .filter(Boolean);

  // dedupe case-insensitive
  const seen = new Set();
  const unique = [];
  for (const p of parts) {
    const key = p.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(p);
  }
  return unique.join(' · ').slice(0, 3500);
}

export async function checkEmbeddings() {
  try {
    const model = await resolveEmbedModel();
    if (!model) {
      return {
        ok: false,
        model: null,
        hint: `Instale um modelo de embedding: ollama pull ${EMBED_MODEL}`,
      };
    }
    const probe = await embedText('cerveja brahma supermercado', model);
    return {
      ok: Boolean(probe?.length),
      model,
      dimensions: probe?.length || 0,
    };
  } catch (err) {
    return { ok: false, model: null, error: err.message };
  }
}

/**
 * Expansão de query estilo RAG (quando não há modelo de embedding).
 * Usa o LLM local para sugerir marcas/sinônimos de supermercado.
 */
export async function expandSearchQuery(query, model = OLLAMA_MODEL) {
  const q = String(query || '').trim();
  if (!q || q.length < 2) return q;

  const ollama = await checkOllama();
  if (!ollama.ok) return q;

  const prompt = `Você ajuda um banco de imagens de produtos de supermercado.
Dado o termo de busca, liste até 8 palavras/marcas relacionadas que ajudam a achar o produto (sinônimos, categoria, marcas comuns no BR).
Responda APENAS palavras separadas por espaço, sem pontuação, sem explicação.

Termo: ${q}
Palavras:`;

  try {
    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model || ollama.selected || OLLAMA_MODEL,
        prompt,
        stream: false,
        options: { temperature: 0.2, num_predict: 48 },
      }),
    });
    if (!res.ok) return q;
    const data = await res.json();
    const extra = String(data.response || '')
      .split('\n')[0]
      .replace(/[^a-zA-ZÀ-ú0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!extra) return q;
    // junta termo original + expansão, sem duplicar
    const parts = `${q} ${extra}`.split(/\s+/);
    const seen = new Set();
    const out = [];
    for (const p of parts) {
      const k = p.toLowerCase();
      if (seen.has(k) || k.length < 2) continue;
      seen.add(k);
      out.push(p);
    }
    return out.slice(0, 12).join(' ');
  } catch {
    return q;
  }
}

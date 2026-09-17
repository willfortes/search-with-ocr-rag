const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:3b';

/** Preferência para pré-selecionar no UI (primeiro que existir). */
const PREFERRED_MODELS = [
  'qwen2.5:3b',
  'qwen2.5:1.5b',
  'llama3.2:3b',
  'llama3.2:1b',
  'llama3.2',
  'qwen2.5',
  'phi3',
  'gemma2:2b',
];

const SYSTEM_PROMPT = `Você é especialista em busca de imagens de produtos para encartes de supermercado.
Sua missão: transformar o nome do produto em UM termo de busca que encontre packshot oficial em alta resolução.

Regras:
- Retorne APENAS o termo de busca, sem aspas, sem explicação, sem markdown.
- Inclua marca, produto, embalagem/tamanho quando existir no nome.
- Acrescente palavras que ajudam qualidade: packshot, product photo, high resolution, png, transparent background, fundo branco.
- Prefira português + inglês no mesmo termo ( marcas BR + termos técnicos EN ).
- Evite palavras genéricas demais (oferta, barato, promoção).
- Máximo 16 palavras.`;

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return null;
  const gb = bytes / (1024 ** 3);
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / (1024 ** 2);
  return `${mb.toFixed(0)} MB`;
}

function pickDefaultModel(modelNames) {
  if (!modelNames.length) return null;
  if (modelNames.includes(OLLAMA_MODEL)) return OLLAMA_MODEL;

  for (const preferred of PREFERRED_MODELS) {
    if (modelNames.includes(preferred)) return preferred;
  }

  for (const preferred of PREFERRED_MODELS) {
    const base = preferred.split(':')[0];
    const hit = modelNames.find((name) => name === base || name.startsWith(`${base}:`));
    if (hit) return hit;
  }

  return modelNames[0];
}

export async function checkOllama() {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`);
    if (!res.ok) return { ok: false, error: `Ollama respondeu ${res.status}`, models: [], modelsDetail: [] };
    const data = await res.json();
    const modelsDetail = (data.models || [])
      .map((m) => ({
        name: m.name,
        size: m.size || 0,
        sizeLabel: formatBytes(m.size),
        modifiedAt: m.modified_at || m.modifiedAt || null,
        family: m.details?.family || null,
        parameterSize: m.details?.parameter_size || null,
        quantization: m.details?.quantization_level || null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));

    const models = modelsDetail.map((m) => m.name);
    const selected = pickDefaultModel(models);

    return {
      ok: true,
      models,
      modelsDetail,
      selected,
      url: OLLAMA_URL,
      model: OLLAMA_MODEL,
    };
  } catch (err) {
    return {
      ok: false,
      models: [],
      modelsDetail: [],
      selected: null,
      error: 'Ollama não está rodando. Instale em https://ollama.com e rode: ollama pull qwen2.5:3b',
      detail: err.message,
    };
  }
}

export async function generateSearchTerm(productName, model = OLLAMA_MODEL) {
  const prompt = `${SYSTEM_PROMPT}\n\nProduto: ${productName.trim()}\nTermo de busca:`;

  const res = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt,
      stream: false,
      options: { temperature: 0.3, num_predict: 64 },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Ollama falhou (${res.status}): ${text}`);
  }

  const data = await res.json();
  let term = (data.response || '')
    .split('\n')[0]
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/^\s*termo de busca:\s*/i, '')
    .trim();

  if (!term) {
    term = fallbackTerm(productName);
  }

  return term;
}

export function fallbackTerm(productName) {
  return `${productName.trim()} packshot product photo high resolution png transparent`;
}

export { OLLAMA_MODEL, OLLAMA_URL };

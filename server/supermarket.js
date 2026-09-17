/**
 * Valida se o termo é produto de supermercado (evita "caminhão", celebridades, etc.).
 */

import { checkOllama, OLLAMA_MODEL, OLLAMA_URL } from './ollama.js';

const DENY_EXACT = new Set([
  'caminhao',
  'caminhão',
  'truck',
  'carro',
  'car',
  'moto',
  'motorcycle',
  'aviao',
  'avião',
  'airplane',
  'onibus',
  'ônibus',
  'pessoa',
  'homem',
  'mulher',
  'crianca',
  'criança',
  'bebe',
  'bebê',
  'celebridade',
  'ator',
  'atriz',
  'cantor',
  'casa',
  'apartamento',
  'predio',
  'prédio',
  'arma',
  'pistola',
  'fuzil',
  'drogas',
  'maconha',
  'cocaina',
  'cocaína',
  'bitcoin',
  'criptomoeda',
  'software',
  'aplicativo',
  'iphone',
  'notebook',
  'laptop',
  'playstation',
  'xbox',
]);

const DENY_CONTAINS = [
  'caminhao',
  'truck',
  'ferrari',
  'lamborghini',
  'helicoptero',
  'helicóptero',
  'fuzil',
  'metralhadora',
  'porno',
  'pornô',
  'xxx',
];

/** Sinais positivos de mercearia / hipermercado */
const ALLOW_HINTS = [
  'cerveja',
  'refrigerante',
  'suco',
  'agua',
  'água',
  'leite',
  'queijo',
  'iogurte',
  'arroz',
  'feijao',
  'feijão',
  'macarrao',
  'macarrão',
  'acucar',
  'açúcar',
  'cafe',
  'café',
  'oleo',
  'óleo',
  'sal',
  'farinha',
  'pao',
  'pão',
  'bolo',
  'biscoito',
  'chocolate',
  'sabao',
  'sabão',
  'detergente',
  'amaciante',
  'desinfetante',
  'papel higienico',
  'papel higiênico',
  'shampoo',
  'condicionador',
  'creme dental',
  'fralda',
  'racao',
  'ração',
  'carne',
  'frango',
  'peixe',
  'presunto',
  'salsicha',
  'linguiça',
  'linguica',
  'ovo',
  'ovos',
  'manteiga',
  'margarina',
  'molho',
  'catchup',
  'maionese',
  'mostarda',
  'vinagre',
  'azeite',
  'lata',
  'pacote',
  'kg',
  'ml',
  'g ',
  'packshot',
  'omo',
  'brahma',
  'heineken',
  'skol',
  'coca',
  'pepsi',
  'nestle',
  'nestlé',
  'sadia',
  'perdigao',
  'perdigão',
  'camil',
  'ype',
  'ypê',
];

function normalize(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hardReject(query) {
  const n = normalize(query);
  if (!n || n.length < 2) {
    return { ok: false, reason: 'empty', message: 'Informe o nome do produto.' };
  }
  if (DENY_EXACT.has(n)) {
    return {
      ok: false,
      reason: 'not_supermarket',
      message: `"${query}" não é um produto de supermercado.`,
    };
  }
  for (const bad of DENY_CONTAINS) {
    if (n.includes(normalize(bad))) {
      return {
        ok: false,
        reason: 'not_supermarket',
        message: `"${query}" não parece produto de supermercado.`,
      };
    }
  }
  return null;
}

function hasAllowHint(query) {
  const n = normalize(query);
  return ALLOW_HINTS.some((hint) => n.includes(normalize(hint)));
}

async function validateWithOllama(query, model = OLLAMA_MODEL) {
  const prompt = `Você valida nomes de produtos para um banco de imagens de ENCARTE DE SUPERMERCADO no Brasil.

Aceite APENAS itens típicos de gondola: alimentos, bebidas, limpeza, higiene, pet food, hortifruti, padaria, frios, mercearia, descartáveis de cozinha.
Rejeite: veículos (caminhão, carro, moto), pessoas, celebridades, imóveis, armas, drogas ilícitas, eletrônicos/games (exceto pilhas/baterias de mercado), serviços, software.

Produto: "${query.trim()}"

Responda SOMENTE JSON válido, sem markdown:
{"ok":true,"category":"bebidas"}
ou
{"ok":false,"reason":"nao e produto de supermercado"}`;

  const res = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt,
      stream: false,
      options: { temperature: 0.1, num_predict: 80 },
    }),
  });

  if (!res.ok) {
    throw new Error(`Ollama validação falhou (${res.status})`);
  }

  const data = await res.json();
  const raw = String(data.response || '').trim();
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('Resposta de validação inválida');
  }
  const parsed = JSON.parse(jsonMatch[0]);
  return {
    ok: Boolean(parsed.ok),
    reason: parsed.ok ? 'ollama_ok' : parsed.reason || 'not_supermarket',
    category: parsed.category || null,
    message: parsed.ok
      ? null
      : `"${query}" não parece produto de supermercado.`,
  };
}

/**
 * @returns {{ ok: boolean, reason: string, message?: string, category?: string|null, source: string }}
 */
export async function validateSupermarketProduct(query, { model, useAi = true } = {}) {
  const denied = hardReject(query);
  if (denied) {
    return { ...denied, category: null, source: 'denylist' };
  }

  if (hasAllowHint(query)) {
    return {
      ok: true,
      reason: 'allow_hint',
      category: null,
      source: 'hints',
    };
  }

  if (useAi) {
    const ollama = await checkOllama();
    if (ollama.ok) {
      try {
        const ai = await validateWithOllama(query, model || ollama.selected || OLLAMA_MODEL);
        return { ...ai, source: 'ollama' };
      } catch {
        // cai no fallback conservador
      }
    }
  }

  // Sem IA e sem dica clara: rejeita (evita “caminhão” e lixo genérico)
  return {
    ok: false,
    reason: 'not_supermarket',
    message:
      `"${query}" não foi reconhecido como produto de supermercado. Use nomes como "Cerveja Brahma", "Arroz Tio João", "Sabão Omo".`,
    category: null,
    source: 'conservative',
  };
}

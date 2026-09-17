import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { runOcrOnFile } from './bank.js';
import { fallbackTerm, OLLAMA_MODEL } from './ollama.js';
import { findProductImages } from './search.js';
import { sanitizeFolderName, displayProductName } from './download.js';

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';

/**
 * Extrai texto da embalagem (OCR) e monta termo de busca para o Bing.
 * Busca visual “de verdade” na web costuma bloquear upload; OCR em packshot funciona bem.
 */
export async function buildSearchFromImage({
  buffer,
  originalName = 'upload.png',
  productHint = '',
  useAi = true,
  model = OLLAMA_MODEL,
}) {
  const tmp = path.join(os.tmpdir(), `pis-ocr-${Date.now()}-${path.basename(originalName)}`);
  await fs.writeFile(tmp, buffer);

  let ocrText = '';
  try {
    ocrText = await runOcrOnFile(tmp);
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }

  const hint = String(productHint || '').trim();
  const cleanedOcr = cleanOcrText(ocrText);

  let searchTerm;
  let source = 'ocr';
  let productName = hint || guessProductFromOcr(cleanedOcr) || 'produto_imagem';

  if (useAi) {
    try {
      searchTerm = await refineImageQueryWithAi({
        ocrText: cleanedOcr,
        productHint: hint || productName,
        model,
      });
      source = cleanedOcr ? 'ocr+ollama' : 'ollama';
    } catch {
      searchTerm = buildFallbackImageQuery(cleanedOcr, hint || productName);
      source = cleanedOcr ? 'ocr' : 'fallback';
    }
  } else {
    searchTerm = buildFallbackImageQuery(cleanedOcr, hint || productName);
  }

  if (!searchTerm?.trim()) {
    searchTerm = fallbackTerm(productName);
    source = 'fallback';
  }

  return {
    product: displayProductName(sanitizeFolderName(productName)),
    folder: sanitizeFolderName(productName),
    searchTerm: searchTerm.trim(),
    ocrText: cleanedOcr,
    source,
  };
}

export async function findCandidatesFromImage(options) {
  const built = await buildSearchFromImage(options);
  const maxResults = options.maxResults || 24;
  const candidates = await findProductImages(built.searchTerm, { maxResults });
  return { ...built, candidates };
}

function cleanOcrText(text) {
  return String(text || '')
    .replace(/[^\p{L}\p{N}\s.%xXmlML]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 280);
}

function guessProductFromOcr(ocrText) {
  if (!ocrText) return '';
  // pega as primeiras palavras “úteis”
  const words = ocrText
    .split(/\s+/)
    .filter((w) => w.length >= 3)
    .slice(0, 6);
  return words.join(' ').slice(0, 80);
}

function buildFallbackImageQuery(ocrText, hint) {
  const base = [hint, ocrText].filter(Boolean).join(' ').trim();
  if (!base) return fallbackTerm('produto');
  return `${base} packshot product photo high resolution png transparent`.slice(0, 180);
}

async function refineImageQueryWithAi({ ocrText, productHint, model }) {
  const prompt = `Você monta UM termo de busca para achar a foto oficial (packshot) de um produto de supermercado.

Texto lido da embalagem (OCR): ${ocrText || '(vazio)'}
Dica do usuário: ${productHint || '(nenhuma)'}

Regras:
- Retorne APENAS o termo de busca, sem aspas e sem explicação.
- Inclua marca e produto se aparecerem no OCR.
- Acrescente: packshot product photo high resolution png transparent
- Máximo 18 palavras.`;

  const res = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt,
      stream: false,
      options: { temperature: 0.2, num_predict: 64 },
    }),
  });

  if (!res.ok) throw new Error(`Ollama ${res.status}`);
  const data = await res.json();
  const term = String(data.response || '')
    .split('\n')[0]
    .replace(/^["'`]+|["'`]+$/g, '')
    .trim();
  if (!term) throw new Error('termo vazio');
  return term;
}

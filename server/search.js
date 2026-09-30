import {
  looksLikeWatermarkSource,
  watermarkExcludeQuerySuffix,
} from './watermark.js';
import { looksLikeJunkStock } from './relevance.js';
import { passesUrlRelevanceGate, detectDepartment } from './departments.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

async function fetchText(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
      },
      redirect: 'follow',
    });
    const text = await res.text();
    return { status: res.status, text, contentType: res.headers.get('content-type') || '' };
  } finally {
    clearTimeout(timer);
  }
}

function decodeBingUrl(raw) {
  return raw
    .replace(/\\u0026/g, '&')
    .replace(/\\u002f/g, '/')
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&')
    .replace(/\\"/g, '"');
}

function extractFromBingHtml(html) {
  const results = [];
  const seen = new Set();

  // Formato comum no endpoint async do Bing
  const patterns = [
    /murl&quot;:&quot;(https?:\/\/[^&]+?)&quot;/gi,
    /"murl"\s*:\s*"(https?:\\\/\\\/[^"]+?)"/gi,
    /"murl"\s*:\s*"(https?:\/\/[^"]+?)"/gi,
    /mediaurl=([^&"]+)/gi,
  ];

  for (const re of patterns) {
    for (const match of html.matchAll(re)) {
      let url = decodeURIComponent(decodeBingUrl(match[1]));
      url = url.replace(/\\u0026/g, '&').replace(/\\\//g, '/');
      if (!/^https?:\/\//i.test(url)) continue;
      if (seen.has(url)) continue;
      seen.add(url);
      results.push({
        title: '',
        url,
        thumbnail: '',
        width: 0,
        height: 0,
        source: 'bing',
      });
    }
  }

  // Tamanhos quando disponíveis: t1w / t1h próximos
  const sized = [...html.matchAll(/t1w&quot;:(\d+).*?t1h&quot;:(\d+).*?murl&quot;:&quot;(https?:\/\/[^&]+?)&quot;/gis)];
  for (const match of sized) {
    const url = decodeURIComponent(decodeBingUrl(match[3]));
    const width = Number(match[1]) || 0;
    const height = Number(match[2]) || 0;
    const existing = results.find((r) => r.url === url);
    if (existing) {
      existing.width = width;
      existing.height = height;
    }
  }

  return results;
}

/**
 * Busca imagens públicas via Bing Images (sem API key).
 * Substitui DuckDuckGo, que passou a retornar 403.
 */
export async function findProductImages(query, { maxResults = 12 } = {}) {
  const cleanQuery = `${String(query || '').trim()} ${watermarkExcludeQuerySuffix()}`.trim();
  const attempts = [
    `https://www.bing.com/images/async?q=${encodeURIComponent(cleanQuery)}&first=0&count=35&qft=+filterui:imagesize-large+filterui:photo-transparent`,
    `https://www.bing.com/images/async?q=${encodeURIComponent(cleanQuery)}&first=0&count=35&qft=+filterui:imagesize-large`,
    `https://www.bing.com/images/search?q=${encodeURIComponent(cleanQuery)}&qft=+filterui:imagesize-large&form=IRFLTR`,
  ];

  let all = [];
  const errors = [];

  for (const url of attempts) {
    try {
      const { status, text } = await fetchText(url);
      if (status >= 400) {
        errors.push(`${status} em ${url}`);
        continue;
      }
      const found = extractFromBingHtml(text);
      all = [...all, ...found];
      if (all.length >= maxResults) break;
    } catch (err) {
      errors.push(err.message);
    }
  }

  const seen = new Set();
  const unique = [];
  for (const item of all) {
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    unique.push({
      index: unique.length,
      title: item.title || '',
      url: item.url,
      thumbnail: item.thumbnail || '',
      width: item.width || 0,
      height: item.height || 0,
      source: item.source || 'bing',
    });
    if (unique.length >= maxResults) break;
  }

  if (!unique.length) {
    const detail = errors.slice(0, 3).join(' | ') || 'sem candidatos no HTML';
    throw new Error(`Nenhuma imagem encontrada no Bing (${detail})`);
  }

  return unique;
}

/** Pontua candidatos: resolução + relevância ao produto/departamento. */
export function scoreCandidate(item, query = '') {
  const area = (item.width || 0) * (item.height || 0);
  const url = (item.url || '').toLowerCase();
  const title = (item.title || '').toLowerCase();
  const blob = `${url} ${title}`;
  let score = area;

  const wm = looksLikeWatermarkSource(item.url || '', item.title || '');
  if (wm.watermarked) score -= 5_000_000;

  if (looksLikeJunkStock(url) || looksLikeJunkStock(title)) score -= 10_000_000;

  if (query) {
    const gate = passesUrlRelevanceGate(blob, query);
    if (!gate.ok) score -= 12_000_000;
    else if (gate.reason === 'query') score += 900_000;
    else if (gate.reason === 'department') score += 450_000;
  }

  if (url.includes('.png')) score += 500_000;
  if (url.includes('transparent') || url.includes('pngwing') || url.includes('cleanpng')) score += 200_000;
  if (url.includes('.webp')) score += 50_000;
  if (url.includes('.gif')) score -= 300_000;
  if (url.includes('sprite') || url.includes('icon') || url.includes('logo')) score -= 400_000;
  if (/mockup|dieline|diagram|infographic|kraft|packaging-types|tipos-de-embalagem|blank.?pouch|empty.?pouch|paper.?bag/.test(blob)) {
    score -= 8_000_000;
  }

  const dept = query ? detectDepartment(query) : null;
  if (dept?.id === 'limpeza' && /detergente|limpol|omo|ype|yp[eê]|ariel|frasco|bottle/.test(blob)) {
    score += 400_000;
  }
  if (dept?.id === 'carnes' && /carne|maminha|picanha|alcatra|vacuo|bovina|meat|beef|acougue/.test(blob)) {
    score += 600_000;
  }
  if ((dept?.id === 'refrigerantes' || dept?.id === 'bebidas') && /lata|garrafa|refrigerante|suco/.test(blob)) {
    score += 350_000;
  }
  if (dept?.id === 'bebidas_alcoolicas' && /cerveja|vinho|garrafa|lata/.test(blob)) {
    score += 350_000;
  }

  if (item.width >= 800 && item.height >= 800) score += 300_000;
  if (item.width >= 1500 || item.height >= 1500) score += 500_000;

  return score;
}

export function rankCandidates(candidates, query = '') {
  return [...candidates]
    .filter((c) => {
      if (looksLikeWatermarkSource(c.url || '', c.title || '').watermarked) return false;
      if (looksLikeJunkStock(c.url || '') || looksLikeJunkStock(c.title || '')) return false;
      if (query) {
        const gate = passesUrlRelevanceGate(`${c.url || ''} ${c.title || ''}`, query);
        // no_signal é CDN sem o nome no link (Shopify, Cloudinary). A busca já foi do produto.
        // junk e conflict continuam de fora.
        if (!gate.ok && gate.reason !== 'no_signal') return false;
      }
      return true;
    })
    .sort((a, b) => scoreCandidate(b, query) - scoreCandidate(a, query));
}

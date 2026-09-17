/**
 * Detecção e exclusão de imagens com marca d'água (stock / preview).
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import sharp from 'sharp';
import { createWorker } from 'tesseract.js';

/** Domínios / trechos de URL típicos de stock com watermark */
const WATERMARK_URL_HINTS = [
  'shutterstock',
  'gettyimages',
  'gettyimages.',
  'istockphoto',
  'istock.',
  'depositphotos',
  'dreamstime',
  'alamy',
  '123rf',
  'fotolia',
  'adobe.stock',
  'stock.adobe',
  'pond5',
  'canstockphoto',
  'vectorstock',
  'bigstock',
  'rawpixel.com/image',
  'watermark',
  'preview-image',
  'stock-photo',
  'stockphoto',
  'stock-image',
];

/** Textos comuns lidos por OCR em marcas d'água */
const WATERMARK_OCR_PHRASES = [
  'shutterstock',
  'getty images',
  'gettyimages',
  'istock',
  'depositphotos',
  'dreamstime',
  'alamy',
  'adobe stock',
  '123rf',
  'fotolia',
  'pond5',
  'watermark',
  'marca dagua',
  'marca d agua',
  'sample image',
  'preview only',
  'only preview',
  'for preview',
  'baixou.com',
  'stock photo',
  'royalty free preview',
];

let wmOcrPromise;

async function getWmOcrWorker() {
  if (!wmOcrPromise) {
    wmOcrPromise = createWorker('eng');
  }
  return wmOcrPromise;
}

/** OCR rápido (1 ângulo) só para achar textos de stock. */
export async function quickOcrForWatermark(buffer) {
  const tmp = path.join(os.tmpdir(), `pis-wm-${Date.now()}.png`);
  try {
    await sharp(buffer, { failOn: 'none' })
      .resize({ width: 1200, withoutEnlargement: false })
      .grayscale()
      .normalize()
      .png()
      .toFile(tmp);
    const worker = await getWmOcrWorker();
    const result = await worker.recognize(tmp);
    return (result?.data?.text || '').replace(/\s+/g, ' ').trim();
  } catch {
    return '';
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
}

function normalize(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function looksLikeWatermarkSource(url = '', title = '') {
  const hay = normalize(`${url} ${title}`);
  for (const hint of WATERMARK_URL_HINTS) {
    if (hay.includes(normalize(hint))) {
      return { watermarked: true, reason: `fonte stock/watermark: ${hint}`, via: 'url' };
    }
  }
  return { watermarked: false };
}

export function ocrLooksLikeWatermark(ocrText = '') {
  const hay = normalize(ocrText);
  if (!hay || hay.length < 4) return { watermarked: false };
  for (const phrase of WATERMARK_OCR_PHRASES) {
    if (hay.includes(normalize(phrase))) {
      return { watermarked: true, reason: `OCR: "${phrase}"`, via: 'ocr' };
    }
  }
  // padrão "www.algo.com" repetido muitas vezes (watermark diagonal)
  const domains = hay.match(/\bwww\.[a-z0-9.-]+\.[a-z]{2,}\b/g) || [];
  if (domains.length >= 3) {
    return { watermarked: true, reason: 'OCR: domínio repetido (watermark)', via: 'ocr' };
  }
  return { watermarked: false };
}

/**
 * Heurística visual rápida: faixas semi-transparentes / texto diagonal
 * (amostra brilho em grade — watermarks stock costumam criar padrão periódico).
 */
export async function visualWatermarkScore(buffer) {
  try {
    const { data, info } = await sharp(buffer, { failOn: 'none' })
      .resize(64, 64, { fit: 'fill' })
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const w = info.width;
    const h = info.height;
    // variação ao longo de diagonais
    let diagSum = 0;
    let diagCount = 0;
    for (let i = 0; i < Math.min(w, h); i++) {
      diagSum += data[i * w + i];
      diagCount += 1;
    }
    const diagAvg = diagSum / Math.max(diagCount, 1);

    let otherSum = 0;
    let otherCount = 0;
    for (let y = 0; y < h; y += 4) {
      for (let x = 0; x < w; x += 4) {
        if (Math.abs(x - y) < 2) continue;
        otherSum += data[y * w + x];
        otherCount += 1;
      }
    }
    const otherAvg = otherSum / Math.max(otherCount, 1);
    const contrast = Math.abs(diagAvg - otherAvg);

    // contraste diagonal moderado + imagem "lavada" pode indicar overlay
    // score alto = mais suspeito; threshold conservador (só sozinho não rejeita)
    return { score: contrast, diagAvg, otherAvg };
  } catch {
    return { score: 0 };
  }
}

/**
 * Análise completa do buffer (URL já filtrada antes).
 */
export async function detectWatermark(buffer, opts = {}) {
  const urlCheck = looksLikeWatermarkSource(opts.url || '', opts.title || '');
  if (urlCheck.watermarked) return urlCheck;

  let ocrText = opts.ocrText || '';
  if (!ocrText) {
    ocrText = await quickOcrForWatermark(buffer);
  }

  const ocrCheck = ocrLooksLikeWatermark(ocrText);
  if (ocrCheck.watermarked) return { ...ocrCheck, ocrText };

  const visual = await visualWatermarkScore(buffer);
  const hay = normalize(ocrText);

  // visual: watermarks diagonais costumam criar faixa cinza repetida
  if (visual.score >= 22 && hay.length > 20) {
    const stocky =
      hay.includes('www.') ||
      hay.includes('stock') ||
      hay.includes('photo') ||
      hay.includes('.com') ||
      /\b[a-z]{4,}\.[a-z]{2,}\b/.test(hay);
    if (stocky) {
      return {
        watermarked: true,
        reason: `padrão visual + OCR suspeito (score ${visual.score.toFixed(1)})`,
        via: 'visual+ocr',
        ocrText,
      };
    }
  }

  return { watermarked: false, ocrText };
}

/** Termos negativos para Bing */
export function watermarkExcludeQuerySuffix() {
  return '-shutterstock -gettyimages -istock -depositphotos -dreamstime -alamy -watermark -"stock photo"';
}

/**
 * Remove arquivo original + nobg correspondente (mesmo prefixo NN_).
 */
export async function deleteImagePair(folderAbs, fileName) {
  const base = path.basename(fileName);
  const stem = base.replace(/\.[^.]+$/, '');
  const prefixMatch = stem.match(/^(\d+)_/);
  const prefix = prefixMatch ? prefixMatch[1] : null;

  const removed = [];
  const tryUnlink = async (p) => {
    try {
      await fs.unlink(p);
      removed.push(p);
    } catch {
      /* ignore */
    }
  };

  await tryUnlink(path.join(folderAbs, 'original', base));
  await tryUnlink(path.join(folderAbs, 'nobg', base.replace(/\.[^.]+$/, '.png')));
  await tryUnlink(path.join(folderAbs, base));

  if (prefix) {
    for (const sub of ['original', 'nobg', '']) {
      const dir = sub ? path.join(folderAbs, sub) : folderAbs;
      try {
        const files = await fs.readdir(dir);
        for (const f of files) {
          if (f.startsWith(`${prefix}_`) || f.startsWith(`${prefix}.`)) {
            await tryUnlink(path.join(dir, f));
          }
        }
      } catch {
        /* ignore */
      }
    }
  }

  return removed;
}

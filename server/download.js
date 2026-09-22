import fs from 'fs/promises';
import path from 'path';
import sharp from 'sharp';
import {
  detectWatermark,
  deleteImagePair,
  ocrLooksLikeWatermark,
  looksLikeWatermarkSource,
} from './watermark.js';
import { rankCandidates } from './search.js';

const DOWNLOADS_ROOT = path.resolve(process.cwd(), 'downloads');

const NOISE_SUFFIXES = [
  'test',
  'teste',
  'copy',
  'copia',
  'novo',
  'new',
  'temp',
  'tmp',
  'bak',
  'old',
  'final',
  'v2',
  'v3',
];

/**
 * Chave canônica para SEMPRE mesclar produtos iguais.
 * Ex.: "Brahma", "brahma_test", "BRAHMA Teste" → "brahma"
 */
export function canonicalProductKey(name) {
  let key = String(name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');

  let changed = true;
  while (changed && key) {
    changed = false;
    for (const suffix of NOISE_SUFFIXES) {
      const re = new RegExp(`_${suffix}$`, 'i');
      if (re.test(key)) {
        key = key.replace(re, '');
        changed = true;
      }
    }
  }

  key = key.replace(/_+/g, '_').replace(/^_|_$/g, '');
  return key.slice(0, 80) || 'produto';
}

/** Alias usado em todo o app — pastas sempre canônicas. */
export function sanitizeFolderName(name) {
  return canonicalProductKey(name);
}

export function displayProductName(folderOrName) {
  return String(folderOrName || '')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function guessExt(url, contentType) {
  if (contentType?.includes('png')) return '.png';
  if (contentType?.includes('webp')) return '.webp';
  if (contentType?.includes('jpeg') || contentType?.includes('jpg')) return '.jpg';
  const m = url.toLowerCase().match(/\.(png|jpe?g|webp|gif)(\?|$)/);
  return m ? `.${m[1].replace('jpeg', 'jpg')}` : '.jpg';
}

async function fetchImageBuffer(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        Referer: 'https://www.bing.com/',
      },
      redirect: 'follow',
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const contentType = res.headers.get('content-type') || '';
    if (contentType && !contentType.startsWith('image/') && !contentType.includes('octet-stream')) {
      throw new Error(`Não é imagem: ${contentType}`);
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length < 2048) throw new Error('Arquivo muito pequeno');

    return { buffer, contentType, byteLength: buffer.length };
  } finally {
    clearTimeout(timer);
  }
}

async function inspectImage(buffer) {
  const meta = await sharp(buffer, { failOn: 'none' }).metadata();
  const width = meta.width || 0;
  const height = meta.height || 0;
  return {
    width,
    height,
    format: meta.format,
    hasAlpha: Boolean(meta.hasAlpha),
    area: width * height,
  };
}

async function nextImageIndex(originalDir) {
  try {
    const files = await fs.readdir(originalDir);
    let max = 0;
    for (const file of files) {
      const m = file.match(/^(\d+)_/);
      if (m) max = Math.max(max, Number(m[1]));
    }
    return max + 1;
  } catch {
    return 1;
  }
}

async function moveFileSafe(from, toDir, fileName) {
  await fs.mkdir(toDir, { recursive: true });
  let dest = path.join(toDir, fileName);
  if (await exists(dest)) {
    const parsed = path.parse(fileName);
    dest = path.join(toDir, `${parsed.name}_m${Date.now()}${parsed.ext}`);
  }
  await fs.rename(from, dest);
  return path.basename(dest);
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function copyDirImages(srcDir, destDir) {
  if (!(await exists(srcDir))) return 0;
  await fs.mkdir(destDir, { recursive: true });
  const files = await fs.readdir(srcDir);
  let moved = 0;
  for (const file of files) {
    const from = path.join(srcDir, file);
    const st = await fs.stat(from);
    if (!st.isFile()) continue;
    if (!/\.(png|jpe?g|webp|gif)$/i.test(file)) continue;
    await moveFileSafe(from, destDir, file);
    moved += 1;
  }
  return moved;
}

/**
 * Une pastas duplicadas no disco (brahma + brahma_test → brahma).
 */
export async function mergeDuplicateProductFolders() {
  await fs.mkdir(DOWNLOADS_ROOT, { recursive: true });
  const entries = await fs.readdir(DOWNLOADS_ROOT, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);

  const groups = new Map();
  for (const dir of dirs) {
    const key = canonicalProductKey(dir);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(dir);
  }

  const merges = [];

  for (const [canonical, members] of groups) {
    if (members.length < 2 && members[0] === canonical) continue;

    const target = members.includes(canonical)
      ? canonical
      : members.sort((a, b) => a.length - b.length || a.localeCompare(b))[0];

    const targetPath = path.join(DOWNLOADS_ROOT, canonical);
    // Se o target escolhido não é o canônico, renomeia/cria canônico
    if (target !== canonical) {
      if (await exists(targetPath)) {
        // já existe canônico? então target vira canônico e funde o antigo "target"
      } else if (await exists(path.join(DOWNLOADS_ROOT, target))) {
        await fs.rename(path.join(DOWNLOADS_ROOT, target), targetPath);
      }
    }

    await fs.mkdir(path.join(targetPath, 'original'), { recursive: true });
    await fs.mkdir(path.join(targetPath, 'nobg'), { recursive: true });

    for (const member of members) {
      if (member === canonical) continue;
      const sourcePath = path.join(DOWNLOADS_ROOT, member);
      if (!(await exists(sourcePath))) continue;

      const movedOriginal = await copyDirImages(
        path.join(sourcePath, 'original'),
        path.join(targetPath, 'original')
      );
      const movedNobg = await copyDirImages(path.join(sourcePath, 'nobg'), path.join(targetPath, 'nobg'));
      // legado na raiz
      const rootFiles = await fs.readdir(sourcePath).catch(() => []);
      for (const file of rootFiles) {
        const full = path.join(sourcePath, file);
        const st = await fs.stat(full).catch(() => null);
        if (!st?.isFile()) continue;
        if (!/\.(png|jpe?g|webp|gif)$/i.test(file)) continue;
        await moveFileSafe(full, path.join(targetPath, 'original'), file);
      }

      await fs.rm(sourcePath, { recursive: true, force: true });
      merges.push({ from: member, to: canonical, movedOriginal, movedNobg });
    }

    // Se só havia um membro com nome não canônico, renomeia
    if (members.length === 1 && members[0] !== canonical) {
      const only = members[0];
      const onlyPath = path.join(DOWNLOADS_ROOT, only);
      if ((await exists(onlyPath)) && !(await exists(targetPath))) {
        await fs.rename(onlyPath, targetPath);
        merges.push({ from: only, to: canonical, renamed: true });
      } else if ((await exists(onlyPath)) && (await exists(targetPath)) && only !== canonical) {
        await copyDirImages(path.join(onlyPath, 'original'), path.join(targetPath, 'original'));
        await copyDirImages(path.join(onlyPath, 'nobg'), path.join(targetPath, 'nobg'));
        await fs.rm(onlyPath, { recursive: true, force: true });
        merges.push({ from: only, to: canonical });
      }
    }
  }

  return merges;
}

export async function deleteProductFolder(folderInput) {
  const folder = sanitizeFolderName(folderInput);
  const full = path.join(DOWNLOADS_ROOT, folder);
  if (!(await exists(full))) {
    // tenta achar por canônico / merge primeiro
    await mergeDuplicateProductFolders();
    if (!(await exists(full))) {
      const err = new Error('Produto não encontrado');
      err.status = 404;
      throw err;
    }
  }
  await fs.rm(full, { recursive: true, force: true });
  return { deleted: true, folder };
}

/**
 * Baixa imagens em downloads/<canônico>/original/ (append, não sobrescreve).
 */
export async function downloadBestImages({
  productName,
  candidates,
  perProduct = 10,
  minWidth = 400,
  onProgress,
}) {
  await mergeDuplicateProductFolders();
  await fs.mkdir(DOWNLOADS_ROOT, { recursive: true });

  const folderKey = sanitizeFolderName(productName);
  const folder = path.join(DOWNLOADS_ROOT, folderKey);
  const originalDir = path.join(folder, 'original');
  await fs.mkdir(originalDir, { recursive: true });
  await fs.mkdir(path.join(folder, 'nobg'), { recursive: true });

  const ranked = rankCandidates(candidates, productName);
  const saved = [];
  const errors = [];
  let attempt = 0;
  let nextIndex = await nextImageIndex(originalDir);

  for (const candidate of ranked) {
    if (saved.length >= perProduct) break;
    attempt += 1;
    onProgress?.({
      type: 'attempt',
      product: productName,
      folder: folderKey,
      attempt,
      url: candidate.url,
      saved: saved.length,
      target: perProduct,
    });

    try {
      if (looksLikeWatermarkSource(candidate.url || '', candidate.title || '').watermarked) {
        errors.push({ url: candidate.url, reason: 'Marca d\'água / stock (URL)' });
        continue;
      }

      const { buffer, contentType, byteLength } = await fetchImageBuffer(candidate.url);
      const info = await inspectImage(buffer);

      if (info.width < minWidth || info.height < minWidth) {
        errors.push({ url: candidate.url, reason: `Baixa resolução ${info.width}x${info.height}` });
        continue;
      }

      const wm = await detectWatermark(buffer, {
        url: candidate.url,
        title: candidate.title || '',
      });
      if (wm.watermarked) {
        errors.push({ url: candidate.url, reason: `Marca d'água: ${wm.reason}` });
        onProgress?.({
          type: 'rejected_watermark',
          product: productName,
          folder: folderKey,
          url: candidate.url,
          reason: wm.reason,
        });
        continue;
      }

      const ext = guessExt(candidate.url, contentType || `image/${info.format}`);
      const fileName = `${String(nextIndex).padStart(2, '0')}_${info.width}x${info.height}${ext}`;
      nextIndex += 1;
      const filePath = path.join(originalDir, fileName);
      await fs.writeFile(filePath, buffer);

      const item = {
        file: fileName,
        path: filePath,
        url: candidate.url,
        width: info.width,
        height: info.height,
        bytes: byteLength,
        hasAlpha: info.hasAlpha,
        publicUrl: `/downloads/${encodeURIComponent(folderKey)}/original/${encodeURIComponent(fileName)}`,
      };
      saved.push(item);

      onProgress?.({
        type: 'saved',
        product: productName,
        folder: folderKey,
        ...item,
        saved: saved.length,
        target: perProduct,
      });
    } catch (err) {
      errors.push({ url: candidate.url, reason: err.message });
    }

    await new Promise((r) => setTimeout(r, 400));
  }

  return { folder, folderKey, originalDir, saved, errors, attempted: attempt };
}

export async function listProducts() {
  await mergeDuplicateProductFolders();
  await fs.mkdir(DOWNLOADS_ROOT, { recursive: true });
  const entries = await fs.readdir(DOWNLOADS_ROOT, { withFileTypes: true });
  const products = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const detail = await getProductGallery(entry.name);
    if (detail) products.push(detail);
  }

  return products.sort((a, b) => a.product.localeCompare(b.product, 'pt-BR'));
}

export async function getProductGallery(folderNameInput) {
  await mergeDuplicateProductFolders();
  const folderName = sanitizeFolderName(folderNameInput);
  const folder = path.join(DOWNLOADS_ROOT, folderName);
  try {
    const stat = await fs.stat(folder);
    if (!stat.isDirectory()) return null;
  } catch {
    return null;
  }

  const originalDir = path.join(folder, 'original');
  const nobgDir = path.join(folder, 'nobg');

  const originals = await listImageFiles(originalDir, folderName, 'original');
  const cutouts = await listImageFiles(nobgDir, folderName, 'nobg');

  const rootFiles = await listImageFiles(folder, folderName, '');
  const legacy = rootFiles.filter((f) => !['original', 'nobg'].includes(f.file));

  return {
    product: displayProductName(folderName),
    folder: folderName,
    originals: originals.length ? originals : legacy,
    cutouts,
    counts: {
      originals: originals.length || legacy.length,
      cutouts: cutouts.length,
    },
  };
}

async function listImageFiles(dir, folderName, sub) {
  try {
    const files = await fs.readdir(dir);
    const images = [];
    for (const file of files) {
      if (!/\.(png|jpe?g|webp|gif)$/i.test(file)) continue;
      const full = path.join(dir, file);
      const st = await fs.stat(full);
      if (!st.isFile()) continue;
      let width = 0;
      let height = 0;
      try {
        const meta = await sharp(full, { failOn: 'none' }).metadata();
        width = meta.width || 0;
        height = meta.height || 0;
      } catch {
        // ignore
      }
      const rel = sub ? `${sub}/${file}` : file;
      images.push({
        file,
        width,
        height,
        bytes: st.size,
        url: `/downloads/${encodeURIComponent(folderName)}/${rel.split('/').map(encodeURIComponent).join('/')}`,
      });
    }
    return images.sort((a, b) => a.file.localeCompare(b.file, 'pt-BR'));
  } catch {
    return [];
  }
}

/**
 * Varre downloads e apaga imagens com marca d'água (OCR / heurística).
 */
export async function purgeWatermarkedImages({ folder = null, onProgress } = {}) {
  const products = await listProducts();
  const targets = folder
    ? products.filter((p) => p.folder === sanitizeFolderName(folder))
    : products;

  const removed = [];
  const kept = [];
  const errors = [];

  for (const product of targets) {
    const folderAbs = path.join(DOWNLOADS_ROOT, product.folder);

    for (const img of product.originals || []) {
      const sub = img.url.includes('/original/')
        ? 'original'
        : img.url.includes('/nobg/')
          ? 'nobg'
          : '';
      if (sub === 'nobg') continue;

      const abs = sub
        ? path.join(folderAbs, sub, img.file)
        : path.join(folderAbs, img.file);

      try {
        const buffer = await fs.readFile(abs);
        // sempre OCR focado em watermark (cache de produto ignora texto diagonal de stock)
        const wm = await detectWatermark(buffer, { ocrText: '' });
        onProgress?.({
          type: 'scan',
          folder: product.folder,
          file: img.file,
          watermarked: wm.watermarked,
          reason: wm.reason,
        });

        if (wm.watermarked) {
          const deleted = await deleteImagePair(folderAbs, img.file);
          removed.push({
            folder: product.folder,
            file: img.file,
            reason: wm.reason,
            deleted: deleted.length,
          });
        } else {
          kept.push({ folder: product.folder, file: img.file });
        }
      } catch (err) {
        errors.push({ folder: product.folder, file: img.file, reason: err.message });
      }
    }
  }

  return {
    scannedFolders: targets.length,
    removed: removed.length,
    kept: kept.length,
    details: removed,
    errors,
  };
}

export { DOWNLOADS_ROOT };

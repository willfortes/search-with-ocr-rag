/**
 * Resolve progressivo (SSE): emite status engraçados + imagens conforme ficam prontas.
 * Downloads paralelos via worker Go (fallback Node sequencial).
 */
import path from 'path';
import fs from 'fs/promises';
import sharp from 'sharp';
import {
  searchBank,
  checkBank,
  loadOcrCache,
} from './bank.js';
import {
  getProductGallery,
  sanitizeFolderName,
  displayProductName,
  downloadBestImages,
  mergeDuplicateProductFolders,
  DOWNLOADS_ROOT,
} from './download.js';
import { findProductImages, rankCandidates } from './search.js';
import { fallbackTerm } from './ollama.js';
import { validateSupermarketProduct } from './supermarket.js';
import {
  filterRelevantImages,
  supermarketSearchQuery,
  scoreProductRelevance,
  looksLikeJunkStock,
} from './relevance.js';
import { looksLikeWatermarkSource } from './watermark.js';
import { checkGoWorker, downloadParallelGo } from './go-downloader.js';

function publicBase(req) {
  if (process.env.PUBLIC_BASE_URL) {
    return process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
  }
  const host = req?.get?.('host');
  if (host) {
    const proto = req.get('x-forwarded-proto') || req.protocol || 'http';
    return `${proto}://${host}`;
  }
  return `http://127.0.0.1:${process.env.PORT || 3847}`;
}

function absoluteUrl(base, urlPath) {
  if (!urlPath) return null;
  if (/^https?:\/\//i.test(urlPath)) return urlPath;
  return `${base}${urlPath.startsWith('/') ? '' : '/'}${urlPath}`;
}

function mapHit(hit, base) {
  return {
    id: hit.id,
    product: hit.product,
    folder: hit.folder,
    folderLabel: hit.folderLabel || hit.folder,
    detectedProduct: hit.detectedProduct || null,
    mismatched: Boolean(hit.mismatched),
    file: hit.file,
    kind: hit.kind,
    url: absoluteUrl(base, hit.url),
    width: hit.width || 0,
    height: hit.height || 0,
    bytes: hit.bytes || 0,
    hasAlpha: Boolean(hit.hasAlpha),
    tags: hit.tags || [],
    ocrText: hit.ocrText || '',
  };
}

function sseWrite(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

const FUNNY_STATUSES = [
  'Espionando a gôndola do supermercado…',
  'Caçando packshot digno de encarte…',
  'Negociando com o Bing por fotos melhores…',
  'Separando suco de leite (foi mal, Italac)…',
  'Tirando a poeira das embalagens…',
  'Pedindo licença pro Go baixar em paralelo…',
  'Quase lá — ainda filtrando impostores…',
  'Montando o desfile de produtos…',
];

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export async function resolveProductImagesStream(req, res) {
  const body = { ...(req.query || {}), ...(req.body || {}) };
  const query = String(body.q || body.query || body.product || '').trim();
  const limit = Math.min(Math.max(Number(body.limit) || 10, 1), 10);
  const kind = body.kind === 'original' || body.kind === 'any' ? body.kind : 'original';
  const scrapeIfMissing = body.scrapeIfMissing !== false && body.scrape !== 'false';
  const base = publicBase(req);

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  let closed = false;
  req.on('close', () => {
    closed = true;
  });

  const emit = (event, data) => {
    if (closed) return;
    sseWrite(res, event, data);
    if (typeof res.flush === 'function') res.flush();
  };

  let statusIdx = 0;
  const statusTimer = setInterval(() => {
    if (closed) return;
    emit('status', {
      message: FUNNY_STATUSES[statusIdx % FUNNY_STATUSES.length],
      tick: statusIdx,
    });
    statusIdx += 1;
  }, 2800);

  const emittedIds = new Set();
  let emitted = 0;

  const emitImage = (img, source) => {
    if (!img?.url || emitted >= limit) return false;
    const id = img.id || img.url;
    if (emittedIds.has(id)) return false;
    emittedIds.add(id);
    emitted += 1;
    emit('image', {
      ...img,
      id,
      source,
      index: emitted,
      remainingHint: Math.max(0, limit - emitted),
    });
    emit('progress', { found: emitted, target: limit, hasMore: emitted < limit });
    return true;
  };

  try {
    if (!query) {
      emit('error', { error: 'Informe o nome do produto' });
      emit('done', { ok: false, total: 0 });
      return;
    }

    emit('status', { message: `Beleza, cacemos imagens de “${query}”…`, tick: 0 });

    const validation = await validateSupermarketProduct(query, { useAi: false });
    if (!validation.ok) {
      emit('error', {
        error: validation.message || 'Produto rejeitado',
        reason: validation.reason,
      });
      emit('done', { ok: false, total: 0 });
      return;
    }

    const folder = sanitizeFolderName(query);
    const productLabel = displayProductName(folder);
    emit('meta', { query, folder, product: productLabel, target: limit });

    // 1) Banco Meili — aceita hits mesmo sem OCR perfeito (mostra rápido)
    const bank = await checkBank();
    if (bank.ok) {
      emit('status', { message: 'Olhando o estoque local (banco)…', tick: statusIdx });
      try {
        const search = await searchBank(query, {
          limit: Math.min(limit * 3, 30),
          offset: 0,
          kind: kind === 'any' ? null : kind,
        });
        const mapped = search.hits.map((h) => mapHit(h, base));
        const relevant = filterRelevantImages(mapped, query, { allowWeakEmpty: false });
        for (const img of relevant) {
          if (closed || emitted >= limit) break;
          emitImage(img, 'bank');
        }
      } catch (err) {
        emit('status', { message: `Banco deu tilt (${err.message}) — partindo pro plano B…` });
      }
    }

    if (emitted >= limit) {
      emit('done', { ok: true, total: emitted, source: 'bank', hasMore: true });
      return;
    }

    // 2) Disco — NÃO espera OCR de tudo (isso travava a UI por minutos)
    emit('status', { message: 'Vasculhando o HD por embalagens esquecidas…' });
    const gallery = await getProductGallery(folder);
    if (gallery) {
      const ocrCache = await loadOcrCache(folder);
      const disk = await diskGalleryImages(gallery, {
        kind: kind === 'any' ? null : kind,
        base,
        ocrCache,
        query,
        limit: limit - emitted,
        allowWeakEmpty: false,
      });
      for (const img of disk) {
        if (closed || emitted >= limit) break;
        emitImage(img, 'disk');
      }
    }

    if (emitted >= limit || !scrapeIfMissing) {
      emit('done', {
        ok: emitted > 0,
        total: emitted,
        source: emitted ? 'disk' : 'empty',
        hasMore: scrapeIfMissing,
      });
      return;
    }

    // Já tem resultado útil no disco/banco → devolve agora (Buscar mais traz o resto)
    if (emitted >= Math.min(4, limit)) {
      emit('done', {
        ok: true,
        total: emitted,
        source: 'disk',
        hasMore: true,
      });
      return;
    }

    // 3) Scrape + download paralelo (Go) — emite assim que baixa (sem OCR bloqueante)
    emit('status', { message: 'Abrindo o Bing e recrutando o Go pra baixar em paralelo…' });
    let candidates = [];
    try {
      await mergeDuplicateProductFolders();
      const searchTerm = supermarketSearchQuery(productLabel, fallbackTerm(productLabel));
      candidates = await Promise.race([
        findProductImages(searchTerm, {
          maxResults: Math.min(Math.max(limit * 4, 20), 35),
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('timeout_bing')), 15000)
        ),
      ]);
    } catch (err) {
      emit('status', { message: `Busca externa lenta/falhou (${err.message}).` });
      emit('done', {
        ok: emitted > 0,
        total: emitted,
        source: emitted ? 'partial' : 'scrape_fail',
        hasMore: false,
        error: err.message,
      });
      return;
    }

    const ranked = rankCandidates(candidates).filter(
      (c) => !looksLikeWatermarkSource(c.url || '', c.title || '').watermarked
    );

    emit('status', {
      message: `Achei ${ranked.length} candidatas — baixando as melhores em paralelo…`,
    });

    const go = await checkGoWorker();
    const need = limit - emitted;
    const originalDir = path.join(DOWNLOADS_ROOT, folder, 'original');
    await fs.mkdir(originalDir, { recursive: true });

    if (go.ok && ranked.length) {
      emit('status', { message: 'Go no comando: downloads paralelos ligados ⚡' });
      const startIndex = (await nextIndex(originalDir)) || 1;
      const urls = ranked.slice(0, Math.max(need * 3, 12)).map((c) => c.url);

      try {
        await Promise.race([
          downloadParallelGo({
            urls,
            outDir: originalDir,
            concurrency: 8,
            startIndex,
            onItem: async (item) => {
              if (closed || emitted >= limit || !item?.ok) return;
              try {
                const finalized = await finalizeDownloadedFile({
                  absPath: item.path,
                  folder,
                  productLabel,
                  base,
                  query,
                  sourceUrl: item.url,
                  skipOcr: true,
                });
                if (finalized) emitImage(finalized, 'scrape');
              } catch (err) {
                console.warn('[stream] finalize failed', err.message);
              }
            },
          }),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('timeout_go_download')), 45000)
          ),
        ]);
      } catch (err) {
        emit('status', { message: `Download interrompido: ${err.message}` });
      }
    } else if (ranked.length) {
      emit('status', { message: 'Go offline — baixando no Node…' });
      try {
        await Promise.race([
          downloadBestImages({
            productName: productLabel,
            candidates: ranked,
            perProduct: Math.max(need, 6),
            minWidth: 400,
          }),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('timeout_node_download')), 45000)
          ),
        ]);
        const fresh = await getProductGallery(folder);
        if (fresh) {
          const ocrCache = await loadOcrCache(folder);
          const disk = await diskGalleryImages(fresh, {
            kind: 'original',
            base,
            ocrCache,
            query,
            limit: need,
            allowWeakEmpty: false,
          });
          for (const img of disk) {
            if (closed || emitted >= limit) break;
            emitImage(img, 'scrape');
          }
        }
      } catch (err) {
        emit('status', { message: `Download Node falhou: ${err.message}` });
      }
    }

    // NÃO roda OCR aqui — bloqueia o event loop do Node e congela outras buscas

    emit('done', {
      ok: emitted > 0,
      total: emitted,
      source: 'scrape',
      hasMore: emitted >= limit,
      goWorker: Boolean(go.ok),
    });
  } catch (err) {
    console.error('[resolve-stream]', err);
    emit('error', { error: err.message || 'Falha na busca' });
    emit('done', { ok: false, total: emitted });
  } finally {
    clearInterval(statusTimer);
    if (!closed) res.end();
  }
}

async function nextIndex(originalDir) {
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

async function finalizeDownloadedFile({
  absPath,
  folder,
  productLabel,
  base,
  query,
  sourceUrl,
  skipOcr = true,
}) {
  const meta = await sharp(absPath, { failOn: 'none' }).metadata();
  const width = meta.width || 0;
  const height = meta.height || 0;
  if (width < 400 || height < 400) {
    await fs.unlink(absPath).catch(() => {});
    return null;
  }

  // Cenas panorâmicas / corredor de loja costumam ser bem largas
  const ratio = width / Math.max(height, 1);
  if (ratio > 2.2 || ratio < 0.35) {
    await fs.unlink(absPath).catch(() => {});
    return null;
  }

  const ext = path.extname(absPath) || '.jpg';
  const baseName = path.basename(absPath, ext);
  const m = baseName.match(/^(\d+)/);
  const idx = m ? m[1] : String(Date.now()).slice(-4);
  const newName = `${idx}_${width}x${height}${ext}`;
  const newPath = path.join(path.dirname(absPath), newName);
  if (newPath !== absPath) {
    await fs.rename(absPath, newPath).catch(() => {});
  }
  const finalPath = await fs
    .access(newPath)
    .then(() => newPath)
    .catch(() => absPath);
  const file = path.basename(finalPath);

  if (looksLikeJunkStock(sourceUrl || '') || looksLikeJunkStock(file)) {
    await fs.unlink(finalPath).catch(() => {});
    return null;
  }

  // Sem OCR no caminho quente: a URL PRECISA citar o produto (evita garrafa genérica / shampoo / mockup)
  const qTokens = String(query || productLabel || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(
      (t) =>
        t.length >= 4 &&
        !['pack', 'packshot', 'produto', 'product', 'fundo', 'branco', 'frasco', 'garrafa', 'bottle'].includes(t)
    );
  const urlNorm = String(sourceUrl || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  const hasProductHint = qTokens.some((t) => urlNorm.includes(t));
  // Marcas conhecidas contam como match mesmo se a query for genérica ("detergente")
  const brandInUrl =
    /limpol|ype|yp[eê]|omo|ariel|vanish|cif|ajax|minuano|brilhante|urca|comfort|downy|surf|tide|persil/.test(
      urlNorm
    );
  if (qTokens.length && !hasProductHint && !brandInUrl) {
    await fs.unlink(finalPath).catch(() => {});
    return null;
  }
  // Se a URL parece mockup/diagrama/shampoo genérico sem o termo pedido, rejeita
  if (
    /mockup|dieline|diagram|infographic|kraft|paper.?bag|empty.?pouch|blank.?pouch|tipos.?de.?embalagem|packaging.?types|batata|potato|shampoo|vial|comprimido|pill.?bottle|crumpled|amassado/.test(
      urlNorm
   ) &&
    !hasProductHint
  ) {
    await fs.unlink(finalPath).catch(() => {});
    return null;
  }
  // Conflito clássico: busca detergente não pode trazer shampoo
  if (qTokens.includes('detergente') && /shampoo|condicionador|conditioner/.test(urlNorm) && !/detergente/.test(urlNorm)) {
    await fs.unlink(finalPath).catch(() => {});
    return null;
  }

  let ocrText = '';
  // OCR propositalmente fora do caminho quente (bloqueia o event loop)

  const st = await fs.stat(finalPath);
  return {
    id: `${folder}__original__${file}`.replace(/[^a-zA-Z0-9_-]/g, '_'),
    product: productLabel,
    folder,
    file,
    kind: 'original',
    url: absoluteUrl(base, `/downloads/${folder}/original/${file}`),
    width,
    height,
    bytes: st.size,
    hasAlpha: Boolean(meta.hasAlpha),
    tags: [],
    ocrText,
    sourceUrl,
  };
}

async function diskGalleryImages(
  gallery,
  { kind, base, ocrCache, query, limit, allowWeakEmpty = true }
) {
  const preferOriginal = kind === 'original';
  let list = [];
  if (preferOriginal) {
    list = (gallery.originals || []).map((img) => ({
      ...img,
      kind: img.url?.includes('/original/') ? 'original' : 'legacy',
    }));
  } else if (kind === null) {
    list = [
      ...(gallery.cutouts || []).map((img) => ({ ...img, kind: 'nobg' })),
      ...(gallery.originals || []).map((img) => ({
        ...img,
        kind: img.url?.includes('/original/') ? 'original' : 'legacy',
      })),
    ];
  } else {
    const cutouts = gallery.cutouts || [];
    list = (cutouts.length ? cutouts : gallery.originals || []).map((img) => ({
      ...img,
      kind: cutouts.length ? 'nobg' : img.url?.includes('/original/') ? 'original' : 'legacy',
    }));
  }

  const mapped = list.map((img, i) => {
    const ocrKey = `${img.kind}/${img.file}`;
    const cached = ocrCache[ocrKey]?.text || ocrCache[img.file]?.text || '';
    return {
      id: `${gallery.folder}__${img.kind}__${img.file}`.replace(/[^a-zA-Z0-9_-]/g, '_'),
      product: gallery.product,
      folder: gallery.folder,
      file: img.file,
      kind: img.kind,
      url: absoluteUrl(base, img.url),
      width: img.width || 0,
      height: img.height || 0,
      bytes: img.bytes || 0,
      hasAlpha: img.kind === 'nobg' || Boolean(img.hasAlpha),
      tags: [],
      ocrText: cached,
      _i: i,
    };
  });

  const filtered = filterRelevantImages(mapped, query, { allowWeakEmpty });
  // Sem fallback para "tudo" — melhor vazio do que encher com carrinho/loja
  return filtered.slice(0, limit);
}

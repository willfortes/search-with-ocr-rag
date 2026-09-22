/**
 * Resolve produto: banco primeiro → senão scrape (máx. 10) → indexa.
 */

import {
  searchBank,
  indexBank,
  checkBank,
  loadOcrCache,
  ensureFolderOcr,
} from './bank.js';
import {
  getProductGallery,
  sanitizeFolderName,
  displayProductName,
  downloadBestImages,
  mergeDuplicateProductFolders,
} from './download.js';
import { findProductImages } from './search.js';
import { generateSearchTerm, fallbackTerm, checkOllama, OLLAMA_MODEL } from './ollama.js';
import { processProductBackgrounds, DEFAULT_CONCURRENCY } from './bgremove.js';
import { validateSupermarketProduct } from './supermarket.js';
import { filterRelevantImages, supermarketSearchQuery } from './relevance.js';

const DEFAULT_LIMIT = 10;

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

function galleryToImages(gallery, { kind = 'nobg', limit = 10, offset = 0, base, ocrCache = {}, query = '' }) {
  const preferNobg = kind !== 'original';
  let merged = [];

  if (kind === 'original') {
    merged = (gallery.originals || []).map((img) => ({
      ...img,
      kind: img.url?.includes('/original/') ? 'original' : 'legacy',
    }));
  } else if (kind === null) {
    // any: nobg primeiro, depois originais sem par em nobg
    const nobg = (gallery.cutouts || []).map((img) => ({
      ...img,
      kind: 'nobg',
    }));
    const nobgStems = new Set(nobg.map((img) => String(img.file || '').replace(/^\d+_/, '').replace(/\.[^.]+$/, '')));
    const originals = (gallery.originals || [])
      .filter((img) => {
        const stem = String(img.file || '').replace(/^\d+_/, '').replace(/\.[^.]+$/, '');
        return !nobgStems.has(stem);
      })
      .map((img) => ({
        ...img,
        kind: img.url?.includes('/original/') ? 'original' : 'legacy',
      }));
    merged = [...nobg, ...originals];
  } else {
    // nobg (padrão): só recortes; se não houver, cai nos originais
    const cutouts = gallery.cutouts || [];
    merged = (cutouts.length ? cutouts : gallery.originals || []).map((img) => ({
      ...img,
      kind: cutouts.length
        ? 'nobg'
        : img.url?.includes('/original/')
          ? 'original'
          : 'legacy',
    }));
  }

  // dedupe por dimensões + tamanho (mesma foto baixada 2x)
  const seenSig = new Set();
  merged = merged.filter((img) => {
    const sig = `${img.width || 0}x${img.height || 0}:${img.bytes || 0}:${String(img.file || '').replace(/^\d+_/, '')}`;
    if (seenSig.has(sig)) return false;
    seenSig.add(sig);
    return true;
  });

  const withOcr = merged.map((img, i) => {
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

  const relevant = query
    ? filterRelevantImages(withOcr, query, { allowWeakEmpty: true })
    : withOcr;
  const total = relevant.length;
  const images = relevant.slice(offset, offset + limit);
  return { images, total, filteredOut: withOcr.length - relevant.length };
}

async function scrapeProductBatch({
  product,
  folder,
  searchTerm,
  limit,
  removeBg,
  bgConcurrency,
  bgModel,
  minWidth,
}) {
  const candidates = await findProductImages(searchTerm, {
    maxResults: Math.min(Math.max(limit * 5, 35), 60),
  });
  if (!candidates.length) {
    return { saved: [], cutouts: [], errors: [{ reason: 'Nenhuma imagem encontrada' }] };
  }

  const result = await downloadBestImages({
    productName: folder,
    candidates,
    perProduct: Math.min(Math.max(limit, 10), 15),
    minWidth,
  });

  let cutouts = [];
  let bgErrors = [];
  if (removeBg && result.saved.length) {
    const bg = await processProductBackgrounds({
      productName: folder,
      folder: result.folder,
      originals: result.saved,
      concurrency: bgConcurrency,
      model: bgModel,
    });
    cutouts = bg.cutouts;
    bgErrors = bg.errors;
  }

  return {
    saved: result.saved,
    cutouts,
    errors: [
      ...result.errors,
      ...bgErrors.map((e) => ({ reason: e.reason, file: e.originalFile })),
    ],
  };
}

function buildSearchTermVariants(productLabel, primaryTerm) {
  const base = supermarketSearchQuery(productLabel, primaryTerm);
  const name = String(productLabel || '').trim();
  return [
    ...new Set(
      [
        base,
        `${name} packshot embalagem fundo branco`,
        `${name} lata packshot produto`,
        `${name} garrafa packshot produto`,
        `${name} product photo transparent png`,
      ]
        .map((t) => t.replace(/\s+/g, ' ').trim())
        .filter(Boolean)
    ),
  ];
}

/**
 * API principal: banco → scrape → index.
 */
export async function resolveProductImages(req, body = {}) {
  const query = String(body.q || body.query || body.product || '').trim();
  const limit = Math.min(Math.max(Number(body.limit) || DEFAULT_LIMIT, 1), 10);
  const offset = Math.max(Number(body.offset) || 0, 0);
  const kind = body.kind === 'original' ? 'original' : body.kind === 'any' ? null : 'nobg';
  const scrapeIfMissing = body.scrapeIfMissing !== false;
  const removeBg = !(body.removeBg === false || body.removeBg === 'false');
  const useAi = body.useAi !== false;
  const model = body.model || OLLAMA_MODEL;
  const minWidth = Math.min(Math.max(Number(body.minWidth) || 400, 200), 2000);
  const bgConcurrency = Math.min(
    Math.max(Number(body.bgConcurrency) || DEFAULT_CONCURRENCY, 1),
    4
  );
  const bgModel = body.bgModel === 'small' ? 'small' : 'medium';
  const base = publicBase(req);

  const validation = await validateSupermarketProduct(query, { model, useAi });
  if (!validation.ok) {
    return {
      status: 400,
      body: {
        ok: false,
        error: validation.message || 'Produto rejeitado',
        reason: validation.reason,
        query,
        validation,
      },
    };
  }

  const folder = sanitizeFolderName(query);
  const productLabel = displayProductName(folder);
  const bank = await checkBank();

  // 1) Banco Meilisearch (falha de Meili não pode derrubar o resolve — cai no disco/scrape)
  if (bank.ok) {
    try {
      const search = await searchBank(query, {
        limit: Math.min(Math.max(limit * 4, 20), 40),
        offset: 0,
        kind,
        folder: body.exactFolder ? folder : null,
      });

      const relevant = filterRelevantImages(
        search.hits.map((h) => mapHit(h, base)),
        query,
        { allowWeakEmpty: true }
      );
      if (relevant.length) {
        const images = relevant.slice(offset, offset + limit);
        if (images.length) {
          return {
            status: 200,
            body: {
              ok: true,
              query,
              product: images[0].product || productLabel,
              folder: images[0].folder || folder,
              source: 'bank',
              validation,
              limit,
              offset,
              total: relevant.length,
              hasMore: offset + images.length < relevant.length || scrapeIfMissing,
              images,
            },
          };
        }
      }
    } catch (err) {
      console.warn('[resolve] Meilisearch indisponível, seguindo disco/scrape:', err.message);
    }
  }

  // 2) Galeria em disco — só imagens cujo OCR bate com o produto buscado
  const gallery = await getProductGallery(folder);
  const diskCount =
    (gallery?.cutouts?.length || 0) + (gallery?.originals?.length || 0);

  if (gallery && diskCount > 0) {
    await ensureFolderOcr(folder, { maxFiles: 16, preferKind: kind || 'nobg' });
    const ocrCache = await loadOcrCache(folder);
    const { images, total, filteredOut } = galleryToImages(gallery, {
      kind: kind || 'nobg',
      limit,
      offset,
      base,
      ocrCache,
      query,
    });

    if (filteredOut > 0) {
      console.warn(
        `[resolve] pasta "${folder}": ${filteredOut} imagem(ns) irrelevantes filtradas pelo OCR`
      );
    }

    if (images.length) {
      if (bank.ok) {
        try {
          // Sem embeddings no caminho quente — indexação leve (só keyword)
          await indexBank({ folder, withOcr: false, withEmbeddings: false });
        } catch {
          /* ignore */
        }
      }
      return {
        status: 200,
        body: {
          ok: true,
          query,
          product: gallery.product,
          folder: gallery.folder,
          source: 'disk',
          validation,
          limit,
          offset,
          total,
          hasMore: offset + images.length < total || scrapeIfMissing,
          images,
        },
      };
    }
    // disco só tinha lixo → segue para scrape limpo
  }

  // 3) Scrape se permitido
  if (!scrapeIfMissing) {
    return {
      status: 404,
      body: {
        ok: false,
        error: 'Produto não encontrado no banco',
        reason: 'not_found',
        query,
        folder,
        validation,
        images: [],
        hasMore: false,
        total: 0,
        limit,
        offset,
      },
    };
  }

  // "buscar mais": se já tem imagens RELEVANTES no disco e offset >= total, baixa mais um lote
  const ocrCacheProbe = gallery ? await loadOcrCache(folder) : {};
  const relevantDisk = gallery
    ? galleryToImages(gallery, {
        kind: kind || 'nobg',
        limit: 100,
        offset: 0,
        base,
        ocrCache: ocrCacheProbe,
        query,
      }).total
    : 0;
  const needScrape = !gallery || relevantDisk === 0 || offset >= relevantDisk;

  if (!needScrape) {
    return {
      status: 404,
      body: {
        ok: false,
        error: 'Sem mais imagens',
        reason: 'exhausted',
        query,
        folder,
        images: [],
        hasMore: false,
        total: relevantDisk,
        limit,
        offset,
      },
    };
  }

  await mergeDuplicateProductFolders();

  let searchTerm = String(body.searchTerm || '').trim();
  if (!searchTerm) {
    const ollama = await checkOllama();
    if (useAi && ollama.ok) {
      try {
        searchTerm = await generateSearchTerm(productLabel, model);
      } catch {
        searchTerm = fallbackTerm(productLabel);
      }
    } else {
      searchTerm = fallbackTerm(productLabel);
    }
  }

  searchTerm = supermarketSearchQuery(productLabel, searchTerm);
  const termVariants = buildSearchTermVariants(productLabel, searchTerm).slice(0, 2);
  const scrapeErrors = [];
  const needed = Math.max(limit + offset, limit);

  for (let round = 0; round < termVariants.length; round += 1) {
    const term = termVariants[round];
    const scraped = await scrapeProductBatch({
      product: productLabel,
      folder,
      searchTerm: term,
      limit: Math.max(needed, 10),
      removeBg,
      bgConcurrency,
      bgModel,
      minWidth,
    });
    scrapeErrors.push(...(scraped.errors || []));

    // OCR só o necessário para filtrar; embeddings ficam fora do caminho quente
    await ensureFolderOcr(folder, { maxFiles: Math.max(needed * 2, 12), preferKind: kind || 'nobg' });

    const freshRound = await getProductGallery(folder);
    if (!freshRound) continue;
    const ocrCacheRound = await loadOcrCache(folder);
    const { total } = galleryToImages(freshRound, {
      kind: kind || 'nobg',
      limit: 100,
      offset: 0,
      base,
      ocrCache: ocrCacheRound,
      query,
    });
    if (total >= Math.min(needed, limit)) {
      searchTerm = term;
      break;
    }
  }

  const fresh = await getProductGallery(folder);
  if (!fresh) {
    return {
      status: 404,
      body: {
        ok: false,
        error: 'Não foi possível obter imagens deste produto',
        reason: 'scrape_empty',
        query,
        folder,
        searchTerm,
        validation,
        scrapeErrors,
        images: [],
        hasMore: false,
        total: 0,
        limit,
        offset: 0,
        source: 'scrape',
      },
    };
  }

  await ensureFolderOcr(folder, { maxFiles: Math.max(limit * 2, 12), preferKind: kind || 'nobg' });

  const totalNow =
    (fresh.cutouts?.length || 0) + (fresh.originals?.length || 0);
  const ocrCacheFresh = await loadOcrCache(folder);
  const { images, total: relevantTotal } = galleryToImages(fresh, {
    kind: kind || 'nobg',
    limit,
    offset,
    base,
    ocrCache: ocrCacheFresh,
    query,
  });

  if (!images.length) {
    return {
      status: 404,
      body: {
        ok: false,
        error:
          'Não encontramos imagens adequadas deste produto. Tente um nome mais específico (ex.: coca cola lata).',
        reason: 'irrelevant_results',
        query,
        folder,
        searchTerm,
        validation,
        scrapeErrors,
        images: [],
        hasMore: false,
        total: 0,
        limit,
        offset: 0,
        source: 'scrape',
        diskTotal: totalNow,
      },
    };
  }

  return {
    status: 200,
    body: {
      ok: true,
      query,
      product: fresh.product,
      folder: fresh.folder,
      source: 'scrape',
      searchTerm,
      validation,
      scrape: {
        errors: scrapeErrors,
      },
      limit,
      offset,
      total: relevantTotal,
      hasMore: offset + images.length < relevantTotal || scrapeIfMissing,
      images,
    },
  };
}

export { DEFAULT_LIMIT };

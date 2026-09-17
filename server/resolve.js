/**
 * Resolve produto: banco primeiro → senão scrape (máx. 10) → indexa.
 */

import {
  searchBank,
  indexBank,
  checkBank,
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

function galleryToImages(gallery, { kind = 'nobg', limit = 10, offset = 0, base }) {
  const preferNobg = kind !== 'original';
  const primary = preferNobg ? gallery.cutouts || [] : gallery.originals || [];
  const secondary = preferNobg ? gallery.originals || [] : gallery.cutouts || [];
  const merged = [
    ...primary.map((img) => ({
      ...img,
      kind: img.url?.includes('/nobg/') ? 'nobg' : img.url?.includes('/original/') ? 'original' : 'legacy',
    })),
    ...secondary.map((img) => ({
      ...img,
      kind: img.url?.includes('/nobg/') ? 'nobg' : img.url?.includes('/original/') ? 'original' : 'legacy',
    })),
  ];

  const total = merged.length;
  const slice = merged.slice(offset, offset + limit);
  const images = slice.map((img, i) => ({
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
    ocrText: '',
    _i: offset + i,
  }));

  return { images, total };
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
    maxResults: Math.min(Math.max(limit * 3, 24), 50),
  });
  if (!candidates.length) {
    return { saved: [], cutouts: [], errors: [{ reason: 'Nenhuma imagem encontrada' }] };
  }

  const result = await downloadBestImages({
    productName: folder,
    candidates,
    perProduct: limit,
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

  // 1) Banco Meilisearch
  if (bank.ok) {
    const search = await searchBank(query, {
      limit,
      offset,
      kind,
      // se o nome bate com pasta, filtra; senão busca livre (ex.: cerveja → brahma)
      folder: body.exactFolder ? folder : null,
    });

    if (search.hits.length) {
      const total = search.estimatedTotalHits || search.hits.length;
      const pageHasMore = offset + search.hits.length < total;
      return {
        status: 200,
        body: {
          ok: true,
          query,
          product: search.hits[0].product || productLabel,
          folder: search.hits[0].folder || folder,
          source: 'bank',
          validation,
          limit,
          offset,
          total,
          // permite “buscar mais” via scrape mesmo com poucas no banco
          hasMore: pageHasMore || scrapeIfMissing,
          images: search.hits.map((h) => mapHit(h, base)),
        },
      };
    }
  }

  // 2) Galeria em disco (ainda não indexada)
  const gallery = await getProductGallery(folder);
  const diskCount =
    (gallery?.cutouts?.length || 0) + (gallery?.originals?.length || 0);

  if (gallery && diskCount > 0 && offset < diskCount) {
    // indexa em background-ish (await curto) para próximas buscas
    if (bank.ok) {
      try {
      await indexBank({ folder, withOcr: true, withEmbeddings: true });
      } catch {
        /* ignore */
      }
    }

    const { images, total } = galleryToImages(gallery, { kind: kind || 'nobg', limit, offset, base });
    if (images.length) {
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

  // "buscar mais": se já tem imagens no disco e offset >= total, baixa mais um lote
  const needScrape = !gallery || diskCount === 0 || offset >= diskCount;

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
        total: diskCount,
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

  // reforça contexto supermercado no termo
  if (!/supermercado|grocery|packshot/i.test(searchTerm)) {
    searchTerm = `${searchTerm} packshot supermercado`.slice(0, 180);
  }

  const scraped = await scrapeProductBatch({
    product: productLabel,
    folder,
    searchTerm,
    limit,
    removeBg,
    bgConcurrency,
    bgModel,
    minWidth,
  });

  if (bank.ok) {
    try {
      await indexBank({ folder, withOcr: true, withEmbeddings: true });
    } catch {
      /* ignore */
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
        scrapeErrors: scraped.errors,
        images: [],
        hasMore: false,
        total: 0,
        limit,
        offset: 0,
        source: 'scrape',
      },
    };
  }

  const totalNow =
    (fresh.cutouts?.length || 0) + (fresh.originals?.length || 0);
  // Após scrape, devolve o primeiro lote (offset 0) das imagens novas
  const { images } = galleryToImages(fresh, {
    kind: kind || 'nobg',
    limit,
    offset: 0,
    base,
  });

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
      limit,
      offset: 0,
      total: totalNow,
      hasMore: totalNow > limit || scrapeIfMissing,
      images,
      scrapeErrors: scraped.errors,
    },
  };
}

export { DEFAULT_LIMIT };

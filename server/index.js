import express from 'express';
import cors from 'cors';
import path from 'path';
import multer from 'multer';
import { fileURLToPath } from 'url';
import { checkOllama, generateSearchTerm, fallbackTerm, OLLAMA_MODEL } from './ollama.js';
import { findProductImages } from './search.js';
import { downloadBestImages, DOWNLOADS_ROOT, listProducts, getProductGallery, sanitizeFolderName, deleteProductFolder, mergeDuplicateProductFolders, displayProductName, purgeWatermarkedImages } from './download.js';
import { processProductBackgrounds, DEFAULT_CONCURRENCY } from './bgremove.js';
import { createBankRouter } from './bank-routes.js';
import { checkBank, deleteBankDocumentsByFolder, indexBank } from './bank.js';
import { buildSearchFromImage, findCandidatesFromImage } from './image-query.js';
import { resolveProductImages } from './resolve.js';
import { resolveProductImagesStream } from './resolve-stream.js';
import { checkGoWorker } from './go-downloader.js';
import { validateSupermarketProduct } from './supermarket.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT) || 3847;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/^image\//i.test(file.mimetype)) cb(null, true);
    else cb(new Error('Envie um arquivo de imagem'));
  },
});

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/docs', express.static(path.join(__dirname, '..', 'docs')));
app.use('/downloads', express.static(DOWNLOADS_ROOT));
app.use('/api/bank', createBankRouter());

app.get('/api/health', async (_req, res) => {
  const [ollama, bank, goWorker] = await Promise.all([
    checkOllama(),
    checkBank(),
    checkGoWorker(),
  ]);
  res.json({
    ok: true,
    ollama,
    bank,
    goWorker,
    downloads: DOWNLOADS_ROOT,
    features: {
      backgroundRemoval: true,
      gallery: true,
      imageBank: true,
      ocr: true,
      rag: true,
      searchByImage: true,
      resolve: true,
      resolveStream: true,
      goParallelDownloads: Boolean(goWorker.ok),
      supermarketValidation: true,
      defaultPerProduct: 10,
      maxPerResolve: 10,
      ocrOnIndex: true,
      hybridSearch: true,
    },
  });
});

app.get('/api/models', async (_req, res) => {
  const ollama = await checkOllama();
  if (!ollama.ok) {
    return res.status(503).json({
      ok: false,
      error: ollama.error,
      models: [],
      modelsDetail: [],
      selected: null,
    });
  }

  res.json({
    ok: true,
    models: ollama.models,
    modelsDetail: ollama.modelsDetail,
    selected: ollama.selected,
    url: ollama.url,
  });
});

app.get('/api/products', async (_req, res) => {
  try {
    const products = await listProducts();
    res.json({ products });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/products/merge', async (_req, res) => {
  try {
    const merges = await mergeDuplicateProductFolders();
    const products = await listProducts();
    res.json({ merges, products });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/products/:folder', async (req, res) => {
  try {
    const gallery = await getProductGallery(sanitizeFolderName(req.params.folder));
    if (!gallery) return res.status(404).json({ error: 'Produto não encontrado' });
    res.json(gallery);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/products/:folder', async (req, res) => {
  try {
    const folder = sanitizeFolderName(req.params.folder);
    const result = await deleteProductFolder(folder);
    const bank = await deleteBankDocumentsByFolder(folder);
    res.json({ ...result, bank });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

/**
 * Remove imagens com marca d'água já baixadas e reindexa o banco.
 * Body: { folder?: string }
 */
app.post('/api/purge-watermarks', async (req, res) => {
  try {
    const folder = req.body?.folder ? sanitizeFolderName(req.body.folder) : null;
    const result = await purgeWatermarkedImages({ folder });
    let reindex = null;
    if (result.removed > 0) {
      try {
        reindex = await indexBank({
          folder,
          withOcr: true,
          withEmbeddings: true,
        });
      } catch (err) {
        reindex = { error: err.message };
      }
    }
    res.json({ ok: true, ...result, reindex });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/products/:folder/research', async (req, res) => {
  const folder = sanitizeFolderName(req.params.folder);
  const productLabel = displayProductName(folder);
  let searchTerm = String(req.body?.searchTerm || '').trim();
  const useAi = req.body?.useAi !== false;
  const model = req.body?.model || OLLAMA_MODEL;

  if (!searchTerm) {
    if (useAi) {
      try {
        searchTerm = await generateSearchTerm(productLabel, model);
      } catch {
        searchTerm = fallbackTerm(productLabel);
      }
    } else {
      searchTerm = fallbackTerm(productLabel);
    }
  }

  // Reusa o mesmo pipeline SSE do scrape, com 1 item
  req.body = {
    ...(req.body || {}),
    items: [{ product: folder, searchTerm }],
  };

  return scrapeHandler(req, res);
});

app.post('/api/generate-terms', async (req, res) => {
  try {
    const raw = normalizeProducts(req.body?.products);
    // Deduplica por chave canônica (brahma + brahma_test → um só)
    const seen = new Set();
    const products = [];
    for (const p of raw) {
      const key = sanitizeFolderName(p);
      if (seen.has(key)) continue;
      seen.add(key);
      products.push(displayProductName(key));
    }

    const model = req.body?.model || OLLAMA_MODEL;
    const useAi = req.body?.useAi !== false;

    if (!products.length) {
      return res.status(400).json({ error: 'Envie uma lista de produtos.' });
    }

    const ollama = await checkOllama();
    const rows = [];
    const rejected = [];

    for (const product of products) {
      const validation = await validateSupermarketProduct(product, { model, useAi });
      if (!validation.ok) {
        rejected.push({ product, ...validation });
        continue;
      }

      let searchTerm;
      let source = 'fallback';

      if (useAi && ollama.ok) {
        try {
          searchTerm = await generateSearchTerm(product, model);
          source = 'ollama';
        } catch {
          searchTerm = fallbackTerm(product);
          source = 'fallback';
        }
      } else {
        searchTerm = fallbackTerm(product);
      }

      rows.push({
        product,
        folder: sanitizeFolderName(product),
        searchTerm,
        source,
        validation,
      });
    }

    if (!rows.length) {
      return res.status(400).json({
        error: 'Nenhum produto válido de supermercado na lista.',
        rejected,
      });
    }

    res.json({
      rows,
      rejected,
      ollama,
      model: useAi ? model : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/scrape', scrapeHandler);

/**
 * Resolve produto para o CriarOfertas / dashboard:
 * 1) valida supermercado
 * 2) busca no banco
 * 3) senão scrape (até 10) e indexa
 * Body: { q, limit?, offset?, kind?, scrapeIfMissing?, removeBg?, useAi? }
 */
app.post('/api/resolve', async (req, res) => {
  try {
    const result = await resolveProductImages(req, req.body || {});
    res.status(result.status).json(result.body);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/** Resolve progressivo (SSE): imagens chegam conforme processam + status engraçados */
app.get('/api/resolve/stream', async (req, res) => {
  try {
    await resolveProductImagesStream(req, res);
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ ok: false, error: err.message });
    }
  }
});

app.post('/api/resolve/stream', async (req, res) => {
  try {
    await resolveProductImagesStream(req, res);
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ ok: false, error: err.message });
    }
  }
});

app.get('/api/resolve', async (req, res) => {
  try {
    const result = await resolveProductImages(req, {
      q: req.query.q || req.query.query || req.query.product,
      limit: req.query.limit,
      offset: req.query.offset,
      kind: req.query.kind,
      scrapeIfMissing: req.query.scrape !== 'false' && req.query.scrapeIfMissing !== 'false',
      removeBg: req.query.removeBg !== 'false',
      useAi: req.query.useAi !== 'false',
      exactFolder: req.query.exactFolder === 'true',
    });
    res.status(result.status).json(result.body);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/validate-product', async (req, res) => {
  try {
    const q = String(req.body?.q || req.body?.product || '').trim();
    const validation = await validateSupermarketProduct(q, {
      model: req.body?.model,
      useAi: req.body?.useAi !== false,
    });
    res.status(validation.ok ? 200 : 400).json({ query: q, ...validation });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/search-by-image', upload.single('image'), async (req, res) => {
  try {
    if (!req.file?.buffer?.length) {
      return res.status(400).json({ error: 'Envie o campo image (arquivo).' });
    }

    const result = await findCandidatesFromImage({
      buffer: req.file.buffer,
      originalName: req.file.originalname,
      productHint: req.body?.product || req.body?.productHint || '',
      useAi: req.body?.useAi !== 'false' && req.body?.useAi !== false,
      model: req.body?.model || OLLAMA_MODEL,
      maxResults: Number(req.body?.maxResults) || 16,
    });

    res.json({
      product: result.product,
      folder: result.folder,
      searchTerm: result.searchTerm,
      ocrText: result.ocrText,
      source: result.source,
      candidates: result.candidates.slice(0, 12).map((c) => ({
        url: c.url,
        width: c.width,
        height: c.height,
        title: c.title,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/scrape-by-image', upload.single('image'), async (req, res) => {
  try {
    if (!req.file?.buffer?.length) {
      res.status(400).json({ error: 'Envie o campo image (arquivo).' });
      return;
    }

    const built = await buildSearchFromImage({
      buffer: req.file.buffer,
      originalName: req.file.originalname,
      productHint: req.body?.product || req.body?.productHint || '',
      useAi: req.body?.useAi !== 'false' && req.body?.useAi !== false,
      model: req.body?.model || OLLAMA_MODEL,
    });

    // Encaminha para o mesmo SSE do scrape textual
    req.body = {
      items: [{ product: built.folder, searchTerm: built.searchTerm }],
      perProduct: req.body?.perProduct,
      minWidth: req.body?.minWidth,
      delayMs: req.body?.delayMs,
      removeBg: req.body?.removeBg,
      bgConcurrency: req.body?.bgConcurrency,
      bgModel: req.body?.bgModel,
      _imageMeta: {
        ocrText: built.ocrText,
        source: built.source,
        searchTerm: built.searchTerm,
        product: built.product,
      },
    };

    return scrapeHandler(req, res);
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
});

async function scrapeHandler(req, res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const perProduct = Math.min(Math.max(Number(req.body?.perProduct) || 10, 1), 10);
    const maxCandidates = Math.min(
      Math.max(Number(req.body?.maxCandidates) || Math.max(perProduct * 3, 24), 8),
      50
    );
    const minWidth = Math.min(Math.max(Number(req.body?.minWidth) || 400, 200), 2000);
    const delayMs = Math.min(Math.max(Number(req.body?.delayMs) || 1200, 300), 5000);
    const removeBg = !(req.body?.removeBg === false || req.body?.removeBg === 'false');
    const bgConcurrency = Math.min(
      Math.max(Number(req.body?.bgConcurrency) || DEFAULT_CONCURRENCY, 1),
      4
    );
    const bgModel = req.body?.bgModel === 'small' ? 'small' : 'medium';

    if (!items.length) {
      send('error', { error: 'Nenhum item para processar.' });
      return res.end();
    }

    // Merge pastas duplicadas antes de baixar
    const merges = await mergeDuplicateProductFolders();
    if (merges.length) send('merged', { merges });

    if (req.body?._imageMeta) {
      send('image_query', req.body._imageMeta);
    }

    send('start', {
      total: items.length,
      perProduct,
      minWidth,
      removeBg,
      bgConcurrency,
      bgModel,
    });

    const summary = [];

    for (let i = 0; i < items.length; i++) {
      const { product, searchTerm } = items[i];
      if (!product?.trim() || !searchTerm?.trim()) continue;

      const folderKey = sanitizeFolderName(product);
      const validation = await validateSupermarketProduct(displayProductName(folderKey), {
        useAi: req.body?.useAi !== false,
        model: req.body?.model || OLLAMA_MODEL,
      });

      if (!validation.ok) {
        const rejected = {
          product: displayProductName(folderKey),
          folder: folderKey,
          searchTerm,
          saved: [],
          cutouts: [],
          errors: [{ reason: validation.message || 'Produto não é de supermercado' }],
          validation,
        };
        summary.push(rejected);
        send('product_rejected', rejected);
        send('product_done', rejected);
        continue;
      }

      send('product_start', {
        index: i,
        total: items.length,
        product: displayProductName(folderKey),
        folder: folderKey,
        searchTerm,
      });

      try {
        const candidates = await findProductImages(searchTerm, { maxResults: maxCandidates });
        send('candidates', {
          product: displayProductName(folderKey),
          folder: folderKey,
          count: candidates.length,
          top: candidates.slice(0, 5).map((c) => ({
            url: c.url,
            width: c.width,
            height: c.height,
            title: c.title,
          })),
        });

        if (!candidates.length) {
          const empty = {
            product: displayProductName(folderKey),
            folder: folderKey,
            searchTerm,
            saved: [],
            cutouts: [],
            errors: [{ reason: 'Nenhuma imagem encontrada' }],
          };
          summary.push(empty);
          send('product_done', empty);
        } else {
          const result = await downloadBestImages({
            productName: folderKey,
            candidates,
            perProduct,
            minWidth,
            onProgress: (p) => send('progress', p),
          });

          let cutouts = [];
          let bgErrors = [];

          if (removeBg && result.saved.length) {
            send('bg_batch_start', {
              product: displayProductName(folderKey),
              folder: folderKey,
              total: result.saved.length,
              concurrency: bgConcurrency,
              model: bgModel,
            });

            const bg = await processProductBackgrounds({
              productName: folderKey,
              folder: result.folder,
              originals: result.saved,
              concurrency: bgConcurrency,
              model: bgModel,
              onProgress: (p) => send('progress', p),
            });

            cutouts = bg.cutouts;
            bgErrors = bg.errors;
          }

          const done = {
            product: displayProductName(folderKey),
            folder: result.folderKey || folderKey,
            searchTerm,
            saved: result.saved,
            cutouts,
            errors: [...result.errors, ...bgErrors.map((e) => ({ reason: e.reason, file: e.originalFile }))],
            attempted: result.attempted,
          };
          summary.push(done);
          send('product_done', done);
        }
      } catch (err) {
        const fail = {
          product: displayProductName(folderKey),
          folder: folderKey,
          searchTerm,
          saved: [],
          cutouts: [],
          errors: [{ reason: err.message }],
        };
        summary.push(fail);
        send('product_done', fail);
      }

      if (i < items.length - 1) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }

    // OCR + RAG em tudo que foi baixado nesta rodada
    for (const item of summary) {
      if (!item.folder) continue;
      const hasFiles = (item.saved?.length || 0) + (item.cutouts?.length || 0) > 0;
      if (!hasFiles) continue;
      try {
        send('indexing', { folder: item.folder, product: item.product });
        const indexed = await indexBank({
          folder: item.folder,
          withOcr: true,
          withEmbeddings: true,
        });
        send('indexed', { folder: item.folder, ...indexed });
      } catch (err) {
        send('index_error', { folder: item.folder, error: err.message });
      }
    }

    send('complete', {
      totalProducts: summary.length,
      totalImages: summary.reduce((acc, s) => acc + (s.saved?.length || 0), 0),
      totalCutouts: summary.reduce((acc, s) => acc + (s.cutouts?.length || 0), 0),
      summary,
    });
  } catch (err) {
    send('error', { error: err.message });
  } finally {
    res.end();
  }
}

function normalizeProducts(input) {
  if (Array.isArray(input)) {
    return [...new Set(input.map((p) => String(p || '').trim()).filter(Boolean))];
  }
  if (typeof input === 'string') {
    return [...new Set(input.split(/\r?\n/).map((p) => p.trim()).filter(Boolean))];
  }
  return [];
}

app.listen(PORT, () => {
  console.log(`Product Image Scraper em http://localhost:${PORT}`);
  console.log(`Downloads em: ${DOWNLOADS_ROOT}`);
  console.log(`Ollama modelo padrão: ${OLLAMA_MODEL}`);
});

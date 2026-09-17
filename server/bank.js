import { Meilisearch } from 'meilisearch';
import fs from 'fs/promises';
import path from 'path';
import sharp from 'sharp';
import { createWorker } from 'tesseract.js';
import { listProducts, DOWNLOADS_ROOT } from './download.js';
import { buildSearchTags, meilisearchSynonyms, inferProductFromOcr } from './taxonomy.js';
import {
  buildRagText,
  embedText,
  resolveEmbedModel,
  checkEmbeddings,
  expandSearchQuery,
} from './embeddings.js';

const MEILI_HOST = process.env.MEILI_HOST || 'http://127.0.0.1:7700';
const MEILI_KEY = process.env.MEILI_MASTER_KEY || 'dev_master_key_change_me';
const INDEX_UID = process.env.MEILI_INDEX || 'product_images';
const OCR_CONCURRENCY = Math.min(Math.max(Number(process.env.OCR_CONCURRENCY) || 2, 1), 4);
const EMBEDDER_NAME = 'default';

let client;
let ocrWorkerPromise;
let embedderDimensions = null;

function getClient() {
  if (!client) {
    client = new Meilisearch({ host: MEILI_HOST, apiKey: MEILI_KEY });
  }
  return client;
}

export async function checkBank() {
  try {
    const meili = getClient();
    const health = await meili.health();
    const indexes = await meili.getIndexes();
    const hasIndex = indexes.results?.some((i) => i.uid === INDEX_UID);
    let stats = null;
    if (hasIndex) {
      stats = await meili.index(INDEX_UID).getStats();
    }
    const embeddings = await checkEmbeddings().catch(() => ({ ok: false }));
    return {
      ok: health.status === 'available',
      host: MEILI_HOST,
      index: INDEX_UID,
      documents: stats?.numberOfDocuments ?? 0,
      isIndexing: stats?.isIndexing ?? false,
      ocrDefault: true,
      rag: {
        ok: Boolean(embeddings.ok),
        model: embeddings.model || null,
        dimensions: embeddings.dimensions || embedderDimensions || null,
        hint: embeddings.hint || embeddings.error || null,
      },
    };
  } catch (err) {
    return {
      ok: false,
      host: MEILI_HOST,
      index: INDEX_UID,
      documents: 0,
      error: err.message,
    };
  }
}

export async function ensureIndex() {
  const meili = getClient();
  try {
    await meili.getIndex(INDEX_UID);
  } catch {
    await meili.createIndex(INDEX_UID, { primaryKey: 'id' });
  }

  const index = meili.index(INDEX_UID);
  const settingsTask = await index.updateSettings({
    searchableAttributes: ['product', 'folder', 'folderLabel', 'detectedProduct', 'file', 'ocrText', 'ragText', 'kind', 'tags'],
    filterableAttributes: ['folder', 'kind', 'hasAlpha', 'product', 'mismatched', 'detectedBrand'],
    sortableAttributes: ['width', 'height', 'bytes', 'indexedAt'],
    synonyms: meilisearchSynonyms(),
    displayedAttributes: [
      'id',
      'product',
      'folder',
      'folderLabel',
      'detectedProduct',
      'detectedBrand',
      'mismatched',
      'file',
      'kind',
      'url',
      'width',
      'height',
      'bytes',
      'hasAlpha',
      'ocrText',
      'ragText',
      'tags',
      'indexedAt',
      'hasEmbedding',
    ],
  });
  await getClient().tasks.waitForTask(settingsTask.taskUid, { timeout: 60000 });

  // Embedder userProvided (RAG) — dimensões descobertas no 1º embed
  const embedModel = await resolveEmbedModel();
  if (embedModel) {
    try {
      const probe = await embedText('produto supermercado', embedModel);
      if (probe?.length) {
        embedderDimensions = probe.length;
        const embTask = await index.updateEmbedders({
          [EMBEDDER_NAME]: {
            source: 'userProvided',
            dimensions: probe.length,
          },
        });
        await getClient().tasks.waitForTask(embTask.taskUid, { timeout: 60000 });
      }
    } catch {
      // Meili/Ollama sem vetores — segue só com texto/OCR
    }
  }

  return index;
}

async function getOcrWorker() {
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = (async () => {
      const worker = await createWorker('por+eng');
      return worker;
    })();
  }
  return ocrWorkerPromise;
}

const OCR_HINT_WORDS = [
  'cerveja',
  'heineken',
  'brahma',
  'lager',
  'pilsen',
  'chopp',
  'beer',
  'skol',
  'antarctica',
  'omo',
  'ariel',
  'feijao',
  'sabao',
  'detergente',
];

function scoreOcrCandidate(text, confidence = 0) {
  const norm = String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  const words = (norm.match(/[a-z0-9]{3,}/g) || []).length;
  let bonus = 0;
  for (const hint of OCR_HINT_WORDS) {
    if (norm.includes(hint)) bonus += 80;
  }
  return Number(confidence || 0) + words * 3 + bonus;
}

/**
 * OCR com pré-processamento e rotação.
 * Embalagens (ex.: Heineken) costumam ter "CERVEJA" na vertical — ângulo 0 falha.
 */
export async function runOcrOnFile(absolutePath) {
  const worker = await getOcrWorker();
  let best = { text: '', score: -1 };

  for (const angle of [0, 90, 270]) {
    try {
      const buf = await sharp(absolutePath, { failOn: 'none' })
        .rotate(angle)
        .resize({ width: 1600, withoutEnlargement: false })
        .grayscale()
        .normalize()
        .png()
        .toBuffer();

      const result = await worker.recognize(buf);
      const text = (result?.data?.text || '').replace(/\s+/g, ' ').trim();
      if (!text) continue;

      const score = scoreOcrCandidate(text, result?.data?.confidence);
      if (score > best.score) {
        best = { text, score };
        if (score >= 120) break;
      }
    } catch {
      // tenta próximo ângulo
    }
  }

  return best.text;
}

async function loadOcrCache(folder) {
  const cachePath = path.join(DOWNLOADS_ROOT, folder, '.ocr-cache.json');
  try {
    const raw = await fs.readFile(cachePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function saveOcrCache(folder, cache) {
  const cachePath = path.join(DOWNLOADS_ROOT, folder, '.ocr-cache.json');
  try {
    await fs.writeFile(cachePath, JSON.stringify(cache, null, 2), 'utf8');
  } catch {
    /* ignore */
  }
}

async function fileMtimeMs(abs) {
  try {
    const st = await fs.stat(abs);
    return st.mtimeMs;
  } catch {
    return 0;
  }
}

async function mapPool(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  const n = Math.min(concurrency, Math.max(items.length, 1));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

function buildDocumentsFromGallery(gallery, { ocrMap = new Map() } = {}) {
  const docs = [];
  const push = (img, kind) => {
    const id = `${gallery.folder}__${kind}__${img.file}`.replace(/[^a-zA-Z0-9_-]/g, '_');
    const ocrKey = `${kind}/${img.file}`;
    const ocrText = ocrMap.get(ocrKey) || '';
    const inferred = inferProductFromOcr({
      folder: gallery.folder,
      product: gallery.product,
      ocrText,
    });
    // Se OCR detectou outro produto (Heineken na pasta "vem"), usa o nome detectado na busca
    const productLabel = inferred.mismatched
      ? inferred.label
      : gallery.product;
    const tags = buildSearchTags({
      product: productLabel,
      folder: gallery.folder,
      file: img.file,
      ocrText,
    });
    const ragText = buildRagText({
      product: productLabel,
      folder: gallery.folder,
      file: img.file,
      tags,
      ocrText,
    });

    docs.push({
      id,
      product: productLabel,
      folder: gallery.folder,
      folderLabel: gallery.product,
      detectedProduct: inferred.mismatched ? inferred.label : null,
      detectedBrand: inferred.brand,
      mismatched: Boolean(inferred.mismatched),
      file: img.file,
      kind,
      url: img.url,
      width: img.width || 0,
      height: img.height || 0,
      bytes: img.bytes || 0,
      hasAlpha: kind === 'nobg' || Boolean(img.hasAlpha),
      ocrText,
      ragText,
      tags,
      indexedAt: Date.now(),
      absolutePath: path.join(
        DOWNLOADS_ROOT,
        gallery.folder,
        kind === 'legacy' ? img.file : path.join(kind, img.file)
      ),
    });
  };

  for (const img of gallery.originals || []) {
    const kind = img.url.includes('/original/') ? 'original' : 'legacy';
    push(img, kind);
  }
  for (const img of gallery.cutouts || []) {
    push(img, 'nobg');
  }
  return docs;
}

/**
 * Indexa downloads/ no Meilisearch.
 * Por padrão: OCR em TODAS as imagens + embeddings RAG quando Ollama tiver modelo embed.
 */
export async function indexBank({
  withOcr = true,
  withEmbeddings = true,
  enrichOcrSample = false,
  folder = null,
  onProgress,
} = {}) {
  const index = await ensureIndex();
  const all = await listProducts();
  const galleries = folder
    ? all.filter((g) => g.folder === folder || g.product === folder)
    : all;

  if (!galleries.length) {
    return { indexed: 0, products: 0, withOcr, message: 'Nenhum produto em downloads/' };
  }

  const embedModel = withEmbeddings ? await resolveEmbedModel() : null;
  const documents = [];
  let ocrCount = 0;
  let ocrCached = 0;
  let embedCount = 0;

  for (const gallery of galleries) {
    const ocrMap = new Map();
    const shouldOcr = withOcr || enrichOcrSample;
    const cache = shouldOcr ? await loadOcrCache(gallery.folder) : {};

    if (shouldOcr) {
      const cutouts = gallery.cutouts || [];
      const originals = gallery.originals || [];
      const targets = withOcr
        ? [
            ...cutouts.map((img) => ({ img, kind: 'nobg' })),
            ...originals.map((img) => ({
              img,
              kind: img.url.includes('/original/') ? 'original' : 'legacy',
            })),
          ]
        : [
            ...cutouts.slice(0, 3).map((img) => ({ img, kind: 'nobg' })),
            ...originals.slice(0, 1).map((img) => ({
              img,
              kind: img.url.includes('/original/') ? 'original' : 'legacy',
            })),
          ];

      const seen = new Set();
      const jobs = [];
      for (const { img, kind } of targets) {
        const key = `${kind}/${img.file}`;
        if (seen.has(key)) continue;
        seen.add(key);
        jobs.push({ img, kind, key });
      }

      await mapPool(jobs, OCR_CONCURRENCY, async ({ img, kind, key }) => {
        const abs = path.join(
          DOWNLOADS_ROOT,
          gallery.folder,
          kind === 'legacy' ? img.file : path.join(kind, img.file)
        );
        const mtime = await fileMtimeMs(abs);
        const cached = cache[key];
        if (cached && cached.mtime === mtime && typeof cached.text === 'string') {
          if (cached.text) ocrMap.set(key, cached.text);
          ocrCached += 1;
          return;
        }

        try {
          onProgress?.({ type: 'ocr', product: gallery.product, file: img.file });
          const text = await runOcrOnFile(abs);
          cache[key] = { text, mtime, at: Date.now() };
          if (text) {
            ocrMap.set(key, text);
            ocrCount += 1;
          }
        } catch (err) {
          onProgress?.({
            type: 'ocr_error',
            product: gallery.product,
            file: img.file,
            reason: err.message,
          });
        }
      });

      await saveOcrCache(gallery.folder, cache);
    }

    const docs = buildDocumentsFromGallery(gallery, { ocrMap });

    if (embedModel) {
      for (const doc of docs) {
        try {
          onProgress?.({ type: 'embed', product: gallery.product, file: doc.file });
          const vector = await embedText(doc.ragText || doc.ocrText || doc.product, embedModel);
          if (vector?.length) {
            doc._vectors = { [EMBEDDER_NAME]: vector };
            doc.hasEmbedding = true;
            embedCount += 1;
            if (!embedderDimensions) embedderDimensions = vector.length;
          } else {
            doc.hasEmbedding = false;
          }
        } catch {
          doc.hasEmbedding = false;
        }
      }
    }

    documents.push(
      ...docs.map(({ absolutePath, ...rest }) => rest)
    );
    onProgress?.({
      type: 'product_indexed',
      product: gallery.product,
      folder: gallery.folder,
      docs: docs.length,
      tagsSample: docs[0]?.tags?.slice(0, 12) || [],
      ocrSample: docs[0]?.ocrText?.slice(0, 80) || '',
    });
  }

  if (documents.length) {
    const task = await index.addDocuments(documents, { primaryKey: 'id' });
    await getClient().tasks.waitForTask(task.taskUid, { timeout: 300000 });
  }

  return {
    indexed: documents.length,
    products: galleries.length,
    ocrCount,
    ocrCached,
    embedCount,
    withOcr,
    withEmbeddings: Boolean(embedModel),
    embedModel: embedModel || null,
    enrichOcrSample,
  };
}

export async function searchBank(
  query,
  { limit = 20, offset = 0, kind = null, folder = null, hybrid = true } = {}
) {
  await ensureIndex();
  const index = getClient().index(INDEX_UID);

  const filters = [];
  if (kind) filters.push(`kind = "${kind}"`);
  if (folder) filters.push(`folder = "${folder}"`);

  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const filter = filters.length ? filters.join(' AND ') : undefined;

  let searchQuery = query || '';
  let mode = 'keyword';
  let expanded = null;

  const searchParams = {
    limit: safeLimit,
    offset: safeOffset,
    filter,
    attributesToHighlight: ['product', 'ocrText', 'ragText', 'file', 'tags'],
  };

  if (hybrid && query) {
    try {
      const vector = await embedText(query);
      if (vector?.length) {
        searchParams.vector = vector;
        searchParams.hybrid = {
          embedder: EMBEDDER_NAME,
          semanticRatio: 0.55,
        };
        mode = 'hybrid';
      } else {
        expanded = await expandSearchQuery(query);
        if (expanded && expanded !== query) {
          searchQuery = expanded;
          mode = 'expanded';
        }
      }
    } catch {
      try {
        expanded = await expandSearchQuery(query);
        if (expanded && expanded !== query) {
          searchQuery = expanded;
          mode = 'expanded';
        }
      } catch {
        mode = 'keyword';
      }
    }
  }

  let result;
  try {
    result = await index.search(searchQuery, searchParams);
  } catch (err) {
    if (searchParams.hybrid) {
      delete searchParams.vector;
      delete searchParams.hybrid;
      try {
        expanded = expanded || (await expandSearchQuery(query));
        searchQuery = expanded || query || '';
        mode = expanded && expanded !== query ? 'expanded' : 'keyword_fallback';
        result = await index.search(searchQuery, searchParams);
      } catch {
        result = await index.search(query || '', searchParams);
        mode = 'keyword_fallback';
      }
    } else {
      throw err;
    }
  }

  return {
    query: query || '',
    expandedQuery: expanded && expanded !== query ? expanded : undefined,
    estimatedTotalHits: result.estimatedTotalHits,
    processingTimeMs: result.processingTimeMs,
    limit: safeLimit,
    offset: safeOffset,
    mode,
    hits: result.hits,
  };
}

export async function clearBank() {
  const index = await ensureIndex();
  const task = await index.deleteAllDocuments();
  await getClient().tasks.waitForTask(task.taskUid, { timeout: 60000 });
  return { cleared: true };
}

export async function deleteBankDocumentsByFolder(folder) {
  try {
    const index = await ensureIndex();
    const task = await index.deleteDocuments({
      filter: `folder = "${folder}"`,
    });
    await getClient().tasks.waitForTask(task.taskUid, { timeout: 60000 });
    return { deletedFolderDocs: true, folder };
  } catch (err) {
    return { deletedFolderDocs: false, folder, error: err.message };
  }
}

export async function getBankDocument(id) {
  await ensureIndex();
  return getClient().index(INDEX_UID).getDocument(id);
}

export { MEILI_HOST, INDEX_UID };

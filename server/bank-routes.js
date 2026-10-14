import express from 'express';
import {
  checkBank,
  indexBank,
  searchBank,
  clearBank,
  getBankDocument,
  runOcrOnFile,
} from './bank.js';
import { getProductGallery, sanitizeFolderName, DOWNLOADS_ROOT } from './download.js';
import { importDriveFolder } from './drive-import.js';
import path from 'path';

const DEFAULT_DRIVE_FOLDER = process.env.DRIVE_IMAGES_FOLDER_ID || '';

/** Job único de importação do Drive (download + OCR + embeddings leva dezenas de minutos). */
let driveJob = null;

function requireAdmin(req, res) {
  const token = process.env.BANK_ADMIN_TOKEN;
  if (!token) return true;
  const sent = req.get('x-admin-token') || req.query.token;
  if (sent === token) return true;
  res.status(401).json({ error: 'x-admin-token inválido' });
  return false;
}

function driveFolderIdFrom(input) {
  const raw = String(input || '').trim();
  const m = raw.match(/folders\/([A-Za-z0-9_-]+)/) || raw.match(/[?&]id=([A-Za-z0-9_-]+)/);
  return m ? m[1] : raw;
}

export function createBankRouter() {
  const router = express.Router();

  router.get('/import-drive', (_req, res) => {
    res.json(driveJob || { status: 'idle' });
  });

  router.post('/import-drive', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    if (driveJob?.status === 'running') {
      return res.status(409).json({ error: 'Importação já em andamento', job: driveJob });
    }
    const folderId = driveFolderIdFrom(req.body?.folder || req.body?.folderId || DEFAULT_DRIVE_FOLDER);
    if (!folderId) return res.status(400).json({ error: 'Informe folder (link ou id da pasta do Drive)' });
    const withOcr = req.body?.withOcr !== false;
    const withEmbeddings = req.body?.withEmbeddings !== false;

    driveJob = { status: 'running', folderId, startedAt: new Date().toISOString(), stage: 'import', progress: null };
    res.status(202).json(driveJob);

    try {
      const imported = await importDriveFolder({
        folderId,
        onProgress: (p) => {
          driveJob.progress = p;
        },
      });
      driveJob.import = { ...imported, folders: imported.folders.length, junk: imported.junk.length };
      driveJob.stage = 'index';
      // Indexa tudo de uma vez (ensureIndex por pasta seria lento); OCR já feito fica em cache
      const indexed = await indexBank({
        withOcr,
        withEmbeddings,
        onProgress: (p) => {
          driveJob.progress = p;
        },
      });
      driveJob.index = indexed;
      driveJob.status = 'done';
    } catch (err) {
      driveJob.status = 'error';
      driveJob.error = err.message;
    } finally {
      driveJob.finishedAt = new Date().toISOString();
    }
  });

  router.get('/health', async (_req, res) => {
    const bank = await checkBank();
    res.status(bank.ok ? 200 : 503).json(bank);
  });

  router.get('/search', async (req, res) => {
    try {
      const result = await searchBank(String(req.query.q || ''), {
        limit: req.query.limit,
        offset: req.query.offset,
        kind: req.query.kind || null,
        folder: req.query.folder || null,
        hybrid: req.query.hybrid !== 'false',
      });
      res.json(result);
    } catch (err) {
      res.status(503).json({
        error: err.message,
        hint: 'Suba o Meilisearch (docker compose up) e rode POST /api/bank/index',
      });
    }
  });

  router.post('/index', async (req, res) => {
    try {
      // OCR completo por padrão; só desliga se withOcr === false
      const withOcr = req.body?.withOcr !== false && req.body?.withOcr !== 'false';
      const withEmbeddings =
        req.body?.withEmbeddings !== false && req.body?.withEmbeddings !== 'false';
      const folder = req.body?.folder ? sanitizeFolderName(req.body.folder) : null;
      const result = await indexBank({ withOcr, withEmbeddings, folder });
      res.json(result);
    } catch (err) {
      res.status(503).json({
        error: err.message,
        hint: 'Verifique MEILI_HOST e se o serviço meilisearch está no ar',
      });
    }
  });

  router.delete('/index', async (_req, res) => {
    try {
      const result = await clearBank();
      res.json(result);
    } catch (err) {
      res.status(503).json({ error: err.message });
    }
  });

  router.get('/documents/:id', async (req, res) => {
    try {
      const doc = await getBankDocument(req.params.id);
      res.json(doc);
    } catch (err) {
      res.status(404).json({ error: err.message });
    }
  });

  router.post('/ocr', async (req, res) => {
    try {
      const folder = sanitizeFolderName(req.body?.folder || '');
      const kind = req.body?.kind === 'original' ? 'original' : 'nobg';
      const file = String(req.body?.file || '').replace(/[\\/]/g, '');
      if (!folder || !file) {
        return res.status(400).json({ error: 'Informe folder e file' });
      }

      const abs = path.join(DOWNLOADS_ROOT, folder, kind, file);
      const text = await runOcrOnFile(abs);
      res.json({ folder, kind, file, ocrText: text });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/preview/:folder', async (req, res) => {
    try {
      const gallery = await getProductGallery(sanitizeFolderName(req.params.folder));
      if (!gallery) return res.status(404).json({ error: 'Produto não encontrado' });
      res.json(gallery);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

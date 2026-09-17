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
import path from 'path';

export function createBankRouter() {
  const router = express.Router();

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

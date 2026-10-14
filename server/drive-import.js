import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import sharp from 'sharp';
import { DOWNLOADS_ROOT, sanitizeFolderName } from './download.js';
import { mapPool } from './bgremove.js';

/**
 * Importa um banco de imagens curado de uma pasta pública do Google Drive.
 *
 * Estrutura esperada: <DEPARTAMENTO>/[<SUB>/]<JPG E PNG | WEBP>/<Nome do Produto>.<ext>
 * O nome do arquivo vira o rótulo do produto (curado = confiável, mesmo sem texto no OCR).
 * Mesma imagem em JPG/PNG e WEBP → fica só a melhor (com alpha > maior resolução).
 *
 * Saída: downloads/<produto>/nobg/ (já transparente) ou original/ + .source.json.
 * Reimportar é idempotente: downloads/.drive-import.json guarda os ids já importados.
 */

const MANIFEST_PATH = path.join(DOWNLOADS_ROOT, '.drive-import.json');
const MAX_EDGE = Math.min(Math.max(Number(process.env.DRIVE_IMPORT_MAX_EDGE) || 1500, 400), 4000);
const DL_CONCURRENCY = Math.min(Math.max(Number(process.env.DRIVE_IMPORT_CONCURRENCY) || 6, 1), 12);

const FORMAT_DIRS = /^(jpe?g|png|webp|jpe?g e png|png e jpe?g)$/i;

/** Nome de arquivo que não é produto (banner, logo, stock genérico, id sem nome). */
const JUNK_NAME =
  /(kisspng|pngguru|pngwing|banner|logo|chamada|texto|caixa-de-papelao|pngfuel|ofertas|^oferta|sale[ _-]?tag|aqui[ _-]tem|fundo|background|textura|wallpaper|freepik|^img[-_ ]?\d|^image\d*$|^download|^whatsapp|^\d+$|^[0-9a-f]{8,}$)/i;

export function cleanDriveProductName(stem) {
  return String(stem || '')
    .replace(/-?removebg-?preview/gi, ' ')
    .replace(/\(\d+\)|\[\d+\]/g, ' ')
    .replace(/(toppng|pngkey|pnglot|pngtree|pngfuel)[ ._-]?com/gi, ' ')
    .replace(/png[ _-]?transparent/gi, ' ')
    .replace(/D_NQ_NP_.*$/i, ' ')
    .replace(/MLB\d+.*$/i, ' ')
    .replace(/\d{2,4}x\d{2,4}/g, ' ')
    .replace(/\b\d{6,}\b.*$/, ' ')
    .replace(/\d*\s*\b[a-f0-9]{16,}\b/gi, ' ')
    .replace(/promocional|promoco|imperdivel|download/gi, ' ')
    .replace(/png(?=[^a-z]|$)/gi, ' ')
    .replace(/[_.-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    // variações numeradas do mesmo produto: "Tomate1", "Abacaxi Ananá 3 1" → mesmo nome
    .replace(/(\s+(\d{1,3}|zoom|pt|un|novo|copy|copia))+$/i, '')
    .replace(/([a-zà-ú])\d{1,2}$/i, '$1')
    .replace(/(\s+\d{1,3})+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isJunkDriveName(stem, cleaned = cleanDriveProductName(stem)) {
  return JUNK_NAME.test(stem) || JUNK_NAME.test(cleaned) || cleaned.length < 3;
}

function decodeHtml(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

/** Lista recursiva via embeddedfolderview (pasta precisa estar "qualquer pessoa com o link"). */
export async function crawlDriveFolder(folderId, trail = [], out = []) {
  const res = await fetch(`https://drive.google.com/embeddedfolderview?id=${encodeURIComponent(folderId)}`);
  if (!res.ok) throw new Error(`Drive ${res.status} ao listar ${trail.join('/') || folderId}`);
  const html = await res.text();
  const re = /<div class="flip-entry" id="entry-([A-Za-z0-9_-]+)"[\s\S]*?<a href="([^"]+)"[\s\S]*?flip-entry-title">([^<]*)</g;
  let m;
  const entries = [];
  while ((m = re.exec(html))) entries.push({ id: m[1], href: m[2], name: decodeHtml(m[3]).trim() });
  for (const e of entries) {
    if (e.href.includes('/folders/')) await crawlDriveFolder(e.id, [...trail, e.name], out);
    else if (/\.(png|jpe?g|webp)$/i.test(e.name)) out.push({ id: e.id, trail, name: e.name });
  }
  return out;
}

async function downloadDriveFile(id) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(
        `https://drive.usercontent.google.com/download?id=${encodeURIComponent(id)}&export=download&confirm=t`
      );
      const ct = res.headers.get('content-type') || '';
      if (!res.ok || ct.includes('text/html')) throw new Error(`HTTP ${res.status} ${ct}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  throw lastErr;
}

/** Redimensiona e converte para WebP (alpha preservado). Arquivos do Drive chegam com ~4 MB. */
async function normalizeImage(buffer) {
  const meta = await sharp(buffer, { failOn: 'none' }).metadata();
  let pipeline = sharp(buffer, { failOn: 'none' }).rotate();
  if (meta.hasAlpha) pipeline = pipeline.trim({ threshold: 8 });
  const out = await pipeline
    .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 88, alphaQuality: 95, effort: 4 })
    .toBuffer({ resolveWithObject: true });
  return { buffer: out.data, width: out.info.width, height: out.info.height, hasAlpha: Boolean(meta.hasAlpha) };
}

const folderLocks = new Map();
/** Serializa escritas no .source.json da mesma pasta (vários arquivos do Drive → mesmo produto). */
function withFolderLock(folder, fn) {
  const prev = folderLocks.get(folder) || Promise.resolve();
  const next = prev.then(fn, fn);
  folderLocks.set(folder, next.catch(() => {}));
  return next;
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Metadados de origem de uma pasta de produto (lido pelo indexador). */
export async function readFolderSource(folder) {
  return readJson(path.join(DOWNLOADS_ROOT, folder, '.source.json'), null);
}

export async function importDriveFolder({ folderId, onProgress, dryRun = false } = {}) {
  if (!folderId) throw new Error('Informe folderId da pasta do Drive');
  await fs.mkdir(DOWNLOADS_ROOT, { recursive: true });

  onProgress?.({ type: 'crawl_start', folderId });
  const files = await crawlDriveFolder(folderId);
  onProgress?.({ type: 'crawl_done', files: files.length });

  // Agrupa variantes de formato: departamento sem a pasta "JPG E PNG"/"WEBP" + nome sem extensão
  const groups = new Map();
  for (const f of files) {
    const deptTrail = f.trail.filter((p) => !FORMAT_DIRS.test(p.trim()));
    const department = deptTrail.join('/') || 'GERAL';
    const stem = f.name.replace(/\.[^.]+$/, '');
    const key = `${department}|${stem.toLowerCase()}`;
    if (!groups.has(key)) groups.set(key, { department, stem, variants: [] });
    groups.get(key).variants.push(f);
  }

  const manifest = await readJson(MANIFEST_PATH, { folderId, items: {} });
  const report = {
    files: files.length,
    groups: groups.size,
    imported: 0,
    skippedExisting: 0,
    junk: [],
    duplicates: 0,
    failed: [],
    folders: new Set(),
  };
  const seenHashes = new Set(Object.values(manifest.items).map((i) => i.hash));

  const jobs = [...groups.values()];
  let done = 0;
  await mapPool(jobs, DL_CONCURRENCY, async (group) => {
    const label = cleanDriveProductName(group.stem);
    try {
      if (isJunkDriveName(group.stem, label)) {
        report.junk.push(`${group.department}/${group.stem}`);
        return;
      }
      if (group.variants.some((v) => manifest.items[v.id])) {
        report.skippedExisting += 1;
        return;
      }
      if (dryRun) {
        report.imported += 1;
        report.folders.add(sanitizeFolderName(label));
        return;
      }

      // PNG/JPG primeiro; só baixa a variante WEBP se a primeira não tiver transparência
      const ordered = [...group.variants].sort(
        (a, b) => Number(/\.webp$/i.test(a.name)) - Number(/\.webp$/i.test(b.name))
      );
      let best = null;
      for (const v of ordered) {
        const raw = await downloadDriveFile(v.id);
        const meta = await sharp(raw, { failOn: 'none' }).metadata();
        const score = (meta.hasAlpha ? 1e9 : 0) + (meta.width || 0) * (meta.height || 0);
        if (!best || score > best.score) best = { raw, score, variant: v };
        if (meta.hasAlpha) break;
      }

      const img = await normalizeImage(best.raw);
      const hash = crypto.createHash('sha1').update(img.buffer).digest('hex');
      if (seenHashes.has(hash)) {
        report.duplicates += 1;
        for (const v of group.variants) manifest.items[v.id] = { hash, duplicate: true };
        return;
      }
      seenHashes.add(hash);

      const folder = sanitizeFolderName(label);
      const kind = img.hasAlpha ? 'nobg' : 'original';
      const file = `drive_${hash.slice(0, 12)}.webp`;
      const dir = path.join(DOWNLOADS_ROOT, folder, kind);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, file), img.buffer);

      await withFolderLock(folder, async () => {
        const sourcePath = path.join(DOWNLOADS_ROOT, folder, '.source.json');
        const source = await readJson(sourcePath, {});
        source.source = 'drive';
        source.label = source.label || label;
        source.departments = [...new Set([...(source.departments || []), group.department])];
        // curadoria é por arquivo: fotos do Bing na mesma pasta continuam passando pelo OCR
        source.files = [...new Set([...(source.files || []), file])];
        await fs.writeFile(sourcePath, JSON.stringify(source, null, 1));
      });

      for (const v of group.variants) {
        manifest.items[v.id] = { hash, folder, kind, file, name: v.name, department: group.department };
      }
      report.imported += 1;
      report.folders.add(folder);
    } catch (err) {
      report.failed.push({ name: `${group.department}/${group.stem}`, error: err.message });
    } finally {
      done += 1;
      if (done % 50 === 0 || done === jobs.length) {
        onProgress?.({ type: 'progress', done, total: jobs.length, imported: report.imported });
        if (!dryRun) await fs.writeFile(MANIFEST_PATH, JSON.stringify(manifest)).catch(() => {});
      }
    }
  });

  if (!dryRun) {
    manifest.folderId = folderId;
    manifest.updatedAt = new Date().toISOString();
    await fs.writeFile(MANIFEST_PATH, JSON.stringify(manifest));
  }

  return { ...report, folders: [...report.folders] };
}

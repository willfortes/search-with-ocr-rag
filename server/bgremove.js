import fs from 'fs/promises';
import path from 'path';
import sharp from 'sharp';
import { removeBackground } from '@imgly/background-removal-node';

const DEFAULT_CONCURRENCY = 2;

/**
 * Pool simples de concorrência para batch (sem Go/Rust por enquanto).
 */
export async function mapPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;

  async function run() {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  }

  const runners = Array.from({ length: Math.min(concurrency, items.length) || 1 }, () => run());
  await Promise.all(runners);
  return results;
}

/**
 * Remove fundo preservando resolução: PNG lossless + trim leve só no alpha.
 * Se a imagem já tiver transparência útil, apenas padroniza para PNG.
 */
export async function removeBackgroundKeepQuality(inputPath, outputPath, { model = 'medium' } = {}) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  const inputMeta = await sharp(inputPath, { failOn: 'none' }).metadata();
  const alreadyTransparent = Boolean(inputMeta.hasAlpha);

  let buffer;

  if (alreadyTransparent) {
    // Já sem fundo: só garante PNG sem recompressão destrutiva
    buffer = await sharp(inputPath, { failOn: 'none' })
      .ensureAlpha()
      .png({ compressionLevel: 6, effort: 7 })
      .toBuffer();
  } else {
    const blob = await removeBackground(inputPath, {
      model,
      debug: false,
      output: {
        format: 'image/png',
        quality: 1,
        type: 'foreground',
      },
    });
    buffer = Buffer.from(await blob.arrayBuffer());

    // Preserva tamanho original do produto (sem downscale). Trim só remove padding vazio.
    buffer = await sharp(buffer, { failOn: 'none' })
      .ensureAlpha()
      .trim({ threshold: 8 })
      .png({ compressionLevel: 6, effort: 7 })
      .toBuffer();
  }

  await fs.writeFile(outputPath, buffer);
  const meta = await sharp(buffer, { failOn: 'none' }).metadata();

  return {
    file: path.basename(outputPath),
    path: outputPath,
    width: meta.width || 0,
    height: meta.height || 0,
    bytes: buffer.length,
    hasAlpha: true,
    skippedModel: alreadyTransparent,
  };
}

export async function processProductBackgrounds({
  productName,
  folder,
  originals,
  concurrency = DEFAULT_CONCURRENCY,
  model = 'medium',
  onProgress,
}) {
  const nobgDir = path.join(folder, 'nobg');
  await fs.mkdir(nobgDir, { recursive: true });

  const processed = await mapPool(originals, concurrency, async (item, index) => {
    const base = path.parse(item.file).name;
    const outFile = `${base}.png`;
    const outPath = path.join(nobgDir, outFile);

    onProgress?.({
      type: 'bg_start',
      product: productName,
      file: item.file,
      index: index + 1,
      total: originals.length,
    });

    try {
      const result = await removeBackgroundKeepQuality(item.path, outPath, { model });
      const payload = {
        ...result,
        originalFile: item.file,
        originalUrl: `/downloads/${encodeURIComponent(path.basename(folder))}/original/${encodeURIComponent(item.file)}`,
        nobgUrl: `/downloads/${encodeURIComponent(path.basename(folder))}/nobg/${encodeURIComponent(result.file)}`,
      };

      onProgress?.({
        type: 'bg_done',
        product: productName,
        ...payload,
        index: index + 1,
        total: originals.length,
      });

      return { ok: true, ...payload };
    } catch (err) {
      onProgress?.({
        type: 'bg_error',
        product: productName,
        file: item.file,
        reason: err.message,
        index: index + 1,
        total: originals.length,
      });
      return { ok: false, originalFile: item.file, reason: err.message };
    }
  });

  return {
    nobgDir,
    cutouts: processed.filter((p) => p.ok),
    errors: processed.filter((p) => !p.ok),
  };
}

export { DEFAULT_CONCURRENCY };

const els = {
  status: document.getElementById('statusCard'),
  products: document.getElementById('productsInput'),
  model: document.getElementById('modelSelect'),
  modelHint: document.getElementById('modelHint'),
  useAi: document.getElementById('useAi'),
  btnTerms: document.getElementById('btnTerms'),
  btnStart: document.getElementById('btnStart'),
  btnStop: document.getElementById('btnStop'),
  btnRefreshGallery: document.getElementById('btnRefreshGallery'),
  termsBody: document.getElementById('termsBody'),
  perProduct: document.getElementById('perProduct'),
  minWidth: document.getElementById('minWidth'),
  delayMs: document.getElementById('delayMs'),
  removeBg: document.getElementById('removeBg'),
  bgConcurrency: document.getElementById('bgConcurrency'),
  bgModel: document.getElementById('bgModel'),
  log: document.getElementById('log'),
  progressMeta: document.getElementById('progressMeta'),
  results: document.getElementById('results'),
  modal: document.getElementById('galleryModal'),
  modalTitle: document.getElementById('modalTitle'),
  modalMeta: document.getElementById('modalMeta'),
  modalGrid: document.getElementById('modalGrid'),
  bankStatus: document.getElementById('bankStatus'),
  bankWithOcr: document.getElementById('bankWithOcr'),
  bankWithEmbed: document.getElementById('bankWithEmbed'),
  btnBankIndex: document.getElementById('btnBankIndex'),
  btnPurgeWatermarks: document.getElementById('btnPurgeWatermarks'),
  btnBankClear: document.getElementById('btnBankClear'),
  btnBankHealth: document.getElementById('btnBankHealth'),
  bankQuery: document.getElementById('bankQuery'),
  bankKind: document.getElementById('bankKind'),
  bankLimit: document.getElementById('bankLimit'),
  bankFolder: document.getElementById('bankFolder'),
  btnBankSearch: document.getElementById('btnBankSearch'),
  bankRequest: document.getElementById('bankRequest'),
  bankMeta: document.getElementById('bankMeta'),
  bankHits: document.getElementById('bankHits'),
  bankJson: document.getElementById('bankJson'),
  resolveQuery: document.getElementById('resolveQuery'),
  resolveLimit: document.getElementById('resolveLimit'),
  resolveOffset: document.getElementById('resolveOffset'),
  resolveKind: document.getElementById('resolveKind'),
  resolveScrape: document.getElementById('resolveScrape'),
  btnResolve: document.getElementById('btnResolve'),
  btnResolveMore: document.getElementById('btnResolveMore'),
  imageSearchFile: document.getElementById('imageSearchFile'),
  imageSearchProduct: document.getElementById('imageSearchProduct'),
  imageSearchPreview: document.getElementById('imageSearchPreview'),
  btnImagePreview: document.getElementById('btnImagePreview'),
  btnImageScrape: document.getElementById('btnImageScrape'),
};

let rows = [];
let abortController = null;
let userPickedModel = false;
let galleryCache = new Map();
let modalState = { folder: null, tab: 'nobg', data: null };

document.querySelectorAll('.view-tab[data-view]').forEach((tab) => {
  tab.addEventListener('click', () => {
    const view = tab.dataset.view;
    document.querySelectorAll('.view-tab[data-view]').forEach((t) => t.classList.toggle('active', t === tab));
    document.getElementById('view-scraper').classList.toggle('hidden', view !== 'scraper');
    document.getElementById('view-bank').classList.toggle('hidden', view !== 'bank');
    if (view === 'bank') refreshBankHealth();
  });
});

els.model.addEventListener('change', () => {
  userPickedModel = Boolean(els.model.value);
});

els.useAi.addEventListener('change', syncModelControls);

document.querySelectorAll('[data-close-modal]').forEach((el) => {
  el.addEventListener('click', closeModal);
});

document.querySelectorAll('.modal-tabs .tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.modal-tabs .tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    modalState.tab = tab.dataset.tab;
    renderModalGrid();
  });
});

els.btnRefreshGallery.addEventListener('click', () => loadGalleryCards({ force: true }));

els.imageSearchFile?.addEventListener('change', () => {
  const file = els.imageSearchFile.files?.[0];
  if (!file) {
    els.imageSearchPreview.innerHTML = 'Nenhuma imagem selecionada.';
    return;
  }
  const url = URL.createObjectURL(file);
  els.imageSearchPreview.innerHTML = `<img src="${url}" alt="preview" /><span>${escapeHtml(file.name)} · ${(file.size / 1024).toFixed(0)} KB</span>`;
});

function buildImageFormData() {
  const file = els.imageSearchFile?.files?.[0];
  if (!file) throw new Error('Selecione uma imagem.');
  const fd = new FormData();
  fd.append('image', file);
  if (els.imageSearchProduct.value.trim()) {
    fd.append('product', els.imageSearchProduct.value.trim());
  }
  fd.append('useAi', els.useAi.checked ? 'true' : 'false');
  if (els.model.value.trim()) fd.append('model', els.model.value.trim());
  fd.append('perProduct', String(els.perProduct.value || 10));
  fd.append('minWidth', String(els.minWidth.value || 400));
  fd.append('removeBg', els.removeBg.checked ? 'true' : 'false');
  fd.append('bgConcurrency', String(els.bgConcurrency.value || 2));
  fd.append('bgModel', els.bgModel.value || 'medium');
  return fd;
}

els.btnImagePreview?.addEventListener('click', async () => {
  try {
    const fd = buildImageFormData();
    els.btnImagePreview.disabled = true;
    els.btnImagePreview.textContent = 'Analisando…';
    log('Analisando imagem (OCR + termo)…');
    const res = await fetch('/api/search-by-image', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Falha na análise');
    if (!els.imageSearchProduct.value.trim()) {
      els.imageSearchProduct.value = data.product || '';
    }
    log(`OCR: ${data.ocrText || '(vazio)'}`);
    log(`Termo: ${data.searchTerm} (${data.source})`);
    log(`Candidatos: ${data.candidates?.length || 0}`);
    els.progressMeta.textContent = `Imagem → "${data.searchTerm}" · ${data.candidates?.length || 0} candidatos`;
  } catch (err) {
    alert(err.message);
    log(`Erro imagem: ${err.message}`);
  } finally {
    els.btnImagePreview.disabled = false;
    els.btnImagePreview.textContent = 'Só analisar (OCR)';
  }
});

els.btnImageScrape?.addEventListener('click', async () => {
  try {
    const fd = buildImageFormData();
    els.results.innerHTML = '';
    els.log.textContent = '';
    els.btnImageScrape.disabled = true;
    els.btnTerms.disabled = true;
    els.btnStart.disabled = true;
    els.btnStop.disabled = false;
    abortController = new AbortController();
    log('Busca por imagem iniciada…');

    const res = await fetch('/api/scrape-by-image', {
      method: 'POST',
      body: fd,
      signal: abortController.signal,
    });
    if (!res.ok || !res.body) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Falha ao buscar por imagem');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() || '';
      for (const chunk of parts) handleSseChunk(chunk);
    }
  } catch (err) {
    if (err.name === 'AbortError') log('Cancelado.');
    else {
      log(`Erro: ${err.message}`);
      alert(err.message);
    }
  } finally {
    els.btnImageScrape.disabled = false;
    els.btnTerms.disabled = false;
    els.btnStart.disabled = !rows.length;
    els.btnStop.disabled = true;
    abortController = null;
    await loadGalleryCards({ force: true });
  }
});

function syncModelControls() {
  const hasModels = [...els.model.options].some((o) => o.value);
  els.model.disabled = !els.useAi.checked || !hasModels;
}

function log(message) {
  const time = new Date().toLocaleTimeString('pt-BR');
  els.log.textContent += `[${time}] ${message}\n`;
  els.log.scrollTop = els.log.scrollHeight;
}

function setStatus(html, kind) {
  els.status.className = `status-card ${kind || ''}`;
  els.status.innerHTML = html;
}

function populateModelSelect(ollama) {
  const details = ollama?.modelsDetail?.length
    ? ollama.modelsDetail
    : (ollama?.models || []).map((name) => ({ name, sizeLabel: null }));

  const previous = els.model.value;
  els.model.innerHTML = '';

  if (!details.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'Nenhum modelo instalado — rode: ollama pull qwen2.5:3b';
    els.model.appendChild(opt);
    els.model.disabled = true;
    els.modelHint.textContent = 'Nenhum modelo detectado. Instale com: ollama pull qwen2.5:3b';
    return;
  }

  for (const model of details) {
    const opt = document.createElement('option');
    opt.value = model.name;
    const bits = [model.name];
    if (model.parameterSize) bits.push(model.parameterSize);
    if (model.sizeLabel) bits.push(model.sizeLabel);
    if (model.quantization) bits.push(model.quantization);
    opt.textContent = bits.join(' · ');
    els.model.appendChild(opt);
  }

  const preferred = ollama.selected || details[0].name;
  if (userPickedModel && details.some((m) => m.name === previous)) {
    els.model.value = previous;
  } else {
    els.model.value = preferred;
    userPickedModel = false;
  }

  els.modelHint.textContent = `${details.length} modelo(s) detectado(s) no Ollama.`;
  syncModelControls();
}

async function refreshHealth() {
  try {
    const res = await fetch('/api/health');
    const data = await res.json();
    if (data.ollama?.ok) populateModelSelect(data.ollama);
    else populateModelSelect({ models: [], modelsDetail: [] });

    const bankOk = data.bank?.ok;
    const ollamaOk = data.ollama?.ok;
    setStatus(
      `<strong>Serviços</strong><br>Ollama: ${ollamaOk ? 'OK' : 'offline'} · Banco: ${bankOk ? `OK (${data.bank.documents} docs)` : 'offline'}<br>${els.model.value || 'sem modelo'}`,
      ollamaOk || bankOk ? 'ok' : 'bad'
    );
    if (els.bankStatus) renderBankStatus(data.bank);
  } catch {
    populateModelSelect({ models: [], modelsDetail: [] });
    setStatus('<strong>Servidor offline</strong><br>Rode npm start ou docker compose up', 'bad');
  }
}

function renderBankStatus(bank) {
  if (!bank || !els.bankStatus) return;
  if (bank.ok) {
    const rag = bank.rag;
    const ragLine = rag?.ok
      ? `RAG OK · ${escapeHtml(rag.model)} (${rag.dimensions}d)`
      : `RAG off · ${escapeHtml(rag?.hint || 'ollama pull nomic-embed-text')}`;
    els.bankStatus.className = 'bank-status ok';
    els.bankStatus.innerHTML = `<strong>Meilisearch OK</strong><br>Host: ${escapeHtml(bank.host)}<br>Índice: ${escapeHtml(bank.index)} · ${bank.documents} documento(s)<br>${ragLine}`;
  } else {
    els.bankStatus.className = 'bank-status bad';
    els.bankStatus.innerHTML = `<strong>Meilisearch offline</strong><br>${escapeHtml(bank.error || 'Indisponível')}<br>Rode: <code>docker compose up -d meilisearch</code>`;
  }
}

async function refreshBankHealth() {
  try {
    const res = await fetch('/api/bank/health');
    renderBankStatus(await res.json());
  } catch (err) {
    renderBankStatus({ ok: false, error: err.message, host: '-', index: '-' });
  }
}

els.btnBankHealth?.addEventListener('click', refreshBankHealth);

els.btnPurgeWatermarks?.addEventListener('click', async () => {
  if (!confirm('Varrer downloads e apagar imagens com marca d\'água / stock?')) return;
  els.btnPurgeWatermarks.disabled = true;
  els.btnPurgeWatermarks.textContent = 'Limpando…';
  els.bankMeta.textContent = 'Detectando marcas d\'água…';
  try {
    const res = await fetch('/api/purge-watermarks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const data = await res.json();
    els.bankJson.textContent = JSON.stringify(data, null, 2);
    if (!res.ok || data.ok === false) throw new Error(data.error || 'Falha ao limpar');
    els.bankMeta.textContent = `Removidas ${data.removed} · mantidas ${data.kept} · pastas ${data.scannedFolders}`;
    await loadGalleryCards({ force: true });
    await refreshBankHealth();
  } catch (err) {
    alert(err.message);
    els.bankMeta.textContent = err.message;
  } finally {
    els.btnPurgeWatermarks.disabled = false;
    els.btnPurgeWatermarks.textContent = "Remover marcas d'água";
  }
});

els.btnBankIndex?.addEventListener('click', async () => {
  els.btnBankIndex.disabled = true;
  els.btnBankIndex.textContent = 'Indexando…';
  try {
    const res = await fetch('/api/bank/index', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        withOcr: els.bankWithOcr?.checked !== false,
        withEmbeddings: els.bankWithEmbed?.checked !== false,
      }),
    });
    const data = await res.json();
    els.bankJson.textContent = JSON.stringify(data, null, 2);
    if (!res.ok) throw new Error(data.error || 'Falha ao indexar');
    els.bankMeta.textContent = `Indexados ${data.indexed} · OCR novos ${data.ocrCount || 0} · cache ${data.ocrCached || 0} · embeds ${data.embedCount || 0}`;
    await refreshBankHealth();
  } catch (err) {
    alert(err.message);
  } finally {
    els.btnBankIndex.disabled = false;
    els.btnBankIndex.textContent = 'Indexar downloads';
  }
});

els.btnBankClear?.addEventListener('click', async () => {
  if (!confirm('Limpar todo o índice do Meilisearch? (arquivos em disco permanecem)')) return;
  try {
    const res = await fetch('/api/bank/index', { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Falha ao limpar');
    els.bankHits.innerHTML = '';
    els.bankJson.textContent = JSON.stringify(data, null, 2);
    els.bankMeta.textContent = 'Índice limpo.';
    await refreshBankHealth();
  } catch (err) {
    alert(err.message);
  }
});

els.btnBankSearch?.addEventListener('click', async () => {
  const params = new URLSearchParams();
  params.set('q', els.bankQuery.value.trim());
  params.set('limit', String(els.bankLimit.value || 12));
  if (els.bankKind.value) params.set('kind', els.bankKind.value);
  if (els.bankFolder.value.trim()) params.set('folder', els.bankFolder.value.trim());

  const url = `/api/bank/search?${params.toString()}`;
  els.bankRequest.textContent = `GET ${url}`;
  els.btnBankSearch.disabled = true;

  try {
    const res = await fetch(url);
    const data = await res.json();
    els.bankJson.textContent = JSON.stringify(data, null, 2);
    if (!res.ok) throw new Error(data.error || data.hint || 'Falha na busca');

    els.bankMeta.textContent = `${data.estimatedTotalHits} hit(s) · ${data.processingTimeMs} ms`;
    renderBankHits(data.hits || []);
  } catch (err) {
    els.bankMeta.textContent = err.message;
    els.bankHits.innerHTML = '';
  } finally {
    els.btnBankSearch.disabled = false;
  }
});

let resolveState = { offset: 0, query: '', hasMore: false };

function renderBankHits(hits) {
  els.bankHits.innerHTML =
    (hits || [])
      .map(
        (hit) => `
        <a class="modal-item" href="${hit.url}" target="_blank" rel="noopener">
          <img src="${hit.url}" alt="${escapeAttr(hit.file || hit.product)}" loading="lazy" />
          <p><strong>${escapeHtml(hit.product)}</strong> · ${escapeHtml(hit.kind || '')}<br>${escapeHtml(hit.file || '')}<br>${hit.width || 0}x${hit.height || 0}${hit.ocrText ? `<br><em>${escapeHtml(String(hit.ocrText).slice(0, 80))}</em>` : ''}${hit.tags?.length ? `<br><small>${escapeHtml(hit.tags.slice(0, 6).join(', '))}</small>` : ''}</p>
        </a>`
      )
      .join('') || '<p class="hint">Nenhum resultado.</p>';
}

async function runResolve({ append = false } = {}) {
  const q = els.resolveQuery.value.trim();
  if (!q) {
    alert('Informe um produto.');
    return;
  }

  const limit = Math.min(Number(els.resolveLimit.value) || 10, 10);
  const offset = append ? resolveState.offset : Number(els.resolveOffset.value) || 0;

  const payload = {
    q,
    limit,
    offset,
    kind: els.resolveKind.value || 'nobg',
    scrapeIfMissing: els.resolveScrape.checked,
  };

  els.bankRequest.textContent = `POST /api/resolve\n${JSON.stringify(payload, null, 2)}`;
  els.btnResolve.disabled = true;
  els.btnResolveMore.disabled = true;
  els.btnResolve.textContent = append ? 'Buscando mais…' : 'Resolvendo…';
  els.bankMeta.textContent = 'Aguarde (banco ou scrape)…';

  try {
    const res = await fetch('/api/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    els.bankJson.textContent = JSON.stringify(data, null, 2);
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || data.message || 'Falha no resolve');
    }

    resolveState = {
      offset: offset + (data.images?.length || 0),
      query: q,
      hasMore: Boolean(data.hasMore),
    };
    els.resolveOffset.value = String(resolveState.offset);

    els.bankMeta.textContent = `${data.source} · ${data.images?.length || 0} imagem(ns) · total ${data.total || 0}${data.hasMore ? ' · tem mais' : ''}`;
    renderBankHits(data.images || []);
    els.btnResolveMore.disabled = !data.hasMore;
  } catch (err) {
    els.bankMeta.textContent = err.message;
    if (!append) els.bankHits.innerHTML = '';
    els.btnResolveMore.disabled = true;
  } finally {
    els.btnResolve.disabled = false;
    els.btnResolve.textContent = 'Resolver';
  }
}

els.btnResolve?.addEventListener('click', () => runResolve({ append: false }));
els.btnResolveMore?.addEventListener('click', () => runResolve({ append: true }));

function renderTerms() {
  if (!rows.length) {
    els.termsBody.innerHTML = '<tr class="empty"><td colspan="3">Gere os termos para ver a lista aqui.</td></tr>';
    els.btnStart.disabled = true;
    return;
  }

  els.termsBody.innerHTML = rows
    .map(
      (row, i) => `
      <tr>
        <td>${escapeHtml(row.product)}</td>
        <td><input data-i="${i}" class="term-input" type="text" value="${escapeAttr(row.searchTerm)}" /></td>
        <td><span class="badge ${row.source === 'fallback' ? 'fallback' : ''}">${row.source}</span></td>
      </tr>`
    )
    .join('');

  els.termsBody.querySelectorAll('.term-input').forEach((input) => {
    input.addEventListener('input', (e) => {
      rows[Number(e.target.dataset.i)].searchTerm = e.target.value;
    });
  });

  els.btnStart.disabled = false;
}

function escapeHtml(str) {
  return String(str).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function escapeAttr(str) {
  return escapeHtml(str).replaceAll('"', '&quot;');
}

els.btnTerms.addEventListener('click', async () => {
  if (!els.products.value.trim()) {
    alert('Cole ao menos um produto.');
    return;
  }

  els.btnTerms.disabled = true;
  els.btnTerms.textContent = 'Gerando…';
  log('Gerando termos de busca…');

  try {
    const res = await fetch('/api/generate-terms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        products: els.products.value,
        model: els.model.value.trim() || undefined,
        useAi: els.useAi.checked,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Falha ao gerar termos');
    rows = data.rows;
    renderTerms();
    log(`Termos prontos: ${rows.length} produto(s).`);
  } catch (err) {
    log(`Erro: ${err.message}`);
    alert(err.message);
  } finally {
    els.btnTerms.disabled = false;
    els.btnTerms.textContent = 'Gerar termos com IA';
  }
});

els.btnStart.addEventListener('click', async () => {
  if (!rows.length) return;
  els.results.innerHTML = '';
  els.log.textContent = '';
  els.btnStart.disabled = true;
  els.btnTerms.disabled = true;
  els.btnStop.disabled = false;
  abortController = new AbortController();

  try {
    const res = await fetch('/api/scrape', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: rows,
        perProduct: Number(els.perProduct.value) || 10,
        minWidth: Number(els.minWidth.value) || 400,
        delayMs: Number(els.delayMs.value) || 1200,
        removeBg: els.removeBg.checked,
        bgConcurrency: Number(els.bgConcurrency.value) || 2,
        bgModel: els.bgModel.value || 'medium',
      }),
      signal: abortController.signal,
    });
    if (!res.ok || !res.body) throw new Error('Falha ao iniciar scraping');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() || '';
      for (const chunk of parts) handleSseChunk(chunk);
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      log('Cancelado pelo usuário.');
      els.progressMeta.textContent = 'Cancelado';
    } else {
      log(`Erro: ${err.message}`);
    }
  } finally {
    els.btnStart.disabled = !rows.length;
    els.btnTerms.disabled = false;
    els.btnStop.disabled = true;
    abortController = null;
    await loadGalleryCards({ force: true });
  }
});

els.btnStop.addEventListener('click', () => abortController?.abort());

function handleSseChunk(chunk) {
  const lines = chunk.split('\n');
  let event = 'message';
  let data = '';
  for (const line of lines) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    if (line.startsWith('data:')) data += line.slice(5).trim();
  }
  if (!data) return;
  let payload;
  try {
    payload = JSON.parse(data);
  } catch {
    return;
  }

  switch (event) {
    case 'merged':
      log(`Pastas mescladas: ${(payload.merges || []).map((m) => `${m.from}→${m.to}`).join(', ') || '—'}`);
      break;
    case 'image_query':
      log(`Imagem → OCR: ${payload.ocrText || '(vazio)'}`);
      log(`Termo gerado (${payload.source}): ${payload.searchTerm}`);
      if (payload.product && els.imageSearchProduct && !els.imageSearchProduct.value.trim()) {
        els.imageSearchProduct.value = payload.product;
      }
      break;
    case 'start':
      log('Scraping iniciado.');
      els.progressMeta.textContent = `Processando ${payload.total} · ${payload.perProduct} img`;
      break;
    case 'product_start':
      log(`(${payload.index + 1}/${payload.total}) ${payload.product}`);
      break;
    case 'candidates':
      log(`  ${payload.count} candidatos`);
      break;
    case 'bg_batch_start':
      log(`  Removendo fundo (${payload.total} imgs)…`);
      break;
    case 'progress':
      if (payload.type === 'saved') log(`  ✓ ${payload.file}`);
      if (payload.type === 'bg_done') log(`  ✓ nobg ${payload.file}`);
      if (payload.type === 'bg_error') log(`  ✗ BG ${payload.file}: ${payload.reason}`);
      break;
    case 'product_done':
      renderResultCard(payload);
      log(`  concluído: ${payload.saved?.length || 0} orig / ${payload.cutouts?.length || 0} nobg`);
      break;
    case 'complete':
      els.progressMeta.textContent = `Concluído: ${payload.totalImages} orig · ${payload.totalCutouts || 0} nobg`;
      log('Finalizado. Abra Banco API → Indexar downloads');
      break;
    case 'error':
      log(`Erro: ${payload.error}`);
      break;
  }
}

function renderResultCard(payload) {
  const folder = payload.folder || folderName(payload.product);
  const origCount = payload.saved?.length ?? payload.counts?.originals ?? 0;
  const cutCount = payload.cutouts?.length ?? payload.counts?.cutouts ?? 0;
  const thumbs = (payload.cutouts?.length ? payload.cutouts : payload.saved || [])
    .slice(0, 4)
    .map((s) => {
      const url =
        s.nobgUrl ||
        s.publicUrl ||
        s.url ||
        `/downloads/${encodeURIComponent(folder)}/${s.file.includes('/') ? s.file : `original/${s.file}`}`;
      return `<img src="${url}" alt="" loading="lazy" />`;
    })
    .join('');

  const card = document.createElement('div');
  card.className = 'card';
  card.dataset.folder = folder;
  card.innerHTML = `
    <h3>${escapeHtml(payload.product)}</h3>
    <p class="hint">${origCount} originais · ${cutCount} sem fundo · pasta <code>${escapeHtml(folder)}</code></p>
    <div class="thumb-row">${thumbs || '<span class="hint">Sem preview</span>'}</div>
    <div class="card-actions">
      <button type="button" class="btn accent" data-action="gallery">Ver galeria</button>
      <button type="button" class="btn primary" data-action="research">Nova busca</button>
      <button type="button" class="btn ghost danger" data-action="delete">Apagar</button>
    </div>`;

  card.querySelector('[data-action="gallery"]')?.addEventListener('click', () => openGallery(folder));
  card.querySelector('[data-action="research"]')?.addEventListener('click', () => researchProduct(folder));
  card.querySelector('[data-action="delete"]')?.addEventListener('click', () => deleteProduct(folder));
  els.results.prepend(card);
}

async function loadGalleryCards({ force = false } = {}) {
  try {
    const res = await fetch('/api/products');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Falha ao listar');
    galleryCache = new Map((data.products || []).map((p) => [p.folder, p]));

    if (force || !els.results.children.length) {
      els.results.innerHTML = '';
      for (const product of data.products || []) {
        renderResultCard({
          product: product.product,
          folder: product.folder,
          saved: product.originals,
          cutouts: product.cutouts.map((c) => ({ ...c, nobgUrl: c.url })),
          counts: product.counts,
        });
      }
    }
  } catch (err) {
    log(`Galeria: ${err.message}`);
  }
}

async function deleteProduct(folder) {
  if (!confirm(`Apagar o grupo "${folder}" e todas as imagens?`)) return;
  try {
    const res = await fetch(`/api/products/${encodeURIComponent(folder)}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Falha ao apagar');
    log(`Grupo apagado: ${folder}`);
    closeModal();
    await loadGalleryCards({ force: true });
  } catch (err) {
    alert(err.message);
  }
}

async function researchProduct(folder) {
  if (!confirm(`Rodar nova busca para "${folder}"? As imagens novas entram no mesmo grupo.`)) return;
  closeModal();
  els.log.textContent = '';
  els.progressMeta.textContent = `Nova busca: ${folder}`;
  log(`Nova busca para ${folder}…`);
  els.btnStart.disabled = true;
  els.btnTerms.disabled = true;
  els.btnStop.disabled = false;
  abortController = new AbortController();

  try {
    const res = await fetch(`/api/products/${encodeURIComponent(folder)}/research`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        useAi: els.useAi.checked,
        model: els.model.value.trim() || undefined,
        perProduct: Number(els.perProduct.value) || 10,
        minWidth: Number(els.minWidth.value) || 400,
        removeBg: els.removeBg.checked,
        bgConcurrency: Number(els.bgConcurrency.value) || 2,
        bgModel: els.bgModel.value || 'medium',
      }),
      signal: abortController.signal,
    });
    if (!res.ok || !res.body) throw new Error('Falha ao iniciar nova busca');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() || '';
      for (const chunk of parts) handleSseChunk(chunk);
    }
  } catch (err) {
    if (err.name === 'AbortError') log('Cancelado.');
    else {
      log(`Erro: ${err.message}`);
      alert(err.message);
    }
  } finally {
    els.btnStart.disabled = !rows.length;
    els.btnTerms.disabled = false;
    els.btnStop.disabled = true;
    abortController = null;
    await loadGalleryCards({ force: true });
  }
}

async function openGallery(folder) {
  try {
    const res = await fetch(`/api/products/${encodeURIComponent(folder)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Não encontrado');
    modalState = { folder, tab: 'nobg', data };
    els.modalTitle.textContent = data.product;
    els.modalMeta.textContent = `${data.counts.originals} originais · ${data.counts.cutouts} sem fundo · ${data.folder}`;
    document.querySelectorAll('.modal-tabs .tab').forEach((t) => {
      t.classList.toggle('active', t.dataset.tab === 'nobg');
    });
    renderModalGrid();
    const actions = document.getElementById('modalActions');
    if (actions) {
      actions.innerHTML = `
        <button type="button" class="btn primary" data-modal-research>Nova busca</button>
        <button type="button" class="btn ghost danger" data-modal-delete>Apagar grupo</button>
        <button type="button" class="btn ghost" data-close-modal>Fechar</button>`;
      actions.querySelector('[data-modal-research]')?.addEventListener('click', () => researchProduct(folder));
      actions.querySelector('[data-modal-delete]')?.addEventListener('click', () => deleteProduct(folder));
      actions.querySelector('[data-close-modal]')?.addEventListener('click', closeModal);
    }
    els.modal.classList.remove('hidden');
    els.modal.setAttribute('aria-hidden', 'false');
  } catch (err) {
    alert(err.message);
  }
}

function renderModalGrid() {
  const data = modalState.data;
  if (!data) return;
  const list = modalState.tab === 'original' ? data.originals : data.cutouts;
  els.modalGrid.innerHTML = list.length
    ? list
        .map(
          (img) => `
      <a class="modal-item" href="${img.url}" target="_blank" rel="noopener">
        <img src="${img.url}" alt="${escapeAttr(img.file)}" loading="lazy" />
        <p>${escapeHtml(img.file)}<br>${img.width}x${img.height}</p>
      </a>`
        )
        .join('')
    : '<p class="hint">Nenhuma imagem nesta aba.</p>';
}

function closeModal() {
  els.modal.classList.add('hidden');
  els.modal.setAttribute('aria-hidden', 'true');
}

function folderName(name) {
  return (
    String(name || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '')
      .replace(/_(test|teste|copy|copia|novo|new|temp|tmp|bak|old|final|v2|v3)$/g, '')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '')
      .slice(0, 80) || 'produto'
  );
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModal();
});

refreshHealth();
loadGalleryCards({ force: true });
setInterval(refreshHealth, 15000);

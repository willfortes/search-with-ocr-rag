/**
 * Cliente do worker Go (downloads paralelos via SSE).
 * Se o worker estiver offline, retorna null e o Node faz fallback.
 */
const GO_WORKER_URL = (process.env.GO_WORKER_URL || 'http://127.0.0.1:3850').replace(/\/$/, '');

export async function checkGoWorker() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch(`${GO_WORKER_URL}/health`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return { ok: false };
    const data = await res.json().catch(() => ({}));
    return { ok: true, ...data, url: GO_WORKER_URL };
  } catch {
    return { ok: false, url: GO_WORKER_URL };
  }
}

/**
 * Baixa URLs em paralelo no Go e chama onItem a cada arquivo pronto.
 * @returns {{ saved: number, failed: number, items: object[] } | null}
 */
export async function downloadParallelGo({
  urls,
  outDir,
  concurrency = 8,
  minBytes = 2048,
  startIndex = 1,
  onItem,
  signal,
}) {
  const list = (urls || []).filter((u) => /^https?:\/\//i.test(String(u || '')));
  if (!list.length || !outDir) return null;

  const res = await fetch(`${GO_WORKER_URL}/v1/download`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    signal,
    body: JSON.stringify({
      urls: list,
      outDir,
      concurrency,
      minBytes,
      startIndex,
      timeoutMs: 25000,
    }),
  });

  if (!res.ok || !res.body) {
    throw new Error(`go-worker HTTP ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const items = [];
  let saved = 0;
  let failed = 0;
  let donePayload = null;

  const flushEvent = async (block) => {
    const lines = block.split(/\r?\n/);
    let event = 'message';
    const dataLines = [];
    for (const line of lines) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (!dataLines.length) return;
    let payload;
    try {
      payload = JSON.parse(dataLines.join('\n'));
    } catch {
      return;
    }
    if (event === 'item') {
      items.push(payload);
      if (payload.ok) saved += 1;
      else failed += 1;
      await Promise.resolve(onItem?.(payload));
    } else if (event === 'done') {
      donePayload = payload;
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() || '';
    for (const part of parts) {
      if (part.trim()) await flushEvent(part);
    }
  }
  if (buffer.trim()) await flushEvent(buffer);

  return {
    saved: donePayload?.saved ?? saved,
    failed: donePayload?.failed ?? failed,
    elapsedMs: donePayload?.elapsedMs || 0,
    items,
  };
}

# API — Product Image Scraper & Banco

Base URL local: `http://localhost:3847`  
OpenAPI prática: use a aba **Banco API** no dashboard.

Todos os endpoints JSON usam `Content-Type: application/json`, exceto downloads estáticos.

---

## Visão geral

| Grupo | Prefixo | Função |
|-------|---------|--------|
| Saúde | `/api/health` | Status Ollama + Meilisearch |
| **Resolve** | `/api/resolve` | **API principal**: banco → scrape (máx. 10) + validação supermercado |
| Scraper | `/api/*` | Termos IA, scraping, galeria local |
| Banco | `/api/bank/*` | Indexação, OCR, busca Meilisearch |
| Arquivos | `/downloads/*` | Imagens baixadas |

---

## API Resolve (CriarOfertas)

### `POST /api/resolve` · `GET /api/resolve`

Fluxo:

1. Valida se o termo é produto de supermercado (rejeita “caminhão”, etc.)
2. Se existir no Meilisearch/disco → devolve imagens do banco
3. Senão → scrape até **10** imagens, remove fundo, indexa e devolve
4. `offset` / “Buscar mais” pede o próximo lote

**Body / query**
```json
{
  "q": "cerveja brahma",
  "limit": 10,
  "offset": 0,
  "kind": "nobg",
  "scrapeIfMissing": true,
  "removeBg": true,
  "useAi": true
}
```

| Campo | Default | Descrição |
|-------|---------|-----------|
| `q` | — | Nome do produto (obrigatório) |
| `limit` | 10 | Máximo **10** imagens por chamada |
| `offset` | 0 | Paginação / “buscar mais” |
| `kind` | `nobg` | `nobg` \| `original` \| `any` |
| `scrapeIfMissing` | `true` | Se `false`, só consulta banco |

**Resposta 200**
```json
{
  "ok": true,
  "query": "cerveja brahma",
  "product": "brahma",
  "folder": "brahma",
  "source": "bank",
  "limit": 10,
  "offset": 0,
  "total": 4,
  "hasMore": false,
  "images": [
    {
      "id": "brahma__nobg__01_png",
      "url": "http://localhost:3847/downloads/brahma/nobg/01.png",
      "kind": "nobg",
      "tags": ["brahma", "cerveja"]
    }
  ]
}
```

**Resposta 400** — produto inválido:
```json
{
  "ok": false,
  "reason": "not_supermarket",
  "error": "\"caminhão\" não é um produto de supermercado."
}
```

### `POST /api/validate-product`

Só valida, sem buscar imagens.

---

## Saúde

### `GET /api/health`

Retorna status geral.

**Resposta 200**
```json
{
  "ok": true,
  "ollama": { "ok": true, "models": ["qwen2.5:3b"], "selected": "qwen2.5:3b" },
  "bank": { "ok": true, "host": "http://meilisearch:7700", "documents": 42 },
  "features": {
    "backgroundRemoval": true,
    "gallery": true,
    "imageBank": true,
    "ocr": true
  }
}
```

### `GET /api/bank/health`

Só o Meilisearch / índice.

**Resposta 200**
```json
{
  "ok": true,
  "host": "http://127.0.0.1:7700",
  "index": "product_images",
  "documents": 42,
  "isIndexing": false
}
```

**Resposta 503** — Meilisearch offline.

---

## Scraper & galeria local

### `GET /api/models`

Lista modelos Ollama disponíveis.

### `POST /api/generate-terms`

Gera termos de busca com IA local.

**Body**
```json
{
  "products": "Brahma Lata\nArroz Tio João 5kg",
  "model": "qwen2.5:3b",
  "useAi": true
}
```

**Resposta**
```json
{
  "rows": [
    { "product": "Brahma Lata", "searchTerm": "brahma lata packshot png...", "source": "ollama" }
  ]
}
```

### `POST /api/scrape`

SSE (`text/event-stream`). Baixa imagens e opcionalmente remove fundo.

**Body**
```json
{
  "items": [{ "product": "brahma", "searchTerm": "brahma lata packshot png" }],
  "perProduct": 10,
  "minWidth": 400,
  "delayMs": 1200,
  "removeBg": true,
  "bgConcurrency": 2,
  "bgModel": "medium"
}
```

**Eventos SSE:** `start`, `product_start`, `candidates`, `progress`, `bg_batch_start`, `product_done`, `complete`, `error`.

### `GET /api/products`

Lista produtos em `downloads/` (originais + nobg).

### `POST /api/search-by-image`

Busca por imagem (multipart). Faz OCR da embalagem, monta termo e lista candidatos no Bing (sem baixar).

**Body (`multipart/form-data`)**
| Campo | Tipo | Descrição |
|-------|------|-----------|
| `image` | file | Obrigatório |
| `product` | string | Nome/dica opcional |
| `useAi` | string | `true`/`false` |
| `model` | string | Modelo Ollama |

**Resposta**
```json
{
  "product": "brahma",
  "searchTerm": "brahma chopp 350ml packshot...",
  "ocrText": "BRAHMA CHOPP 350ml",
  "source": "ocr+ollama",
  "candidates": [{ "url": "...", "width": 0, "height": 0 }]
}
```

### `POST /api/scrape-by-image`

Igual ao search-by-image, mas segue com download + remoção de fundo via SSE (mesmo fluxo de `/api/scrape`).


Apaga o grupo de imagens (pasta canônica) e tenta remover docs do Meilisearch.

### `POST /api/products/merge`

Mescla pastas duplicadas no disco (`brahma_test` → `brahma`).

### `POST /api/products/:folder/research`

Nova busca SSE para o mesmo grupo (append de imagens). Body igual ao scrape (parcial).

---

## Banco de imagens (Meilisearch + OCR)

Fluxo típico:

1. Scraping gera `downloads/<produto>/original` e `nobg`
2. `POST /api/bank/index` indexa no Meilisearch
3. `GET /api/bank/search?q=brahma` busca para o CriarOfertas

### `POST /api/bank/index`

Indexa `downloads/` com **OCR em todas as imagens** (cache em `.ocr-cache.json`) e **embeddings RAG** quando houver modelo Ollama (`nomic-embed-text`).

**Body**
```json
{
  "withOcr": true,
  "withEmbeddings": true,
  "folder": null
}
```

| Campo | Default | Descrição |
|-------|---------|-----------|
| `withOcr` | `true` | OCR Tesseract (por+eng) em **cada** imagem |
| `withEmbeddings` | `true` | Gera vetores para busca híbrida (RAG) |
| `folder` | null | Se informado, indexa só esse produto |

Busca (`GET /api/bank/search` e `/api/resolve`) usa modo **hybrid** (keyword + semântico) quando embeddings estão disponíveis.

**Resposta**
```json
{
  "indexed": 20,
  "products": 2,
  "ocrCount": 0,
  "withOcr": false
}
```

### `GET /api/bank/search`

Busca full-text (nome do produto, arquivo, OCR, tags).

**Query**
| Param | Descrição |
|-------|-----------|
| `q` | Texto da busca |
| `limit` | 1–100 (default 20) |
| `kind` | `original` \| `nobg` \| `legacy` |
| `folder` | Filtra por pasta do produto |

**Exemplo**
```http
GET /api/bank/search?q=brahma%20lata&kind=nobg&limit=10
```

**Resposta**
```json
{
  "query": "brahma lata",
  "estimatedTotalHits": 8,
  "processingTimeMs": 3,
  "hits": [
    {
      "id": "brahma__nobg__01_452x833.png",
      "product": "brahma",
      "folder": "brahma",
      "file": "01_452x833.png",
      "kind": "nobg",
      "url": "/downloads/brahma/nobg/01_452x833.png",
      "width": 452,
      "height": 833,
      "ocrText": "BRAHMA CHOPP 350ml",
      "tags": ["brahma", "nobg"]
    }
  ]
}
```

### `GET /api/bank/documents/:id`

Retorna um documento pelo id do índice.

### `DELETE /api/bank/index`

Apaga todos os documentos do índice (não apaga arquivos em disco).

### `POST /api/bank/ocr`

OCR pontual em um arquivo.

**Body**
```json
{
  "folder": "brahma",
  "kind": "nobg",
  "file": "01_452x833.png"
}
```

**Resposta**
```json
{
  "folder": "brahma",
  "kind": "nobg",
  "file": "01_452x833.png",
  "ocrText": "BRAHMA CHOPP 350 ML"
}
```

### `GET /api/bank/preview/:folder`

Atalho de preview da galeria local (mesmo que `/api/products/:folder`).

---

## Arquivos estáticos

```http
GET /downloads/<folder>/original/<file>
GET /downloads/<folder>/nobg/<file>
```

Use a `url` retornada nos hits do banco (já relativa à base).

---

## Integração no CriarOfertas

Exemplo mínimo:

```js
const res = await fetch('http://localhost:3847/api/bank/search?q=' + encodeURIComponent(nomeProduto) + '&kind=nobg&limit=12');
const { hits } = await res.json();
const imagens = hits.map(h => 'http://localhost:3847' + h.url);
```

---

## Docker

```bash
docker compose up -d --build
```

| Serviço | Porta |
|---------|-------|
| App / Dashboard | `3847` |
| Meilisearch | `7700` |

Variáveis: veja `.env.example`.

Ollama continua no host por padrão (`host.docker.internal:11434`).  
Para Ollama no compose: `docker compose --profile ollama up -d`.

---

## Códigos de erro comuns

| Código | Quando |
|--------|--------|
| 400 | Body inválido |
| 404 | Documento/produto inexistente |
| 503 | Meilisearch ou Ollama indisponível |

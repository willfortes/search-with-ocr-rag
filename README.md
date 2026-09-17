# search-with-ocr-rag

Banco de imagens de produtos de **supermercado** com:

- scrape de packshots (Bing)
- remoção de fundo local
- **OCR** (Tesseract) em todas as imagens
- **RAG / embeddings** (Ollama + Meilisearch hybrid)
- API `resolve`: banco primeiro → senão busca (máx. 10)
- validação anti-lixo (ex.: “caminhão”)
- filtro de **marca d’água** / stock

Feito para integrar com o **CriarOfertas**.

---

## Stack

| Peça | Uso |
|------|-----|
| Node.js 18+ / Express | API + dashboard |
| Meilisearch | índice full-text + híbrido |
| Ollama | termos de busca, validação, embeddings |
| Tesseract.js | OCR das embalagens |
| Sharp + `@imgly/background-removal-node` | corte / sem fundo |
| Docker Compose | app (`:3847`) + Meilisearch (`:7700`) |

---

## Quick start (Docker)

### 1. Pré-requisitos

- [Docker Desktop](https://www.docker.com/products/docker-desktop/)
- [Ollama](https://ollama.com/) no host:

```bash
ollama pull qwen2.5:3b
ollama pull nomic-embed-text
```

### 2. Config

```bash
cp .env.example .env
```

No Docker, use Ollama via host:

```env
OLLAMA_URL=http://host.docker.internal:11434
OLLAMA_MODEL=qwen2.5:3b
OLLAMA_EMBED_MODEL=nomic-embed-text
```

### 3. Subir

```bash
docker compose up -d --build
```

- Dashboard: http://localhost:3847  
- API docs: http://localhost:3847/docs/API.md  
- Meilisearch: http://localhost:7700  

### 4. Indexar

Na aba **Banco API** → **Indexar downloads** (OCR + embeddings ligados),  
ou:

```bash
curl -X POST http://localhost:3847/api/bank/index \
  -H "Content-Type: application/json" \
  -d "{\"withOcr\":true,\"withEmbeddings\":true}"
```

---

## API principal — resolve

```http
POST /api/resolve
Content-Type: application/json

{
  "q": "cerveja brahma",
  "limit": 10,
  "offset": 0,
  "kind": "nobg",
  "scrapeIfMissing": true
}
```

Fluxo:

1. Valida se é produto de supermercado  
2. Busca no Meilisearch (híbrido se embeddings OK)  
3. Se não achar → scrape até 10 imagens, remove fundo, OCR, indexa  
4. `offset` / “buscar mais” pede o próximo lote  

Outros endpoints úteis:

| Método | Rota | Função |
|--------|------|--------|
| `GET` | `/api/health` | Ollama + Meilisearch |
| `GET` | `/api/bank/search?q=` | busca no índice |
| `POST` | `/api/bank/index` | indexa `downloads/` |
| `POST` | `/api/scrape` | scrape SSE |
| `POST` | `/api/purge-watermarks` | remove imagens com watermark |
| `POST` | `/api/validate-product` | só valida supermercado |

Detalhes em [`docs/API.md`](docs/API.md).

---

## Dev sem Docker (app local)

```bash
npm install
# Meilisearch rodando (compose só do meili ou binário)
npm run docker:meili
cp .env.example .env
# OLLAMA_URL=http://127.0.0.1:11434
npm run dev
```

Imagens ficam em `downloads/<produto>/{original,nobg}/`.

---

## Integração CriarOfertas

No front:

```env
VITE_PRODUCT_IMAGE_API_URL=http://localhost:3847
```

O modal **Banco de Imagens** chama `POST /api/resolve` (banco → scrape, máx. 10, buscar mais).

---

## Estrutura

```
server/          API (resolve, bank, scrape, OCR, RAG, watermark)
public/          Dashboard (Scraper + Banco API)
docs/API.md      Documentação da API
downloads/       Imagens locais (gitignored)
docker-compose.yml
```

---

## Licença

Uso interno / privado do projeto. Ajuste conforme necessário.

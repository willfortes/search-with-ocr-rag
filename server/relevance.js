/**
 * Filtra imagens irrelevantes (borboleta, árvore, etc.) usando OCR + aliases de marca.
 */

const BRAND_ALIASES = {
  coca: ['coca', 'cola', 'cocacola', 'coca-cola', 'coke'],
  pepsi: ['pepsi'],
  guarana: ['guarana', 'guaraná', 'antarctica'],
  brahma: ['brahma'],
  skol: ['skol'],
  heineken: ['heineken'],
  nestle: ['nestle', 'nestlé'],
  omo: ['omo'],
  ypê: ['ype', 'ypê'],
  ype: ['ype', 'ypê'],
};

/** Tokens que indicam que a imagem NÃO é produto de gôndola */
const JUNK_OCR_HINTS = [
  'borboleta',
  'butterfly',
  'solar',
  'camera',
  'câmera',
  'iphone',
  'smartphone',
  'factory',
  'fabrica',
  'fábrica',
  'arvore',
  'árvore',
  'tree',
  'forest',
  'natureza',
  'landscape',
  'portrait',
  'person',
  'pessoa',
  'whiteboard',
  'quadro branco',
  'powerpoint',
  'slide',
  'mockup generico',
  'carrinho',
  'shopping cart',
  'corredor',
  'gôndola vazia',
];

/**
 * URLs/títulos de stock genérico (carrinho, loja 3D, mockup) — NÃO são packshot.
 */
export const JUNK_URL_HINTS = [
  'shopping-cart',
  'shopping_cart',
  'shoppingcart',
  'carrinho',
  'grocery-cart',
  'grocerycart',
  'cart-full',
  'full-cart',
  'supermarket-aisle',
  'supermarket_aisle',
  'aisle',
  'corredor',
  'isometric',
  'isometrico',
  '3d-store',
  '3d_store',
  '3d-market',
  '3dmarket',
  'storefront',
  'store-front',
  'mini-market',
  'minimarket',
  'super-market',
  'supermarket-building',
  'supermarketbuilding',
  'grocery-store',
  'grocerystore',
  'mockup',
  'blank-pouch',
  'blankpouch',
  'pouch-mockup',
  'packaging-mockup',
  'empty-bag',
  'emptybag',
  'paper-bag',
  'paperbag',
  'kraft-bag',
  'brown-bag',
  'sacola',
  'clipart',
  'cartoon-store',
  'loja-3d',
  'edificio',
  'building',
  'gondola',
  'prateleira-vazia',
  '3d-illustration',
  '3dillustration',
  'render-3d',
  'low-poly',
  'lowpoly',
];

/** True se URL/título/arquivo parecer stock genérico de mercado (não o produto). */
export function looksLikeJunkStock(urlOrTitle = '') {
  const n = normalize(String(urlOrTitle || '')).replace(/-/g, '');
  const raw = String(urlOrTitle || '').toLowerCase();
  for (const junk of JUNK_URL_HINTS) {
    const j = normalize(junk).replace(/-/g, '');
    if (j && (n.includes(j) || raw.includes(junk))) return true;
  }
  return false;
}

/**
 * Categorias de produto: evita "suco" trazer "leite" só porque ambos têm "integral/longa vida".
 * Se a query tem uma categoria, OCR precisa bater nela e não pode ser só da categoria conflitante.
 */
const PRODUCT_CATEGORIES = [
  {
    id: 'suco',
    tokens: ['suco', 'juice', 'nectar'],
    conflicts: ['leite', 'milk', 'iogurte', 'yogurt', 'achocolatado'],
  },
  {
    id: 'leite',
    tokens: ['leite', 'milk'],
    conflicts: ['suco', 'juice', 'refrigerante', 'cerveja'],
  },
  {
    id: 'cerveja',
    tokens: ['cerveja', 'beer', 'chopp'],
    conflicts: ['vinho', 'wine', 'suco', 'leite'],
  },
  {
    id: 'refrigerante',
    tokens: ['refrigerante', 'refri', 'soda'],
    conflicts: ['suco', 'leite', 'cerveja', 'agua'],
  },
  {
    id: 'agua',
    tokens: ['agua', 'water'],
    conflicts: ['suco', 'leite', 'refrigerante', 'cerveja'],
  },
  {
    id: 'azeite',
    tokens: ['azeite', 'olive oil', 'extra virgem'],
    conflicts: ['farofa', 'leite', 'suco', 'arroz'],
  },
  {
    id: 'farofa',
    tokens: ['farofa', 'mandioca'],
    conflicts: ['azeite', 'leite', 'suco', 'arroz'],
  },
];

/** Tokens genéricos de embalagem — sozinhos NÃO bastam para aceitar a imagem */
const WEAK_QUERY_TOKENS = new Set([
  'integral',
  'longa',
  'vida',
  'zero',
  'light',
  'diet',
  'pack',
  'packshot',
  'embalagem',
  'produto',
  'supermercado',
  'fundo',
  'branco',
  'lata',
  'garrafa',
  'caixa',
  'litros',
  'litro',
  'ml',
  'natural',
  'original',
  'premium',
  'tradicional',
]);

function normalize(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function meaningfulTokens(text) {
  return normalize(text)
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !/^\d+$/.test(t));
}

/** Expande query curta com aliases (coca → coca cola coke…) */
export function expandQueryTokens(query) {
  const n = normalize(query);
  const tokens = new Set(meaningfulTokens(query));
  for (const [brand, aliases] of Object.entries(BRAND_ALIASES)) {
    if (n === brand || n.includes(brand) || aliases.some((a) => n === normalize(a) || n.includes(normalize(a)))) {
      for (const a of aliases) tokens.add(normalize(a).replace(/-/g, ''));
      tokens.add(brand);
    }
  }
  // também versão sem hífen
  for (const t of [...tokens]) {
    tokens.add(t.replace(/-/g, ''));
  }
  return [...tokens].filter(Boolean);
}

/**
 * Termo Bing mais restrito a packshot de supermercado.
 */
export function supermarketSearchQuery(productName, aiTerm = '') {
  const base = String(aiTerm || productName || '').trim() || 'produto';
  const expanded = expandQueryTokens(productName);
  const cats = detectCategories(normalize(productName));
  const categoryBoost = cats.map((c) => c.tokens[0]).join(' ');
  const brandBoost =
    expanded.length && !expanded.every((t) => normalize(base).includes(t))
      ? expanded.filter((t) => !WEAK_QUERY_TOKENS.has(t)).slice(0, 3).join(' ')
      : '';
  // NÃO usar "supermercado" sozinho — Bing devolve carrinho/loja 3D.
  // Preferir packshot isolado da embalagem.
  const core = [
    categoryBoost,
    brandBoost,
    `"${base}"`,
    'embalagem produto',
    'packshot',
    'fundo branco',
    '-carrinho',
    '-shopping',
    '-cart',
    '-aisle',
    '-corredor',
    '-isometric',
    '-mockup',
    '-3d',
    '-clipart',
    '-loja',
    '-store',
    '-building',
  ]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return core.slice(0, 220);
}

function detectCategories(textNorm) {
  const hits = [];
  for (const cat of PRODUCT_CATEGORIES) {
    if (cat.tokens.some((t) => textNorm.includes(normalize(t)))) hits.push(cat);
  }
  return hits;
}

/**
 * @returns {{ ok: boolean, score: number, reason: string }}
 */
export function scoreProductRelevance(
  query,
  {
    ocrText = '',
    product = '',
    tags = [],
    mismatched = false,
    allowWeakEmpty = false,
    url = '',
    file = '',
  } = {}
) {
  const qTokens = expandQueryTokens(query);
  const ocr = normalize(ocrText).replace(/-/g, '');
  const tagStr = normalize((tags || []).join(' '));
  const hay = `${ocr} ${tagStr} ${normalize(product)}`.trim();
  const qNorm = normalize(query);

  if (!qTokens.length) {
    return { ok: false, score: 0, reason: 'empty_query' };
  }

  if (looksLikeJunkStock(url) || looksLikeJunkStock(file) || looksLikeJunkStock(product)) {
    return { ok: false, score: -25, reason: 'junk_stock_url' };
  }

  for (const junk of JUNK_OCR_HINTS) {
    if (ocr.includes(normalize(junk))) {
      return { ok: false, score: -20, reason: `junk:${junk}` };
    }
  }

  // Categoria: "suco …" não pode aceitar embalagem de leite só por "integral/longa vida"
  const queryCats = detectCategories(qNorm);
  if (queryCats.length) {
    for (const cat of queryCats) {
      const hasOwn = cat.tokens.some((t) => hay.includes(normalize(t)));
      const hasConflict = cat.conflicts.some((t) => hay.includes(normalize(t)));
      if (hasConflict && !hasOwn) {
        return { ok: false, score: -15, reason: `category_conflict:${cat.id}` };
      }
      // OCR legível sem a categoria pedida → rejeita (evita leite em busca de suco)
      const compactOcrEarly = ocr.replace(/\s+/g, '');
      if (compactOcrEarly.length >= 8 && !hasOwn) {
        return { ok: false, score: -12, reason: `missing_category:${cat.id}` };
      }
    }
  }

  if (mismatched) {
    const hit = qTokens.some((t) => ocr.includes(t));
    if (!hit) return { ok: false, score: -10, reason: 'mismatched' };
  }

  let score = 0;
  let hits = 0;
  let strongHits = 0;
  for (const t of qTokens) {
    if (t.length < 3) continue;
    if (ocr.includes(t) || tagStr.includes(t)) {
      const weak = WEAK_QUERY_TOKENS.has(t);
      score += weak ? 1 : t.length >= 4 ? 4 : 3;
      hits += 1;
      if (!weak) strongHits += 1;
    }
  }

  const ocrTokens = meaningfulTokens(ocrText);
  if (ocrTokens.length >= 4 && hits === 0) {
    return { ok: false, score: 0, reason: 'ocr_unrelated' };
  }

  const compactOcr = ocr.replace(/\s+/g, '');
  if (compactOcr.length < 6) {
    // Sem OCR: só aceita fraco se a query NÃO exige categoria específica
    if (allowWeakEmpty && !queryCats.length) {
      return { ok: true, score: 1, reason: 'weak_empty' };
    }
    if (allowWeakEmpty && queryCats.length) {
      // packshot sem texto com categoria na query — rejeita (muito falso positivo)
      return { ok: false, score: 0, reason: 'weak_empty_blocked_by_category' };
    }
    return { ok: false, score: 0, reason: 'ocr_empty' };
  }

  if (hits === 0) {
    return { ok: false, score: 0, reason: 'no_token_match' };
  }

  // Precisa de pelo menos 1 token forte (ex.: "suco") — não só "integral/longa/vida"
  if (strongHits === 0 && queryCats.length) {
    return { ok: false, score: score, reason: 'only_weak_tokens' };
  }

  return { ok: score >= 3 && (strongHits > 0 || !queryCats.length), score, reason: hits > 0 ? 'matched' : 'weak' };
}

/**
 * Filtra lista de hits/imagens do resolve.
 * 1) mantém matches fortes de OCR
 * 2) se allowWeakEmpty, completa com packshots sem OCR legível (sem texto de lixo)
 */
export function filterRelevantImages(images, query, { allowWeakEmpty = false } = {}) {
  if (!Array.isArray(images) || !images.length) return [];

  const strong = [];
  const weak = [];

  for (const img of images) {
    const meta = {
      ocrText: img.ocrText || '',
      product: img.product || img.detectedProduct || '',
      tags: img.tags || [],
      mismatched: Boolean(img.mismatched),
      url: img.url || img.sourceUrl || '',
      file: img.file || '',
    };
    // Stock genérico (carrinho/loja) nunca passa — nem no modo fraco
    if (looksLikeJunkStock(meta.url) || looksLikeJunkStock(meta.file)) continue;

    const strict = scoreProductRelevance(query, { ...meta, allowWeakEmpty: false });
    if (strict.ok) {
      strong.push({ ...img, relevanceScore: strict.score, relevanceReason: strict.reason });
      continue;
    }
    if (allowWeakEmpty) {
      const soft = scoreProductRelevance(query, { ...meta, allowWeakEmpty: true });
      // weak_empty só se OCR vazio E URL não for lixo — ainda assim score baixo
      if (soft.ok && soft.reason === 'weak_empty') {
        weak.push({ ...img, relevanceScore: soft.score, relevanceReason: soft.reason });
      }
    }
  }

  strong.sort((a, b) => (b.relevanceScore || 0) - (a.relevanceScore || 0));
  // Prefere matches fortes; weak_empty só completa se houver poucos fortes
  if (strong.length >= 3) return strong;
  return [...strong, ...weak];
}

/**
 * Taxonomia simples para enriquecer busca do banco (ex.: "cerveja" acha Brahma/Heineken).
 */

const BRAND_CATEGORIES = {
  // Cervejas
  brahma: ['cerveja', 'beer', 'chopp'],
  heineken: ['cerveja', 'beer', 'lager'],
  skol: ['cerveja', 'beer'],
  antarctica: ['cerveja', 'beer'],
  corona: ['cerveja', 'beer'],
  budweiser: ['cerveja', 'beer'],
  amstel: ['cerveja', 'beer'],
  stella: ['cerveja', 'beer'],
  bohemia: ['cerveja', 'beer'],
  itaipava: ['cerveja', 'beer'],
  eisenbahn: ['cerveja', 'beer'],
  antarctica_original: ['cerveja', 'beer'],
  spaten: ['cerveja', 'beer'],
  beck: ['cerveja', 'beer'],
  therezopolis: ['cerveja', 'beer'],
  colorado: ['cerveja', 'beer'],

  // Limpeza
  omo: ['sabao', 'sabao_em_po', 'detergente', 'limpeza'],
  ariel: ['sabao', 'sabao_em_po', 'detergente', 'limpeza'],
  ype: ['detergente', 'limpeza'],
  ypê: ['detergente', 'limpeza'],

  // Alimentos
  camil: ['arroz', 'feijao'],
  tio_joao: ['arroz'],
  kicaldo: ['feijao'],
  broto_legal: ['feijao'],
};

/**
 * Sinônimos Meilisearch — NÃO usar termos genéricos (alimento) que misturam categorias.
 * Buscar "arroz" não deve achar feijão só porque ambos são "alimento".
 */
const CATEGORY_SYNONYMS = {
  cerveja: [
    'beer',
    'chopp',
    'lager',
    'brahma',
    'heineken',
    'skol',
    'antarctica',
    'corona',
    'budweiser',
    'amstel',
    'bohemia',
    'itaipava',
    'eisenbahn',
    'spaten',
  ],
  beer: ['cerveja', 'chopp', 'lager', 'brahma', 'heineken', 'skol'],
  sabao: ['sabao_em_po', 'detergente', 'omo', 'ariel', 'limpeza'],
  detergente: ['sabao', 'omo', 'ype', 'limpeza'],
  feijao: ['feijão', 'carioca', 'kicaldo'],
  arroz: ['tio_joao', 'camil'],
};

function normalizeToken(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

function containsBrand(normalizedText, brand) {
  const brandNorm = normalizeToken(brand);
  if (!brandNorm) return false;
  const spaced = normalizeToken(normalizedText).replace(/_/g, ' ');
  const tokens = spaced.split(/\s+/).filter(Boolean);

  if (tokens.includes(brandNorm.replace(/_/g, ''))) return true;
  if (tokens.includes(brandNorm)) return true;

  if (brandNorm.includes('_')) {
    const phrase = brandNorm.replace(/_/g, ' ');
    if (spaced.includes(phrase)) return true;
  }

  // fuzzy leve: "heine ken", "brarama", "BRARMA"
  if (brandNorm.length >= 5) {
    const compact = spaced.replace(/\s+/g, '');
    if (compact.includes(brandNorm.replace(/_/g, ''))) return true;
  }

  return false;
}

/**
 * Infere produto real pelo OCR (corrige pasta "vem" com lata Heineken).
 * @returns {{ label: string, brand: string|null, mismatched: boolean }}
 */
export function inferProductFromOcr({ folder = '', product = '', ocrText = '' } = {}) {
  const folderNorm = normalizeToken(folder || product);
  const ocrNorm = normalizeToken(ocrText).replace(/_/g, ' ');
  if (!ocrNorm) {
    return { label: product || folder, brand: null, mismatched: false };
  }

  let foundBrand = null;
  for (const brand of Object.keys(BRAND_CATEGORIES)) {
    if (containsBrand(ocrNorm, brand)) {
      foundBrand = normalizeToken(brand);
      break;
    }
  }

  // Heineken costuma OCR só "CERVEJA LAGER" (logo estilizado)
  if (
    !foundBrand &&
    (ocrNorm.includes('cerveja') || ocrNorm.includes('lager')) &&
    (ocrNorm.includes('lager') || ocrNorm.includes('original'))
  ) {
    // se a pasta não é marca de cerveja conhecida, assume heineken só com lager+cerveja
    const beerFolders = new Set(
      Object.entries(BRAND_CATEGORIES)
        .filter(([, cats]) => cats.includes('cerveja'))
        .map(([b]) => normalizeToken(b))
    );
    if (!beerFolders.has(folderNorm)) {
      foundBrand = 'heineken';
    }
  }

  if (foundBrand && foundBrand !== folderNorm && !folderNorm.includes(foundBrand)) {
    return {
      label: foundBrand.replace(/_/g, ' '),
      brand: foundBrand,
      mismatched: true,
    };
  }

  if (foundBrand) {
    return {
      label: foundBrand.replace(/_/g, ' '),
      brand: foundBrand,
      mismatched: false,
    };
  }

  // categoria sem marca
  if (ocrNorm.includes('cerveja') || ocrNorm.includes('chopp')) {
    const beerFolders = new Set(
      Object.entries(BRAND_CATEGORIES)
        .filter(([, cats]) => cats.includes('cerveja'))
        .map(([b]) => normalizeToken(b))
    );
    if (!beerFolders.has(folderNorm)) {
      return { label: 'cerveja', brand: null, mismatched: true };
    }
  }

  return { label: product || folder, brand: null, mismatched: false };
}

export function buildSearchTags({ product = '', folder = '', file = '', ocrText = '' } = {}) {
  const identity = normalizeToken([product, folder].filter(Boolean).join(' ')).replace(/_/g, ' ');
  const content = normalizeToken([product, folder, ocrText].filter(Boolean).join(' ')).replace(/_/g, ' ');
  const tags = new Set();

  for (const part of identity.split(/\s+/).filter((p) => p.length >= 3)) {
    tags.add(part);
  }

  const inferred = inferProductFromOcr({ folder, product, ocrText });
  if (inferred.brand) {
    tags.add(inferred.brand);
    const cats = BRAND_CATEGORIES[inferred.brand] || BRAND_CATEGORIES[inferred.brand.replace(/ /g, '_')] || [];
    for (const cat of cats) tags.add(normalizeToken(cat));
  }

  for (const [brand, categories] of Object.entries(BRAND_CATEGORIES)) {
    if (containsBrand(content, brand) || containsBrand(identity, brand)) {
      tags.add(normalizeToken(brand));
      for (const cat of categories) tags.add(normalizeToken(cat));
    }
  }

  const categoryWords = ['cerveja', 'beer', 'chopp', 'lager', 'sabao', 'detergente', 'feijao', 'arroz'];
  for (const word of categoryWords) {
    const w = normalizeToken(word);
    if (containsBrand(content, w) || content.includes(w)) {
      tags.add(w);
      if (['cerveja', 'beer', 'chopp', 'lager'].includes(w)) {
        tags.add('cerveja');
        tags.add('beer');
      }
    }
  }

  if (identity.split(/\s+/).includes('carioca') || identity.includes('feijao')) {
    tags.add('feijao');
  }

  return [...tags].filter(Boolean);
}

export function meilisearchSynonyms() {
  const out = { ...CATEGORY_SYNONYMS };
  for (const [brand, categories] of Object.entries(BRAND_CATEGORIES)) {
    if (categories.includes('cerveja')) {
      out[brand] = [...new Set([...(out[brand] || []), 'cerveja', 'beer'])];
    }
  }
  return out;
}

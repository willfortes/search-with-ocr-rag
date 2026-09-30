/**
 * Departamentos de hipermercado + sinônimos.
 * Objetivo: precisão geral sem corrigir produto a produto.
 */

function normalize(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Cortes / nomes curtos → termos de busca e tokens de URL */
export const PRODUCT_SYNONYMS = {
  maminha: ['maminha', 'carne', 'bovina', 'peca', 'vacuo'],
  picanha: ['picanha', 'carne', 'bovina'],
  alcatra: ['alcatra', 'carne', 'bovina'],
  contrafile: ['contrafile', 'contra file', 'carne', 'bovina'],
  'contra-file': ['contrafile', 'carne', 'bovina'],
  filemignon: ['file mignon', 'filemignon', 'carne'],
  'file-mignon': ['file mignon', 'carne'],
  costela: ['costela', 'carne', 'bovina'],
  acem: ['acem', 'carne', 'bovina'],
  patinho: ['patinho', 'carne', 'bovina'],
  coxao: ['coxao', 'carne', 'bovina'],
  fraldinha: ['fraldinha', 'carne', 'bovina'],
  cupim: ['cupim', 'carne', 'bovina'],
  linguica: ['linguica', 'embutido', 'carne'],
  salsicha: ['salsicha', 'embutido'],
  bacon: ['bacon', 'carne'],
  peito: ['peito', 'frango', 'ave'],
  coxa: ['coxa', 'frango'],
  sobrecoxa: ['sobrecoxa', 'frango'],
  asa: ['asa', 'frango'],
  tilapia: ['tilapia', 'peixe'],
  salmao: ['salmao', 'peixe'],
};

/**
 * Departamentos: boost na query Bing + conflitos de URL (rejeita cruzamento).
 * `match` = se a query bater, usa este departamento.
 */
export const DEPARTMENTS = [
  {
    id: 'carnes',
    match: [
      'maminha', 'picanha', 'alcatra', 'contrafile', 'file', 'mignon', 'costela', 'acem', 'patinho',
      'coxao', 'fraldinha', 'cupim', 'carne', 'bovina', 'suina', 'frango', 'peixe', 'linguica',
      'salsicha', 'bacon', 'presunto', 'mortadela', 'salame', 'hamburguer', 'hambúrguer', 'bife',
      'peca', 'açougue', 'acougue', 'aves', 'peito', 'coxa', 'sobrecoxa', 'tilapia', 'salmao',
    ],
    boost: 'carne bovina peca packshot vacuo',
    urlPositive: [
      'carne', 'maminha', 'picanha', 'bovina', 'frango', 'peixe', 'linguica', 'bife', 'vacuo',
      'acougue', 'meat', 'beef', 'steak', 'vacuum', 'poultry', 'chicken', 'fish', 'pork',
    ],
    urlConflict: [
      'oleo', 'óleo', 'azeite', 'detergente', 'shampoo', 'amaciante', 'refrigerante', 'cerveja',
      'suco', 'leite', 'farofa', 'arroz', 'feijao', 'mockup', 'kraft', 'pouch', 'mel', 'honey',
      'oil', 'shampoo',
    ],
  },
  {
    id: 'bebidas_alcoolicas',
    match: ['cerveja', 'vinho', 'vodka', 'whisky', 'whiskey', 'pinga', 'cachaca', 'cachaça', 'gim', 'gin', 'rum', 'tequila', 'espumante', 'chopp', 'heineken', 'brahma', 'skol'],
    boost: 'garrafa packshot bebida',
    urlPositive: ['cerveja', 'vinho', 'vodka', 'whisky', 'garrafa', 'lata'],
    urlConflict: ['detergente', 'carne', 'maminha', 'shampoo', 'leite', 'suco'],
  },
  {
    id: 'refrigerantes',
    match: ['refrigerante', 'refri', 'coca', 'pepsi', 'guarana', 'guaraná', 'fanta', 'sprite', 'soda'],
    boost: 'lata garrafa refrigerante packshot',
    urlPositive: ['refrigerante', 'coca', 'pepsi', 'guarana', 'lata', 'garrafa'],
    urlConflict: ['cerveja', 'vinho', 'detergente', 'carne', 'shampoo'],
  },
  {
    id: 'bebidas',
    match: ['suco', 'nectar', 'água', 'agua', 'energetico', 'energético', 'isotonic', 'cha', 'chá'],
    boost: 'garrafa packshot bebida',
    urlPositive: ['suco', 'agua', 'nectar', 'garrafa'],
    urlConflict: ['detergente', 'carne', 'cerveja', 'shampoo', 'oleo'],
  },
  {
    id: 'limpeza',
    match: [
      'detergente', 'amaciante', 'desinfetante', 'sabao', 'sabão', 'multiuso', 'alvejante',
      'agua sanitaria', 'água sanitária', 'limpol', 'omo', 'ype', 'ypê', 'vanish', 'limpador',
    ],
    boost: 'limpeza frasco packshot',
    urlPositive: ['detergente', 'amaciante', 'limpeza', 'limpol', 'omo', 'ype', 'ypê', 'ariel', 'vanish', 'sabao', 'cif', 'ajax'],
    urlConflict: ['shampoo', 'carne', 'maminha', 'cerveja', 'oleo', 'azeite', 'suco'],
  },
  {
    id: 'higiene',
    match: ['shampoo', 'condicionador', 'sabonete', 'creme dental', 'pasta de dente', 'desodorante', 'fralda', 'absorvente', 'papel higienico', 'papel higiênico'],
    boost: 'higiene packshot frasco',
    urlPositive: ['shampoo', 'sabonete', 'dental', 'fralda', 'desodorante'],
    urlConflict: ['detergente', 'carne', 'cerveja', 'oleo'],
  },
  {
    id: 'mercearia',
    match: [
      'arroz', 'feijao', 'feijão', 'macarrao', 'macarrão', 'massa', 'farinha', 'farofa', 'acucar',
      'açúcar', 'sal', 'oleo', 'óleo', 'azeite', 'molho', 'extrato', 'cafe', 'café', 'achocolatado',
      'leite', 'iogurte', 'manteiga', 'margarina', 'biscoito', 'bolacha', 'chocolate', 'tempero',
    ],
    boost: 'pacote embalagem packshot mercearia',
    urlPositive: ['arroz', 'feijao', 'macarrao', 'farofa', 'azeite', 'oleo', 'leite', 'cafe', 'pacote'],
    urlConflict: ['detergente', 'shampoo', 'carne', 'maminha', 'cerveja'],
  },
  {
    id: 'hortifruti',
    match: ['banana', 'maca', 'maçã', 'pera', 'kiwi', 'mamao', 'mamão', 'abacaxi', 'uva', 'morango', 'manga', 'tomate', 'alface', 'cebola', 'batata', 'cenoura', 'laranja', 'limao', 'limão', 'hortifruti', 'fruta', 'verdura'],
    boost: 'hortifruti fresco packshot',
    urlPositive: ['fruta', 'tomate', 'banana', 'pera', 'kiwi', 'mamao', 'abacaxi', 'uva', 'hortifruti', 'verdura'],
    urlConflict: ['detergente', 'mockup', 'pouch', 'oleo', 'cerveja'],
  },
  {
    id: 'padaria',
    match: ['pao', 'pão', 'bolo', 'rosca', 'sonho', 'croissant', 'torrada'],
    boost: 'padaria pacote packshot',
    urlPositive: ['pao', 'bolo', 'padaria'],
    urlConflict: ['detergente', 'carne', 'cerveja'],
  },
  {
    id: 'pet',
    match: ['racao', 'ração', 'pet', 'cachorro', 'gato', 'areia'],
    boost: 'racao pet packshot',
    urlPositive: ['racao', 'pet', 'cachorro', 'gato'],
    urlConflict: ['detergente humano', 'carne bovina', 'cerveja'],
  },
  {
    id: 'bazar',
    match: [
      'panela', 'frigideira', 'copo', 'prato', 'talher', 'vaso', 'toalha', 'lencol', 'lençol',
      'travesseiro', 'almofada', 'organizador', 'cesto', 'balde', 'rodinho', 'vassoura',
      'cozinha', 'quarto', 'sala', 'banheiro', 'utensilio', 'utensílio',
    ],
    boost: 'utilidade domestica produto packshot',
    urlPositive: ['panela', 'copo', 'toalha', 'utensilio', 'organizador', 'casa'],
    urlConflict: ['detergente liquido', 'carne', 'cerveja', 'leite'],
  },
];

/** Negativos sempre — stock genérico / mockup */
export const ALWAYS_NEGATIVE = [
  '-mockup',
  '-carrinho',
  '-shopping-cart',
  '-isometric',
  '-3d-store',
  '-clipart',
  '-diagram',
  '-infographic',
  '-dieline',
  '-kraft-bag',
  '-paper-bag',
  '-blank-pouch',
  '-empty-pack',
  '-template',
  '-tipos-de-embalagem',
];

export function detectDepartment(query) {
  const n = normalize(query);
  // Cortes / sinônimos curtos conhecidos (maminha, picanha…)
  for (const key of Object.keys(PRODUCT_SYNONYMS)) {
    if (n === key || n.includes(key)) {
      return DEPARTMENTS.find((d) => d.id === 'carnes') || null;
    }
  }
  for (const dept of DEPARTMENTS) {
    if (dept.match.some((m) => {
      const mn = normalize(m);
      return mn && (n === mn || n.includes(mn));
    })) {
      return dept;
    }
  }
  return null;
}

export function expandProductSynonyms(query) {
  const n = normalize(query);
  const syn = PRODUCT_SYNONYMS[n];
  if (syn) return syn.map(normalize);
  // match parcial (ex.: "maminha bovina")
  for (const [key, vals] of Object.entries(PRODUCT_SYNONYMS)) {
    if (n.includes(key)) return vals.map(normalize);
  }
  return normalize(query)
    .split(/\s+/)
    .filter((t) => t.length >= 3);
}

/**
 * Gate de URL: rejeita lixo e cruzamento de departamento; aceita se tem produto/dept positivo.
 */
export function passesUrlRelevanceGate(urlOrTitle, query) {
  const raw = String(urlOrTitle || '').toLowerCase();
  const n = normalize(urlOrTitle).replace(/\s+/g, '');
  const q = normalize(query);
  const qTokens = expandProductSynonyms(query).filter((t) => t.length >= 3);
  const dept = detectDepartment(query);

  // lixo universal
  if (
    /mockup|dieline|diagram|infographic|kraft|paper.?bag|blank.?pouch|empty.?pouch|tipos.?de.?embalagem|packaging.?types|packaging-mockup|standup-pouch|clipart|isometric|shopping.?cart/.test(
      raw
    )
  ) {
    return { ok: false, reason: 'junk' };
  }

  if (dept) {
    for (const bad of dept.urlConflict) {
      const b = normalize(bad).replace(/\s+/g, '');
      if (b && n.includes(b) && !qTokens.some((t) => n.includes(t))) {
        return { ok: false, reason: `conflict:${bad}` };
      }
    }
  }

  const hasQuery = qTokens.some((t) => t.length >= 4 && n.includes(t.replace(/\s+/g, '')));
  const hasDeptPositive =
    dept &&
    dept.urlPositive.some((p) => {
      const pn = normalize(p).replace(/\s+/g, '');
      return pn.length >= 4 && n.includes(pn);
    });

  // Aceita: nome do produto OU sinal claro do departamento (ex.: carne/vacuo para maminha)
  if (hasQuery || hasDeptPositive) {
    return { ok: true, reason: hasQuery ? 'query' : 'department' };
  }

  // Sem pista na URL → rejeita (evita óleo/mel/mockup em busca de maminha)
  return { ok: false, reason: 'no_signal' };
}

export function buildDepartmentSearchQuery(productName) {
  const name = String(productName || '').trim() || 'produto';
  const dept = detectDepartment(name);
  const nameNorm = normalize(name);
  // Só acrescenta sinônimos quando NÃO há departamento (evita "carne bovina" duplicado)
  const synBoost = dept
    ? ''
    : expandProductSynonyms(name)
        .filter((t) => t.length >= 3 && !nameNorm.includes(t))
        .slice(0, 2)
        .join(' ');

  const parts = [
    `"${name}"`,
    synBoost,
    dept?.boost || 'packshot embalagem produto',
    'fundo branco',
    ...ALWAYS_NEGATIVE,
  ];

  // conflitos extras na query Bing
  if (dept?.id === 'carnes') {
    parts.push('-oleo', '-azeite', '-detergente', '-shampoo', '-mel', '-honey', '-refrigerante');
  } else if (dept?.id === 'limpeza') {
    parts.push('-shampoo', '-carne', '-cerveja', '-oleo');
  } else if (dept?.id === 'refrigerantes' || dept?.id === 'bebidas') {
    parts.push('-cerveja', '-detergente', '-carne');
  } else if (dept?.id === 'bebidas_alcoolicas') {
    parts.push('-refrigerante', '-detergente', '-carne');
  }

  return parts
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 280);
}

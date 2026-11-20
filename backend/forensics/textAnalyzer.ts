import { insertFinding } from '../db.ts';

export interface ExtractedTextSignals {
  normalized_text: string;
  word_count: number;
  sentence_count: number;
  dates: string[];
  times: string[];
  numbers: string[];
  locations: string[];
  entities: string[];
  keywords: string[];
}

export interface TextComparisonResult {
  source_a_label: string;
  source_b_label: string;
  jaccard_similarity: number;
  cosine_similarity: number;
  shared_keywords: string[];
  only_in_a_keywords: string[];
  only_in_b_keywords: string[];
  matching_dates: string[];
  conflicting_dates: { a: string[]; b: string[] };
  matching_times: string[];
  conflicting_times: { a: string[]; b: string[] };
  matching_numbers: string[];
  conflicting_numbers: { a: string[]; b: string[] };
  matching_locations: string[];
  conflicting_locations: { a: string[]; b: string[] };
  matching_entities: string[];
  diff_tokens: Array<{ text: string; status: 'MATCH' | 'ONLY_A' | 'ONLY_B' }>;
  observations: Array<{
    type: 'MATCH' | 'DIFFERENCE' | 'POTENTIAL_CONTRADICTION' | 'REQUIRES_REVIEW';
    summary: string;
    detail: string;
    alternative_explanation: string;
  }>;
  disclaimer: string;
}

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'that', 'with', 'this', 'from', 'have', 'were', 'been', 'will', 'would',
  'there', 'their', 'about', 'which', 'when', 'where', 'what', 'into', 'than', 'then', 'them',
  'some', 'could', 'other', 'after', 'before', 'during', 'under', 'over', 'between', 'while',
  'also', 'just', 'only', 'very', 'more', 'most', 'such', 'each', 'many', 'much', 'here', 'they',
  'your', 'ours', 'ourselves', 'these', 'those', 'being', 'does', 'doing', 'done', 'said', 'says',
  'near', 'around', 'through', 'across', 'along', 'until', 'without', 'within', 'because', 'since',
]);

const KNOWN_CITIES_AND_PLACES = new Set([
  'new york', 'los angeles', 'chicago', 'houston', 'boston', 'seattle', 'miami', 'london', 'paris',
  'berlin', 'tokyo', 'mumbai', 'delhi', 'bengaluru', 'singapore', 'dubai', 'toronto', 'sydney',
  'san francisco', 'washington', 'atlanta', 'dallas', 'denver', 'austin', 'phoenix', 'portland',
  'harbor', 'terminal', 'airport', 'station', 'plaza', 'bridge', 'square', 'warehouse', 'port',
  'downtown', 'northgate', 'eastside', 'westport', 'pier', 'dock', 'highway', 'boulevard',
]);

export function normalizeText(raw: string): string {
  return (raw || '')
    .replace(/\r\n/g, '\n')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractTextSignals(raw: string): ExtractedTextSignals {
  const normalized = normalizeText(raw);
  const words = normalized.split(/\s+/).filter(Boolean);
  const sentences = normalized.split(/[.!?]+/).map((s) => s.trim()).filter(Boolean);

  // 1. Dates (ISO, US/EU slash/dash, Month DD YYYY, DD Month YYYY)
  const datePatterns = [
    /\b\d{4}-\d{2}-\d{2}\b/g,
    /\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/g,
    /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?\b/gi,
    /\b\d{1,2}\s+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)(?:\s+\d{4})?\b/gi,
  ];
  const dateSet = new Set<string>();
  for (const re of datePatterns) {
    const matches = normalized.match(re) || [];
    for (const m of matches) dateSet.add(m.trim());
  }

  // 2. Times (HH:MM, HH:MM:SS, 12h AM/PM, UTC/GMT/EST/PST)
  const timeMatches =
    normalized.match(
      /\b(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?(?:\s?(?:AM|PM|UTC|GMT|EST|PST|IST))?\b|\b(?:1[0-2]|0?[1-9])\s?(?:AM|PM)\b/gi
    ) || [];
  const timeSet = new Set(timeMatches.map((t) => t.trim()));

  // 3. Numerical claims (currency, percentages, measurements, standalone significant numbers)
  const numMatches =
    normalized.match(
      /(?:[$€£₹]\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:million|billion|thousand|k|m|b))?|\b\d[\d,]*(?:\.\d+)?\s?(?:%|percent|people|protesters|vehicles|meters|km|miles|hours|minutes|seconds|degrees|tons|kg|usd|eur)\b|\b\d{2,}(?:,\d{3})*(?:\.\d+)?\b)/gi
    ) || [];
  const numSet = new Set<string>();
  for (const n of numMatches) {
    const cleaned = n.trim();
    // Skip pure 4-digit years already captured inside full dates if identical
    if (/^(19|20)\d{2}$/.test(cleaned) && Array.from(dateSet).some((d) => d.includes(cleaned))) {
      continue;
    }
    numSet.add(cleaned);
  }

  // 4. Locations (preposition + capitalized phrase OR known place terms)
  const locationSet = new Set<string>();
  const locPrepRegex =
    /\b(?:in|at|near|from|outside|inside|toward|towards|around)\s+([A-Z][a-zA-Z0-9-]*(?:\s+[A-Z0-9][a-zA-Z0-9-]*){0,3})/g;
  let locMatch: RegExpExecArray | null;
  while ((locMatch = locPrepRegex.exec(normalized)) !== null) {
    const candidate = locMatch[1].trim();
    if (
      candidate.length >= 3 &&
      !/^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|January|February|March|April|May|June|July|August|September|October|November|December|The|This|That|According)$/i.test(
        candidate
      )
    ) {
      locationSet.add(candidate);
    }
  }
  const lowerNorm = normalized.toLowerCase();
  for (const place of KNOWN_CITIES_AND_PLACES) {
    if (lowerNorm.includes(place)) {
      const idx = lowerNorm.indexOf(place);
      const originalCase = normalized.slice(idx, idx + place.length);
      if (place.length >= 5) {
        locationSet.add(originalCase);
      }
    }
  }

  // 5. Named Entities (multi-word capitalized sequences or proper nouns not at sentence start)
  const entitySet = new Set<string>();
  const entityRegex = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z0-9]+){1,3})\b/g;
  let entMatch: RegExpExecArray | null;
  while ((entMatch = entityRegex.exec(normalized)) !== null) {
    const candidate = entMatch[1].trim();
    if (!dateSet.has(candidate)) {
      entitySet.add(candidate);
    }
  }
  // Acronyms like FBI, NATO, UN, NYPD, CCTV
  const acronymMatches = normalized.match(/\b[A-Z]{2,6}\b/g) || [];
  for (const ac of acronymMatches) {
    if (!['AM', 'PM', 'UTC', 'GMT', 'THE', 'AND', 'FOR'].includes(ac)) {
      entitySet.add(ac);
    }
  }

  // 6. Meaningful Keywords
  const tokenCounts = new Map<string, number>();
  const tokens = normalized
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 4 && !STOP_WORDS.has(t) && !/^\d+$/.test(t));

  for (const t of tokens) {
    tokenCounts.set(t, (tokenCounts.get(t) || 0) + 1);
  }
  const keywords = Array.from(tokenCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 25)
    .map(([k]) => k);

  return {
    normalized_text: normalized,
    word_count: words.length,
    sentence_count: sentences.length,
    dates: Array.from(dateSet),
    times: Array.from(timeSet),
    numbers: Array.from(numSet),
    locations: Array.from(locationSet),
    entities: Array.from(entitySet),
    keywords,
  };
}

function tokenizeLower(text: string): string[] {
  return normalizeText(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2);
}

export function computeCosineSimilarity(textA: string, textB: string): number {
  const toksA = tokenizeLower(textA).filter((t) => !STOP_WORDS.has(t));
  const toksB = tokenizeLower(textB).filter((t) => !STOP_WORDS.has(t));
  if (!toksA.length || !toksB.length) return 0;

  const freqA = new Map<string, number>();
  const freqB = new Map<string, number>();
  const vocab = new Set<string>();

  for (const t of toksA) {
    freqA.set(t, (freqA.get(t) || 0) + 1);
    vocab.add(t);
  }
  for (const t of toksB) {
    freqB.set(t, (freqB.get(t) || 0) + 1);
    vocab.add(t);
  }

  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (const term of vocab) {
    const a = freqA.get(term) || 0;
    const b = freqB.get(term) || 0;
    dot += a * b;
    magA += a * a;
    magB += b * b;
  }

  if (magA === 0 || magB === 0) return 0;
  return Number((dot / (Math.sqrt(magA) * Math.sqrt(magB))).toFixed(3));
}

export function compareTexts(
  labelA: string,
  textA: string,
  labelB: string,
  textB: string
): TextComparisonResult {
  const sigA = extractTextSignals(textA);
  const sigB = extractTextSignals(textB);

  const kwA = new Set(sigA.keywords);
  const kwB = new Set(sigB.keywords);
  const sharedKeywords = Array.from(kwA).filter((k) => kwB.has(k));
  const onlyInA = Array.from(kwA).filter((k) => !kwB.has(k));
  const onlyInB = Array.from(kwB).filter((k) => !kwA.has(k));
  const unionSize = new Set([...kwA, ...kwB]).size;
  const jaccard = unionSize > 0 ? Number((sharedKeywords.length / unionSize).toFixed(3)) : 0;
  const cosine = computeCosineSimilarity(textA, textB);

  const normSet = (arr: string[]) => arr.map((s) => s.toLowerCase());
  const matchList = (a: string[], b: string[]) => {
    const bLower = new Set(normSet(b));
    return a.filter((item) => bLower.has(item.toLowerCase()));
  };

  const matchingDates = matchList(sigA.dates, sigB.dates);
  const aDiffDates = sigA.dates.filter((d) => !matchingDates.includes(d));
  const bDiffDates = sigB.dates.filter(
    (d) => !matchingDates.some((m) => m.toLowerCase() === d.toLowerCase())
  );

  const matchingTimes = matchList(sigA.times, sigB.times);
  const aDiffTimes = sigA.times.filter((t) => !matchingTimes.includes(t));
  const bDiffTimes = sigB.times.filter(
    (t) => !matchingTimes.some((m) => m.toLowerCase() === t.toLowerCase())
  );

  const matchingNumbers = matchList(sigA.numbers, sigB.numbers);
  const aDiffNums = sigA.numbers.filter((n) => !matchingNumbers.includes(n));
  const bDiffNums = sigB.numbers.filter(
    (n) => !matchingNumbers.some((m) => m.toLowerCase() === n.toLowerCase())
  );

  const matchingLocations = matchList(sigA.locations, sigB.locations);
  const aDiffLocs = sigA.locations.filter((l) => !matchingLocations.includes(l));
  const bDiffLocs = sigB.locations.filter(
    (l) => !matchingLocations.some((m) => m.toLowerCase() === l.toLowerCase())
  );

  const matchingEntities = matchList(sigA.entities, sigB.entities);

  // Word-level diff markers
  const wordsA = sigA.normalized_text.split(/\s+/).filter(Boolean);
  const wordsBSet = new Set(tokenizeLower(sigB.normalized_text));
  const wordsASet = new Set(tokenizeLower(sigA.normalized_text));
  const diffTokens: Array<{ text: string; status: 'MATCH' | 'ONLY_A' | 'ONLY_B' }> = [];

  for (const w of wordsA.slice(0, 120)) {
    const clean = w.toLowerCase().replace(/[^a-z0-9]/g, '');
    diffTokens.push({
      text: w,
      status: clean && wordsBSet.has(clean) ? 'MATCH' : 'ONLY_A',
    });
  }
  const wordsB = sigB.normalized_text.split(/\s+/).filter(Boolean);
  for (const w of wordsB.slice(0, 120)) {
    const clean = w.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (clean && !wordsASet.has(clean)) {
      diffTokens.push({ text: w, status: 'ONLY_B' });
    }
  }

  const observations: TextComparisonResult['observations'] = [];

  if (aDiffDates.length > 0 && bDiffDates.length > 0) {
    observations.push({
      type: 'POTENTIAL_CONTRADICTION',
      summary: 'Conflicting date references between compared texts',
      detail: `"${labelA}" references [${aDiffDates.join(', ')}], whereas "${labelB}" references [${bDiffDates.join(', ')}].`,
      alternative_explanation:
        'One source may state the publication/upload date while the other states the incident date, or timezone shifts across midnight may explain a 1-day difference.',
    });
  } else if (matchingDates.length > 0) {
    observations.push({
      type: 'MATCH',
      summary: `Consistent date references (${matchingDates.join(', ')})`,
      detail: `Both "${labelA}" and "${labelB}" reference matching date(s): ${matchingDates.join(', ')}.`,
      alternative_explanation: 'Corroborating temporal references across sources.',
    });
  }

  if (aDiffLocs.length > 0 && bDiffLocs.length > 0) {
    observations.push({
      type: 'POTENTIAL_CONTRADICTION',
      summary: 'Location references diverge between sources',
      detail: `"${labelA}" mentions location(s) [${aDiffLocs.join(', ')}], while "${labelB}" mentions [${bDiffLocs.join(', ')}].`,
      alternative_explanation:
        'A broader city/region name vs a specific street/terminal name may refer to the same geographic site; verify geospatial containment before concluding contradiction.',
    });
  }

  if (aDiffNums.length > 0 && bDiffNums.length > 0) {
    observations.push({
      type: 'REQUIRES_REVIEW',
      summary: 'Divergent numerical values require verification',
      detail: `"${labelA}" cites [${aDiffNums.slice(0, 5).join(', ')}] vs "${labelB}" citing [${bDiffNums.slice(0, 5).join(', ')}].`,
      alternative_explanation:
        'Rounding, unit conversion, estimates vs exact counts, or figures referring to different sub-events.',
    });
  }

  if (cosine >= 0.55) {
    observations.push({
      type: 'MATCH',
      summary: `Moderate-to-high lexical overlap (cosine ${(cosine * 100).toFixed(0)}%)`,
      detail: `Shared thematic terms: ${sharedKeywords.slice(0, 8).join(', ') || 'general vocabulary'}.`,
      alternative_explanation: 'Both texts describe closely related subjects or share paraphrased statements.',
    });
  } else {
    observations.push({
      type: 'DIFFERENCE',
      summary: `Low lexical similarity (cosine ${(cosine * 100).toFixed(0)}%, Jaccard ${(jaccard * 100).toFixed(0)}%)`,
      detail: `Sources use substantially different phrasing or focus on different details.`,
      alternative_explanation:
        'A wording difference is not automatically a factual contradiction; a short social caption and a verbatim audio transcript naturally exhibit low lexical overlap.',
    });
  }

  return {
    source_a_label: labelA,
    source_b_label: labelB,
    jaccard_similarity: jaccard,
    cosine_similarity: cosine,
    shared_keywords: sharedKeywords,
    only_in_a_keywords: onlyInA,
    only_in_b_keywords: onlyInB,
    matching_dates: matchingDates,
    conflicting_dates: { a: aDiffDates, b: bDiffDates },
    matching_times: matchingTimes,
    conflicting_times: { a: aDiffTimes, b: bDiffTimes },
    matching_numbers: matchingNumbers,
    conflicting_numbers: { a: aDiffNums, b: bDiffNums },
    matching_locations: matchingLocations,
    conflicting_locations: { a: aDiffLocs, b: bDiffLocs },
    matching_entities: matchingEntities,
    diff_tokens: diffTokens,
    observations,
    disclaimer:
      'A wording difference is not automatically a factual contradiction. All extracted dates, numbers, and location divergences require human contextual review.',
  };
}

export async function analyzeTextEvidence(params: {
  investigation_id: string;
  evidence_id: string;
  original_filename: string;
  content: string;
}): Promise<ExtractedTextSignals & { evidence_id: string; analysis_methods: string[]; limitations: string[] }> {
  const signals = extractTextSignals(params.content);
  const ref = `${params.original_filename} (${params.evidence_id})`;

  insertFinding({
    investigation_id: params.investigation_id,
    evidence_id: params.evidence_id,
    module: 'TEXT_ANALYSIS',
    finding_type: 'TEXT_ENTITY_EXTRACTION',
    title: `Indexed text document (${signals.word_count} words, ${signals.dates.length} dates, ${signals.locations.length} locations)`,
    description: `Extracted structured forensic cues from ${params.original_filename}: Dates [${signals.dates.join(', ') || 'none'}], Times [${signals.times.join(', ') || 'none'}], Locations [${signals.locations.join(', ') || 'none'}], Numerical claims [${signals.numbers.slice(0, 6).join(', ') || 'none'}].`,
    evidence_reference: ref,
    timestamp_or_region: `${signals.sentence_count} sentence(s)`,
    analysis_category: 'DETERMINISTIC',
    evidence_strength: 'MODERATE',
    uncertainty: 'NONE',
    limitations: 'Rule-based entity and location extraction may miss colloquial place references or lowercase proper nouns.',
    alternative_explanation: 'Automated structured cue indexing prior to cross-modal comparison.',
  });

  return {
    evidence_id: params.evidence_id,
    ...signals,
    analysis_methods: [
      'Unicode & whitespace text normalization',
      'Regex temporal extraction (ISO, calendar dates, 12h/24h timestamps)',
      'Numerical & unit claim extraction',
      'Preposition-context & gazetteer location extraction',
      'Lexical TF cosine & Jaccard token comparison',
    ],
    limitations: [
      'Wording variations do not automatically constitute factual contradictions.',
      'Rule-based entity recognition requires investigator verification for ambiguous proper nouns.',
    ],
  };
}

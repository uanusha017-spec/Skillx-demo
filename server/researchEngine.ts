import dns from 'dns/promises';
import net from 'net';
import { GoogleGenAI } from '@google/genai';
import type {
  ComputerLabStatus,
  ContactEvidenceItem,
  ContactSourceType,
  DigitalAudit,
  DigitalCheckItem,
  GroundingSource,
  IndustryAnalysis,
  IndustryBenchmarkItem,
  LabVerificationSource,
  ResearchProfile,
  SchoolRecord,
  WebsiteReview,
} from '../src/types';
import { computeServiceAssessment, NATTON_SERVICES } from '../src/data/nattonCatalog';
import { hasValidPhone, isEducationRecord, normalizeLabStatus, safeExternalUrl } from '../src/utils/schoolHelpers';

const GEMINI_MODELS = [
  'gemini-3.1-flash-lite',
  'gemini-4-hydrogen',
] as const;

export class ApiQuotaError extends Error {
  readonly status = 429;
  readonly code = 'RATE_LIMITED';
  readonly retryAfterSeconds: number;

  constructor(message: string, retryAfterSeconds = 30) {
    super(message);
    this.name = 'ApiQuotaError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function isRateLimitError(err: unknown): boolean {
  if (err instanceof ApiQuotaError) return true;
  const raw = err instanceof Error ? err.message : String(err || '');
  return (
    /\b429\b/.test(raw) ||
    /RESOURCE_EXHAUSTED/i.test(raw) ||
    /quota/i.test(raw) ||
    /rate[\s-]?limit/i.test(raw) ||
    /too many requests/i.test(raw)
  );
}

export function formatApiError(err: unknown): {
  status: number;
  code: string;
  message: string;
  retryAfterSeconds?: number;
} {
  if (err instanceof ApiQuotaError) {
    return {
      status: 429,
      code: 'RATE_LIMITED',
      message: err.message,
      retryAfterSeconds: err.retryAfterSeconds,
    };
  }
  const raw = err instanceof Error ? err.message : String(err || 'Request failed');
  if (isRateLimitError(err)) {
    const delayMatch = raw.match(/retryDelay["']?\s*[:=]\s*["']?(\d+)/i) || raw.match(/retry in\s+(\d+)/i);
    const retryAfterSeconds = delayMatch ? Math.max(5, Math.min(120, Number(delayMatch[1]))) : 30;
    return {
      status: 429,
      code: 'RATE_LIMITED',
      retryAfterSeconds,
      message: `API rate limit reached. Verification paused safely — please wait ~${retryAfterSeconds}s and click Resume.`,
    };
  }
  // Never dump raw JSON blobs to users
  if (raw.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(raw) as { error?: { message?: string; code?: number }; message?: string };
      const clean = parsed?.error?.message || parsed?.message;
      if (clean) {
        return {
          status: parsed?.error?.code === 429 ? 429 : 500,
          code: parsed?.error?.code === 429 ? 'RATE_LIMITED' : 'UPSTREAM_ERROR',
          message: clean.split('\n')[0].slice(0, 220),
        };
      }
    } catch {
      // fall through
    }
  }
  return {
    status: 500,
    code: 'SERVER_ERROR',
    message: raw.slice(0, 220),
  };
}

function getSanitizedGeminiKey(): string | null {
  const raw = (process.env.GEMINI_API_KEY || '').trim().replace(/^["']+|["']+$/g, '').trim();
  if (!raw || raw === 'MY_GEMINI_API_KEY') return null;
  return raw;
}

function getSanitizedSerpForgeKey(): string | null {
  let raw = (process.env.SERPFORGE_API_KEY || '').trim();
  if (!raw || raw === 'MY_SERPFORGE_API_KEY') return null;
  raw = raw.replace(/^["']+|["']+$/g, '').trim();
  raw = raw.replace(/^(?:x-api-key|authorization)\s*:\s*/i, '').trim();
  raw = raw.replace(/^bearer\s+/i, '').trim();
  raw = raw.replace(/^["']+|["']+$/g, '').trim();
  return raw || null;
}

function getSanitizedSerpForgeBase(): string {
  let raw = (process.env.SERPFORGE_BASE_URL || 'https://serpforge.ai.studio/api/v1').trim();
  raw = raw.replace(/^["']+|["']+$/g, '').trim().replace(/\/+$/, '');
  raw = raw.replace(/\/(search|places|news|images|scholar)$/i, '');
  if (/^https?:\/\/[^/]+$/i.test(raw)) {
    raw = `${raw}/api/v1`;
  }
  return raw;
}

let lastSerpForgeDiagnostic: { status: number; message: string; checkedAt: string } | null = null;
let lastGeminiDiagnostic: { model: string; status: string; message: string; checkedAt: string } | null = null;
const geminiModelDiagnostics: Record<string, { status: string; message: string; checkedAt: string }> = {};
const modelCooldownUntil = new Map<string, number>();
const searchToolCooldownUntil = new Map<string, number>();
let consecutiveEmptySerpCount = 0;

function hasAvailableGeminiModel(): boolean {
  if (!getSanitizedGeminiKey()) return false;
  const now = Date.now();
  return GEMINI_MODELS.some((m) => (modelCooldownUntil.get(m) || 0) <= now);
}

function getSoonestGeminiCooldownSeconds(): number {
  const now = Date.now();
  let minWaitMs = Infinity;
  for (const m of GEMINI_MODELS) {
    const until = modelCooldownUntil.get(m) || 0;
    if (until <= now) return 0;
    minWaitMs = Math.min(minWaitMs, until - now);
  }
  return Number.isFinite(minWaitMs) ? Math.max(5, Math.ceil(minWaitMs / 1000)) : 30;
}

function getGeminiClient(): GoogleGenAI | null {
  const apiKey = getSanitizedGeminiKey();
  if (!apiKey) return null;
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function hasSerpForgeKey(): boolean {
  return Boolean(getSanitizedSerpForgeKey());
}

export function getSearchEngineStatus() {
  const hasGemini = Boolean(getSanitizedGeminiKey());
  const hasSerpForge = hasSerpForgeKey();
  if (hasSerpForge && hasGemini) {
    return {
      provider: 'serpforge+gemini' as const,
      ready: true,
      lifetimeAccess: true,
      hasGemini,
      hasSerpForge,
      label: 'Live Google Search Grounding + SerpForge Active',
      serpForgeDiagnostic: lastSerpForgeDiagnostic,
      geminiDiagnostic: lastGeminiDiagnostic,
      geminiModelDiagnostics,
    };
  }
  if (hasSerpForge) {
    return {
      provider: 'serpforge' as const,
      ready: true,
      lifetimeAccess: true,
      hasGemini: false,
      hasSerpForge: true,
      label: 'SerpForge Live Google Search Active (Lifetime Server Access)',
      serpForgeDiagnostic: lastSerpForgeDiagnostic,
      geminiDiagnostic: lastGeminiDiagnostic,
      geminiModelDiagnostics,
    };
  }
  if (hasGemini) {
    return {
      provider: 'gemini-search' as const,
      ready: true,
      lifetimeAccess: true,
      hasGemini,
      hasSerpForge: false,
      label: 'Live Google Search & Industry AI Active (Lifetime Server Access)',
      serpForgeDiagnostic: lastSerpForgeDiagnostic,
      geminiDiagnostic: lastGeminiDiagnostic,
      geminiModelDiagnostics,
    };
  }
  return {
    provider: 'unconfigured' as const,
    ready: false,
    lifetimeAccess: false,
    hasGemini: false,
    hasSerpForge: false,
    label: 'Server search key not configured in Secrets',
    serpForgeDiagnostic: lastSerpForgeDiagnostic,
    geminiDiagnostic: lastGeminiDiagnostic,
    geminiModelDiagnostics,
  };
}

interface SerpResultItem {
  title: string;
  link: string;
  snippet?: string;
  phoneNumber?: string;
  address?: string;
  website?: string;
  rating?: number;
  ratingCount?: number;
  category?: string;
  sourceKind: 'knowledgeGraph' | 'places' | 'organic' | 'answerBox';
}

const IGNORED_LOCATION_WORDS = new Set([
  'unassigned',
  'unassigned area',
  'unknown',
  'n/a',
  'na',
  'none',
  'null',
  'nil',
  '-',
  '--',
]);

function buildCleanLocation(area?: string, city?: string, state?: string): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const raw of [area, city, state]) {
    if (!raw) continue;
    const cleaned = String(raw).trim().replace(/\s+/g, ' ');
    const lower = cleaned.toLowerCase();
    if (!cleaned || IGNORED_LOCATION_WORDS.has(lower)) continue;
    if (seen.has(lower)) continue;
    // Skip if already contained as substring in an existing token
    if (parts.some((p) => p.toLowerCase().includes(lower) || lower.includes(p.toLowerCase()))) {
      if (parts.some((p) => lower.includes(p.toLowerCase()) && lower.length > p.length)) {
        const idx = parts.findIndex((p) => lower.includes(p.toLowerCase()));
        if (idx !== -1) parts[idx] = cleaned;
      }
      continue;
    }
    seen.add(lower);
    parts.push(cleaned);
  }
  return parts.join(', ');
}

function buildShortSearchLocation(area?: string, city?: string, state?: string): string {
  const candidates: string[] = [];
  for (const raw of [area, city, state]) {
    if (!raw) continue;
    // Take only the first concise locality segment before commas to avoid choking search queries
    const firstPart = String(raw).split(',')[0].trim().replace(/\s+/g, ' ');
    const lower = firstPart.toLowerCase();
    if (!firstPart || IGNORED_LOCATION_WORDS.has(lower)) continue;
    if (candidates.some((c) => c.toLowerCase() === lower || c.toLowerCase().includes(lower) || lower.includes(c.toLowerCase()))) {
      continue;
    }
    candidates.push(firstPart.slice(0, 32));
    if (candidates.length >= 2) break;
  }
  return candidates.join(' ');
}

const REGION_SIGNATURES: Array<{ pattern: RegExp; region: string }> = [
  { pattern: /\b(hubli|hubballi|dharwad|navanagar|vidyagiri|sattur|garag|keshwapur|vidyanagar|unakal|gokul\s+road)\b|\b0836[-\s]?\d{6,7}\b/i, region: 'Hubli-Dharwad, Karnataka' },
  { pattern: /\b(bengaluru|bangalore|whitefield|indiranagar|koramangala|jayanagar|yelahanka)\b|\b080[-\s]?\d{7,8}\b/i, region: 'Bengaluru, Karnataka' },
  { pattern: /\b(belagavi|belgaum)\b|\b0831[-\s]?\d{6,7}\b/i, region: 'Belagavi, Karnataka' },
  { pattern: /\b(mysuru|mysore)\b|\b0821[-\s]?\d{6,7}\b/i, region: 'Mysuru, Karnataka' },
  { pattern: /\b(mangaluru|mangalore)\b|\b0824[-\s]?\d{6,7}\b/i, region: 'Mangaluru, Karnataka' },
  { pattern: /\b(kalaburagi|gulbarga)\b|\b08472[-\s]?\d{5,6}\b/i, region: 'Kalaburagi, Karnataka' },
  { pattern: /\b(shivamogga|shimoga)\b|\b08182[-\s]?\d{5,6}\b/i, region: 'Shivamogga, Karnataka' },
  { pattern: /\b(davanagere|davangere)\b|\b08192[-\s]?\d{5,6}\b/i, region: 'Davanagere, Karnataka' },
  { pattern: /\b(gadag|betageri|haveri|ranebennur|koppal|ballari|bellary)\b/i, region: 'North Karnataka, India' },
  { pattern: /\b(pune|pimpri|chinchwad)\b|\b020[-\s]?\d{7,8}\b/i, region: 'Pune, Maharashtra' },
  { pattern: /\b(mumbai|thane|navi\s+mumbai)\b|\b022[-\s]?\d{7,8}\b/i, region: 'Mumbai, Maharashtra' },
  { pattern: /\b(hyderabad|secunderabad)\b|\b040[-\s]?\d{7,8}\b/i, region: 'Hyderabad, Telangana' },
  { pattern: /\b(chennai)\b|\b044[-\s]?\d{7,8}\b/i, region: 'Chennai, Tamil Nadu' },
  { pattern: /\b(new\s+delhi|delhi|noida|gurgaon|gurugram)\b|\b011[-\s]?\d{7,8}\b/i, region: 'Delhi NCR, India' },
];

export function inferDatasetRegionHint(records: SchoolRecord[]): string {
  if (!records || records.length === 0) return '';
  const regionScores = new Map<string, number>();
  const stateCounts = new Map<string, number>();

  for (const r of records.slice(0, 300)) {
    const blob = [r.area, r.city, r.state, r.address, r.contactPhone, r.name].filter(Boolean).join(' ');
    for (const sig of REGION_SIGNATURES) {
      if (sig.pattern.test(blob)) {
        regionScores.set(sig.region, (regionScores.get(sig.region) || 0) + 1);
      }
    }
    const st = (r.state || '').trim();
    if (st && !IGNORED_LOCATION_WORDS.has(st.toLowerCase())) {
      stateCounts.set(st, (stateCounts.get(st) || 0) + 1);
    }
  }

  let bestRegion = '';
  let bestScore = 0;
  for (const [region, score] of regionScores.entries()) {
    if (score > bestScore) {
      bestScore = score;
      bestRegion = region;
    }
  }
  if (bestRegion && bestScore >= 2) {
    return bestRegion;
  }

  let bestState = '';
  let bestStateScore = 0;
  for (const [st, score] of stateCounts.entries()) {
    if (score > bestStateScore) {
      bestStateScore = score;
      bestState = st;
    }
  }
  return bestState || bestRegion || '';
}

function buildEffectiveLocation(
  area?: string,
  city?: string,
  state?: string,
  regionHint?: string
): string {
  const base = buildCleanLocation(area, city, state);
  const hint = (regionHint || '').trim();
  if (!hint) return base || 'India';
  if (!base) return hint;
  const lowerBase = base.toLowerCase();
  const hintTokens = hint
    .toLowerCase()
    .split(/[,\s-]+/)
    .filter((t) => t.length >= 4);
  const alreadyHasRegion = hintTokens.some((tok) => lowerBase.includes(tok));
  return alreadyHasRegion ? base : `${base}, ${hint}`;
}

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const octets = ip.split('.').map(Number);
    if (octets.length !== 4) return true;
    const [a, b] = octets;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    return (
      lower === '::1' ||
      lower === '::' ||
      lower.startsWith('fc') ||
      lower.startsWith('fd') ||
      lower.startsWith('fe80') ||
      lower.startsWith('::ffff:127.') ||
      lower.startsWith('::ffff:10.') ||
      lower.startsWith('::ffff:192.168.') ||
      lower.startsWith('::ffff:169.254.')
    );
  }
  return true;
}

async function isSafePublicUrl(rawUrl?: string): Promise<string | undefined> {
  const safe = safeExternalUrl(rawUrl);
  if (!safe) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(safe);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined;
  const host = parsed.hostname.toLowerCase();
  if (
    !host ||
    host === 'localhost' ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.localhost')
  ) {
    return undefined;
  }
  if (net.isIP(host)) {
    return isPrivateIp(host) ? undefined : parsed.toString();
  }
  try {
    const records = await dns.lookup(host, { all: true });
    if (!records.length || records.some((r) => isPrivateIp(r.address))) {
      return undefined;
    }
    return parsed.toString();
  } catch {
    return undefined;
  }
}

async function querySerpForge(
  query: string,
  endpoint: 'search' | 'places' = 'search',
  num = 10
): Promise<{ ok: boolean; status: number; errorMessage?: string; items: SerpResultItem[] }> {
  const apiKey = getSanitizedSerpForgeKey();
  if (!apiKey) {
    return { ok: false, status: 0, errorMessage: 'SERPFORGE_API_KEY not set', items: [] };
  }
  const rawBase = getSanitizedSerpForgeBase();
  const safeTarget = await isSafePublicUrl(`${rawBase}/${endpoint}`);
  if (!safeTarget) {
    lastSerpForgeDiagnostic = {
      status: 0,
      message: 'Invalid SERPFORGE_BASE_URL',
      checkedAt: new Date().toISOString(),
    };
    return { ok: false, status: 0, errorMessage: 'Invalid SERPFORGE_BASE_URL', items: [] };
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20000);
      const resp = await fetch(safeTarget, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-KEY': apiKey,
          'User-Agent': 'aistudio-build',
        },
        body: JSON.stringify({ q: query, gl: 'in', hl: 'en', num }),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!resp.ok) {
        let errText = `HTTP ${resp.status}`;
        try {
          const bodyTxt = await resp.text();
          const parsed = JSON.parse(bodyTxt) as { message?: string; error?: string };
          if (parsed.message || parsed.error) {
            errText = `HTTP ${resp.status}: ${String(parsed.message || parsed.error).slice(0, 140)}`;
          }
        } catch {
          // ignore non-json error body
        }
        lastSerpForgeDiagnostic = { status: resp.status, message: errText, checkedAt: new Date().toISOString() };
        if ((resp.status === 429 || resp.status >= 500) && attempt === 0) {
          await new Promise((r) => setTimeout(r, 1200));
          continue;
        }
        return { ok: false, status: resp.status, errorMessage: errText, items: [] };
      }

      const rawData = (await resp.json()) as Record<string, unknown>;
      const data = ((rawData.data && typeof rawData.data === 'object' ? rawData.data : rawData) || {}) as {
        answerBox?: { title?: string; answer?: string; snippet?: string; link?: string; url?: string };
        answer_box?: { title?: string; answer?: string; snippet?: string; link?: string; url?: string };
        knowledgeGraph?: {
          title?: string;
          website?: string;
          description?: string;
          descriptionLink?: string;
          rating?: number;
          ratingCount?: number;
          type?: string;
          attributes?: Record<string, string>;
        };
        knowledge_graph?: {
          title?: string;
          website?: string;
          description?: string;
          descriptionLink?: string;
          rating?: number;
          ratingCount?: number;
          type?: string;
          attributes?: Record<string, string>;
        };
        organic?: Array<{
          title?: string;
          link?: string;
          url?: string;
          snippet?: string;
          description?: string;
          attributes?: Record<string, string>;
        }>;
        organic_results?: Array<{
          title?: string;
          link?: string;
          url?: string;
          snippet?: string;
          description?: string;
          attributes?: Record<string, string>;
        }>;
        results?: Array<{
          title?: string;
          link?: string;
          url?: string;
          snippet?: string;
          description?: string;
          attributes?: Record<string, string>;
        }>;
        places?: Array<{
          title?: string;
          name?: string;
          website?: string;
          link?: string;
          url?: string;
          phoneNumber?: string;
          phone?: string;
          telephone?: string;
          address?: string;
          rating?: number;
          ratingCount?: number;
          category?: string;
        }>;
        local_results?: Array<{
          title?: string;
          name?: string;
          website?: string;
          link?: string;
          url?: string;
          phoneNumber?: string;
          phone?: string;
          telephone?: string;
          address?: string;
          rating?: number;
          ratingCount?: number;
          category?: string;
        }>;
        peopleAlsoAsk?: Array<{
          question?: string;
          snippet?: string;
          link?: string;
        }>;
      };

      const items: SerpResultItem[] = [];
      const answerBox = data.answerBox || data.answer_box;
      if (answerBox && (answerBox.answer || answerBox.snippet)) {
        items.push({
          title: answerBox.title || 'Google Answer Box',
          link: answerBox.link || answerBox.url || '',
          snippet: [answerBox.answer, answerBox.snippet].filter(Boolean).join(' — '),
          sourceKind: 'answerBox',
        });
      }

      const kg = data.knowledgeGraph || data.knowledge_graph;
      if (kg?.title) {
        const attrs = kg.attributes || {};
        const kgPhone =
          attrs.Phone || attrs.phone || attrs['Phone number'] || attrs['Customer service'] || attrs.Contact || '';
        const kgAddress = attrs.Address || attrs.address || attrs.Location || '';
        const attrSummary = Object.entries(attrs)
          .map(([k, v]) => `${k}: ${v}`)
          .join(' · ');
        items.push({
          title: kg.title,
          link: kg.website || kg.descriptionLink || '',
          snippet: [kg.description, attrSummary].filter(Boolean).join(' · '),
          phoneNumber: kgPhone || undefined,
          address: kgAddress || undefined,
          website: kg.website,
          rating: kg.rating,
          ratingCount: kg.ratingCount,
          category: kg.type,
          sourceKind: 'knowledgeGraph',
        });
      }

      const placesList = Array.isArray(data.places)
        ? data.places
        : Array.isArray(data.local_results)
        ? data.local_results
        : [];
      for (const p of placesList) {
        const title = p.title || p.name;
        if (title) {
          const phone = p.phoneNumber || p.phone || p.telephone;
          items.push({
            title,
            link: p.website || p.link || p.url || '',
            snippet: [p.category, p.address, phone, p.rating ? `Rating ${p.rating}/5 (${p.ratingCount || 0} reviews)` : '']
              .filter(Boolean)
              .join(' · '),
            phoneNumber: phone,
            address: p.address,
            website: p.website,
            rating: p.rating,
            ratingCount: p.ratingCount,
            category: p.category,
            sourceKind: 'places',
          });
        }
      }

      const organicList = Array.isArray(data.organic)
        ? data.organic
        : Array.isArray(data.organic_results)
        ? data.organic_results
        : Array.isArray(data.results)
        ? data.results
        : [];
      for (const o of organicList) {
        const link = o.link || o.url || '';
        const snippet = o.snippet || o.description || '';
        if (o.title && (link || snippet)) {
          const attrText = o.attributes
            ? Object.entries(o.attributes)
                .map(([k, v]) => `${k}: ${v}`)
                .join(' · ')
            : '';
          items.push({
            title: o.title,
            link,
            snippet: [snippet, attrText].filter(Boolean).join(' · '),
            sourceKind: 'organic',
          });
        }
      }

      if (Array.isArray(data.peopleAlsoAsk)) {
        for (const paa of data.peopleAlsoAsk.slice(0, 3)) {
          if (paa.snippet) {
            items.push({
              title: paa.question || 'People Also Ask',
              link: paa.link || '',
              snippet: paa.snippet,
              sourceKind: 'organic',
            });
          }
        }
      }

      lastSerpForgeDiagnostic = {
        status: resp.status,
        message: `OK (${items.length} results)`,
        checkedAt: new Date().toISOString(),
      };
      if (items.length === 0) {
        consecutiveEmptySerpCount = Math.min(20, consecutiveEmptySerpCount + 1);
      } else {
        consecutiveEmptySerpCount = 0;
      }
      return { ok: true, status: resp.status, items: items.slice(0, 14) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Network error';
      lastSerpForgeDiagnostic = { status: 0, message: msg.slice(0, 120), checkedAt: new Date().toISOString() };
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 900));
        continue;
      }
      return { ok: false, status: 0, errorMessage: msg, items: [] };
    }
  }
  return { ok: false, status: 0, errorMessage: 'SerpForge unavailable', items: [] };
}

const DIRECTORY_DOMAINS = [
  'justdial.com',
  'schools.org.in',
  'icbse.com',
  'shiksha.com',
  'sulekha.com',
  'indiamart.com',
  'tradeindia.com',
  'facebook.com',
  'instagram.com',
  'youtube.com',
  'linkedin.com',
  'twitter.com',
  'x.com',
  'wikipedia.org',
  'uniapply.com',
  'edustoke.com',
  'schoolmykids.com',
  'targetstudy.com',
  'practo.com',
  'zomato.com',
  'swiggy.com',
  'tripadvisor.in',
  'tripadvisor.com',
  'google.com',
  'maps.google.com',
  'yellowpages.in',
  'ambitionbox.com',
  'glassdoor.co.in',
  'glassdoor.com',
  'collegedunia.com',
  'careers360.com',
  'studychacha.com',
  'learnpick.in',
  'urbanpro.com',
];

function isDirectoryOrSocialUrl(url?: string): boolean {
  if (!url) return true;
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    return DIRECTORY_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
  } catch {
    return true;
  }
}

const SCHOOL_DIRECTORY_DOMAINS = [
  'schools.org.in',
  'icbse.com',
  'schoolmykids.com',
  'edustoke.com',
  'uniapply.com',
  'targetstudy.com',
  'shiksha.com',
  'justdial.com',
  'sulekha.com',
  'yayskool.com',
  'vidyatime.com',
  'schoolspedia.com',
];

function isSchoolDirectoryUrl(url?: string): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    return SCHOOL_DIRECTORY_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

function pickSchoolDirectoryUrls(items: SerpResultItem[], max = 2): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const candidate = safeExternalUrl(item.link || item.website);
    if (candidate && isSchoolDirectoryUrl(candidate) && !seen.has(candidate)) {
      seen.add(candidate);
      out.push(candidate);
      if (out.length >= max) break;
    }
  }
  return out;
}

function pickBestOfficialWebsite(items: SerpResultItem[], fallbackUrl?: string): string | undefined {
  const safeFallback = safeExternalUrl(fallbackUrl);
  if (safeFallback && !isDirectoryOrSocialUrl(safeFallback)) return safeFallback;

  for (const item of items) {
    const candidate = safeExternalUrl(item.website || item.link);
    if (candidate && !isDirectoryOrSocialUrl(candidate)) {
      return candidate;
    }
  }
  return safeFallback;
}

function cleanPhoneCandidate(phone?: string | null): string | undefined {
  if (!phone) return undefined;
  const cleaned = String(phone)
    .trim()
    .replace(/^tel:/i, '')
    .replace(/\s+/g, ' ')
    .replace(/[.,;:|]+$/, '');
  return hasValidPhone(cleaned) ? cleaned : undefined;
}

function extractPhonesFromText(text: string): string[] {
  if (!text) return [];
  const results: string[] = [];
  const seen = new Set<string>();
  const patterns = [
    /(?:\+91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}\b/g,
    /(?:\+91[\s-]?)?0\d{2,4}[\s/-]\d{6,8}\b/g,
    /\b08\d{2}[\s/-]?\d{6,7}\b/g,
    /\b\d{3,4}[-\s]\d{7,8}\b/g,
  ];
  for (const rx of patterns) {
    const matches = text.match(rx) || [];
    for (const m of matches) {
      const candidate = cleanPhoneCandidate(m);
      if (!candidate) continue;
      const digits = candidate.replace(/\D/g, '');
      // Skip likely years, UDISE codes (11 digits starting with 29...), or repeating junk
      if (digits.length > 13 || digits.length < 10) continue;
      if (/^(\d)\1{6,}$/.test(digits)) continue;
      if (digits.length === 11 && !digits.startsWith('0')) continue;
      if (!seen.has(digits)) {
        seen.add(digits);
        results.push(candidate);
      }
    }
  }
  return results.slice(0, 4);
}

function cleanEmailCandidate(email?: string | null): string | undefined {
  if (!email) return undefined;
  const match = String(email)
    .trim()
    .match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  if (!match) return undefined;
  const val = match[0].toLowerCase();
  if (
    val.endsWith('.png') ||
    val.endsWith('.jpg') ||
    val.endsWith('.jpeg') ||
    val.endsWith('.webp') ||
    val.endsWith('.svg') ||
    val.includes('example.com') ||
    val.includes('wixpress.com') ||
    val.includes('sentry.io') ||
    val.includes('domain.com')
  ) {
    return undefined;
  }
  return val;
}

function extractEmailsFromText(text: string): string[] {
  if (!text) return [];
  const matches = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of matches) {
    const clean = cleanEmailCandidate(m);
    if (clean && !seen.has(clean)) {
      seen.add(clean);
      out.push(clean);
    }
  }
  return out.slice(0, 3);
}

interface WebsiteInspectionResult {
  url: string;
  reachable: boolean;
  title?: string;
  metaDescription?: string;
  hasH1Heading: boolean;
  hasViewport: boolean;
  hasSchema: boolean;
  hasAnalytics: boolean;
  hasPaidPixels: boolean;
  hasMetaPixel: boolean;
  hasGoogleAdsTag: boolean;
  hasLeadForm: boolean;
  hasWhatsApp: boolean;
  hasEcommerce: boolean;
  hasBlogOrContent: boolean;
  hasEmailMarketing: boolean;
  hasChatbotOrLiveChat: boolean;
  hasCrmScript: boolean;
  hasCloudTelephony: boolean;
  hasGoogleMapsEmbed: boolean;
  hasFaqOrAeo: boolean;
  hasBrandMedia: boolean;
  hiringOrNeedSignals: string[];
  phones: string[];
  emails: string[];
  socialProfiles: Array<{ platform: string; url: string }>;
  plainText: string;
  candidateSubpages?: string[];
}

async function inspectPublicWebsiteSafe(rawUrl?: string, timeoutMs = 4200): Promise<WebsiteInspectionResult | null> {
  const safeUrl = await isSafePublicUrl(rawUrl);
  if (!safeUrl) return null;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const resp = await fetch(safeUrl, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; NattonResearchBot/1.0)',
        Accept: 'text/html,application/xhtml+xml',
      },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) return null;

    // Verify redirected destination is still safe public URL
    if (resp.url && resp.url !== safeUrl) {
      const safeFinal = await isSafePublicUrl(resp.url);
      if (!safeFinal) return null;
    }

    const contentType = resp.headers.get('content-type') || '';
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
      return null;
    }

    // Cap HTML body to 250 KB
    const reader = resp.body?.getReader();
    let html = '';
    if (reader) {
      const decoder = new TextDecoder('utf-8');
      let bytes = 0;
      while (bytes < 250_000) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        html += decoder.decode(value, { stream: true });
      }
      try {
        await reader.cancel();
      } catch {
        // ignore
      }
    } else {
      html = (await resp.text()).slice(0, 250_000);
    }

    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim().slice(0, 140) : undefined;
    const descMatch =
      html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i) ||
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i);
    const metaDescription = descMatch ? descMatch[1].replace(/\s+/g, ' ').trim().slice(0, 220) : undefined;

    const hasH1Heading = /<h1[\s>][\s\S]*?<\/h1>/i.test(html);
    const hasViewport = /<meta[^>]+name=["']viewport["']/i.test(html);
    const hasSchema = /application\/ld\+json/i.test(html);
    const hasAnalytics = /googletagmanager\.com|google-analytics\.com|gtag\(|clarity\.ms|plausible\.io|hotjar\.com/i.test(html);
    const hasMetaPixel = /connect\.facebook\.net\/.*fbevents|fbq\(|facebook\.com\/tr\?id=/i.test(html);
    const hasGoogleAdsTag = /googleadservices\.com|AW-\d{6,}|doubleclick\.net/i.test(html);
    const hasPaidPixels = hasMetaPixel || hasGoogleAdsTag;
    const hasLeadForm = /<form[\s>]|admission|enquir|book\s+now|appointment|request\s+a?\s*quote|contact\s+us/i.test(html);
    const hasWhatsApp = /wa\.me\/|api\.whatsapp\.com|whatsapp\.com\/send|chat\.whatsapp|wati\.io|aisensy|interakt/i.test(html);
    const hasEcommerce = /add\s+to\s+cart|woocommerce|shopify|razorpay|checkout|shop\s+now|cashfree|payu/i.test(html);
    const hasBlogOrContent = /href=["'][^"']*\/(blog|articles|news|insights|resources|guides)\b|<article[\s>]/i.test(html);
    const hasEmailMarketing = /newsletter|subscribe\s+to|mailchimp|klaviyo|brevo\.com|sendinblue|convertkit|mailerlite|constantcontact/i.test(html);
    const hasChatbotOrLiveChat = /tawk\.to|intercom|crisp\.chat|freshchat|zopim|zendesk|tidio|drift\.com|livechat|botpress|yellow\.ai|chatbot|wchat/i.test(html);
    const hasCrmScript = /hs-scripts\.com|hubspot|zoho\.(com|in)\/crm|salesforce|leadsquared|freshsales|pipedrive|bitrix24|crm\.zoho/i.test(html);
    const hasCloudTelephony = /href=["']tel:|1800[-\s]?\d|exotel|knowlarity|myoperator|ozontel|kaleyra|call\s*back|callback/i.test(html);
    const hasGoogleMapsEmbed = /google\.com\/maps|maps\.google\.com|goo\.gl\/maps|g\.page\//i.test(html);
    const hasFaqOrAeo = /FAQPage|HowTo|frequently\s+asked\s+questions|href=["'][^"']*\/faq/i.test(html);
    const hasBrandMedia = /og:image|twitter:image|<video[\s>]|brochure\.pdf|catalogue\.pdf/i.test(html);

    const hiringOrNeedSignals: string[] = [];
    if (/hiring\s+(digital\s+marketing|seo|social\s+media|web\s+developer|marketing\s+manager|crm)/i.test(html)) {
      hiringOrNeedSignals.push('Public careers/hiring signal for digital marketing or web role detected on website');
    }
    if (/looking\s+for\s+(digital\s+marketing|website|seo|agency|vendor|crm|whatsapp)/i.test(html)) {
      hiringOrNeedSignals.push('Public vendor/service requirement wording detected on website');
    }

    // Extract tel: and mailto:
    const telMatches = Array.from(html.matchAll(/href=["']tel:([^"']+)["']/gi))
      .map((m) => cleanPhoneCandidate(m[1]))
      .filter((v): v is string => Boolean(v));
    const mailtoMatches = Array.from(html.matchAll(/href=["']mailto:([^"'?]+)["']/gi))
      .map((m) => cleanEmailCandidate(m[1]))
      .filter((v): v is string => Boolean(v));

    // Extract social links
    const socialProfiles: Array<{ platform: string; url: string }> = [];
    const socialRegexes: Array<[string, RegExp]> = [
      ['Instagram', /https?:\/\/(?:www\.)?instagram\.com\/[a-zA-Z0-9._-]+/i],
      ['Facebook', /https?:\/\/(?:www\.)?facebook\.com\/[a-zA-Z0-9._/-]+/i],
      ['LinkedIn', /https?:\/\/(?:www\.)?linkedin\.com\/(?:company|school|in)\/[a-zA-Z0-9._-]+/i],
      ['YouTube', /https?:\/\/(?:www\.)?youtube\.com\/(?:@|channel\/|c\/|user\/)[a-zA-Z0-9._-]+/i],
    ];
    for (const [platform, rx] of socialRegexes) {
      const m = html.match(rx);
      if (m && safeExternalUrl(m[0])) {
        socialProfiles.push({ platform, url: safeExternalUrl(m[0])! });
      }
    }

    const plainText = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 20000);

    const phones = Array.from(new Set([...telMatches, ...extractPhonesFromText(plainText)])).slice(0, 4);
    const emails = Array.from(new Set([...mailtoMatches, ...extractEmailsFromText(plainText)])).slice(0, 3);

    // Discover same-origin facilities / computer-lab / disclosure / contact subpages
    const candidateSubpages: string[] = [];
    try {
      const origin = new URL(safeUrl).origin;
      const seenSub = new Set<string>([safeUrl]);
      const hrefMatches = Array.from(html.matchAll(/href=["']([^"'#]+)["']/gi));
      for (const m of hrefMatches) {
        const rawHref = m[1].trim();
        if (!rawHref || /^(?:mailto:|tel:|javascript:)/i.test(rawHref)) continue;
        if (!/(?:facilit|infrastruct|computer|lab|contact|disclosure|mandatory|about)/i.test(rawHref)) continue;
        try {
          const resolved = new URL(rawHref, safeUrl);
          if (resolved.origin !== origin) continue;
          const cleanHref = resolved.toString();
          if (!seenSub.has(cleanHref) && !/\.(?:pdf|jpg|jpeg|png|webp|svg|zip|doc|docx)$/i.test(resolved.pathname)) {
            seenSub.add(cleanHref);
            candidateSubpages.push(cleanHref);
            if (candidateSubpages.length >= 2) break;
          }
        } catch {
          // ignore invalid href
        }
      }
    } catch {
      // ignore URL parse error
    }

    return {
      url: safeUrl,
      reachable: true,
      title,
      metaDescription,
      hasH1Heading,
      hasViewport,
      hasSchema,
      hasAnalytics,
      hasPaidPixels,
      hasMetaPixel,
      hasGoogleAdsTag,
      hasLeadForm,
      hasWhatsApp,
      hasEcommerce,
      hasBlogOrContent,
      hasEmailMarketing,
      hasChatbotOrLiveChat,
      hasCrmScript,
      hasCloudTelephony,
      hasGoogleMapsEmbed,
      hasFaqOrAeo,
      hasBrandMedia,
      hiringOrNeedSignals,
      phones,
      emails,
      socialProfiles,
      plainText,
      candidateSubpages,
    };
  } catch {
    return null;
  }
}

function extractMatchingSentence(text: string, regex: RegExp): string | undefined {
  const sentences = text.split(/(?<=[.!?])\s+|\s*[·|]\s*/);
  for (const s of sentences) {
    if (regex.test(s) && s.trim().length > 12) {
      return s.trim().slice(0, 220);
    }
  }
  const m = text.match(regex);
  if (!m || m.index === undefined) return undefined;
  const start = Math.max(0, m.index - 70);
  const end = Math.min(text.length, m.index + 160);
  return text.slice(start, end).trim();
}

function nameTokensMatch(schoolName: string, text: string): boolean {
  const stopWords = new Set(['school', 'high', 'public', 'english', 'medium', 'primary', 'vidyalaya', 'vidya', 'academy', 'college', 'the', 'and', 'of', 'for', 'shree', 'sri', 'st', 'saint']);
  const tokens = schoolName
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !stopWords.has(t));
  if (tokens.length === 0) return true;
  const hay = text.toLowerCase();
  const matched = tokens.filter((t) => hay.includes(t)).length;
  return matched >= Math.min(1, tokens.length);
}

interface LabEvidenceAnalysis {
  computerLab: ComputerLabStatus;
  labComputersCount: number | null;
  labInternetAvailable: string;
  labConfidence: number;
  labVerificationNote: string;
  sourceUrl?: string;
}

function analyzeComputerLabEvidence(
  schoolName: string,
  serpItems: SerpResultItem[],
  site: WebsiteInspectionResult | null,
  extraPages: WebsiteInspectionResult[] = []
): LabEvidenceAnalysis {
  const POSITIVE_LAB_RX =
    /\b(?:computer\s+lab(?:oratory|s)?|ict\s+lab|it\s+lab|computer\s+aided\s+learning\s+lab|stem\s+lab|atal\s+tinkering\s+lab|coding\s+lab|computer\s+room|computer\s+education\s+facility|computer\s+science\s+lab|digital\s+lab|well[-\s]equipped\s+computer)\b/i;
  const POSITIVE_COUNT_RX =
    /\b([1-9]\d{0,2})\s+(?:functional\s+|working\s+|desktop\s+|modern\s+)?(?:computers?|pcs?|desktops?|workstations?|systems?)\b(?:\s+for\s+teaching)?/i;
  const NEGATIVE_LAB_RX =
    /\b(?:0\s+computers?\s+(?:for\s+teaching|available)?|no\s+computer\s+lab|does\s+not\s+have\s+(?:a\s+)?computer(?:\s+lab|\s+aided)?|computer\s+lab\s*[:\-]?\s*no\b|computers?\s*[:\-]?\s*0\b|has\s+no\s+computer|not\s+have\s+(?:a\s+)?computer)\b/i;
  const INTERNET_YES_RX =
    /\b(?:high[-\s]speed\s+internet|broadband|wi-?fi\s+(?:enabled|campus|available|facility)|internet\s+(?:facility|connection|available|yes)|lan\s+(?:network|connected))\b/i;

  const corpus: Array<{ text: string; url?: string; isOfficial: boolean }> = [];
  if (site?.plainText) {
    corpus.push({ text: site.plainText, url: site.url, isOfficial: true });
  }
  for (const page of extraPages) {
    if (page?.plainText) {
      corpus.push({
        text: page.plainText,
        url: page.url,
        isOfficial: !isDirectoryOrSocialUrl(page.url),
      });
    }
  }
  for (const item of serpItems) {
    const combined = `${item.title}. ${item.snippet || ''}`;
    if (nameTokensMatch(schoolName, combined) || serpItems.length <= 3) {
      corpus.push({
        text: combined,
        url: safeExternalUrl(item.link || item.website),
        isOfficial: !isDirectoryOrSocialUrl(item.link || item.website),
      });
    }
  }

  type PositiveLabMatch = { note: string; count: number | null; url?: string; confidence: number };
  let bestPositive: PositiveLabMatch | null = null;
  let bestNegative: { note: string; url?: string; confidence: number } | null = null;
  let internetStatus = 'Unconfirmed';

  for (const doc of corpus) {
    if (internetStatus === 'Unconfirmed' && INTERNET_YES_RX.test(doc.text)) {
      internetStatus = /broadband|lan|high[-\s]speed/i.test(doc.text)
        ? 'High-speed Broadband / LAN'
        : 'Available (Public Listing)';
    }

    // Check explicit negative first (e.g. UDISE "has 0 computers for teaching and learning purposes and does not have a computer aided learning lab")
    if (NEGATIVE_LAB_RX.test(doc.text)) {
      const note = extractMatchingSentence(doc.text, NEGATIVE_LAB_RX);
      if (note && !bestNegative) {
        bestNegative = {
          note,
          url: doc.url,
          confidence: doc.isOfficial ? 0.88 : 0.82,
        };
      }
      continue;
    }

    const countMatch = doc.text.match(POSITIVE_COUNT_RX);
    const parsedCount = countMatch ? Number(countMatch[1]) : null;
    const validCount = parsedCount && parsedCount >= 1 && parsedCount <= 500 ? parsedCount : null;
    const hasLabPhrase = POSITIVE_LAB_RX.test(doc.text);

    if (hasLabPhrase || validCount !== null) {
      const note =
        extractMatchingSentence(doc.text, hasLabPhrase ? POSITIVE_LAB_RX : POSITIVE_COUNT_RX) ||
        `Public listing confirms computer lab infrastructure${validCount ? ` (${validCount} computers)` : ''}.`;
      const conf = doc.isOfficial ? 0.92 : validCount ? 0.88 : 0.82;
      if (bestPositive === null) {
        bestPositive = { note, count: validCount, url: doc.url, confidence: conf };
      } else if (conf > bestPositive.confidence || (validCount !== null && bestPositive.count === null)) {
        bestPositive = {
          note,
          count: validCount ?? bestPositive.count,
          url: doc.url || bestPositive.url,
          confidence: conf,
        };
      }
    }
  }

  if (bestPositive) {
    return {
      computerLab: 'Yes',
      labComputersCount: bestPositive.count,
      labInternetAvailable: internetStatus !== 'Unconfirmed' ? internetStatus : 'Broadband / LAN (Unconfirmed speed)',
      labConfidence: bestPositive.confidence,
      labVerificationNote: bestPositive.note,
      sourceUrl: bestPositive.url || site?.url || safeExternalUrl(serpItems[0]?.link),
    };
  }

  if (bestNegative) {
    return {
      computerLab: 'No',
      labComputersCount: 0,
      labInternetAvailable: 'Not Connected',
      labConfidence: bestNegative.confidence,
      labVerificationNote: bestNegative.note,
      sourceUrl: bestNegative.url || safeExternalUrl(serpItems[0]?.link),
    };
  }

  return {
    computerLab: 'Unverified',
    labComputersCount: null,
    labInternetAvailable: internetStatus,
    labConfidence: 0.35,
    labVerificationNote:
      serpItems.length > 0
        ? `Searched ${serpItems.length} Google result(s) for ${schoolName}; no explicit public computer lab confirmation was listed. Confirm during physical campus visit.`
        : `No public web listing found confirming computer lab status for ${schoolName}. Confirm during physical campus visit.`,
    sourceUrl: site?.url || safeExternalUrl(serpItems[0]?.link || serpItems[0]?.website),
  };
}

function extractGroundingSources(response: unknown): GroundingSource[] {
  const resp = response as {
    candidates?: Array<{
      groundingMetadata?: {
        groundingChunks?: Array<{ web?: { uri?: string; title?: string } }>;
      };
    }>;
  };
  const chunks = resp?.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
  const seen = new Set<string>();
  const sources: GroundingSource[] = [];
  for (const ch of chunks) {
    const uri = safeExternalUrl(ch?.web?.uri);
    if (uri && !seen.has(uri)) {
      seen.add(uri);
      sources.push({
        title: ch?.web?.title || uri,
        url: uri,
      });
    }
  }
  return sources;
}

function parseJsonFromModelText<T>(rawText: string | undefined): T | null {
  if (!rawText) return null;
  const trimmed = rawText.replace(/^\uFEFF/, '').trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;

  const firstObj = candidate.indexOf('{');
  const firstArr = candidate.indexOf('[');
  let start = -1;
  let end = -1;
  if (firstObj !== -1 && (firstArr === -1 || firstObj < firstArr)) {
    start = firstObj;
    end = candidate.lastIndexOf('}');
  } else if (firstArr !== -1) {
    start = firstArr;
    end = candidate.lastIndexOf(']');
  }
  if (start === -1 || end === -1 || end <= start) return null;

  const slice = candidate.slice(start, end + 1);
  try {
    return JSON.parse(slice) as T;
  } catch {
    // Retry once after stripping trailing commas before } or ]
    try {
      const cleaned = slice.replace(/,\s*([}\]])/g, '$1');
      return JSON.parse(cleaned) as T;
    } catch {
      return null;
    }
  }
}

function isTransientUnavailableError(err: unknown): boolean {
  const raw = err instanceof Error ? err.message : String(err || '');
  return /\b503\b|\b502\b|\b504\b|UNAVAILABLE|overloaded|high demand|temporarily unavailable/i.test(raw);
}

const INDUSTRY_OSM_KEYWORDS: Array<{ match: RegExp; keywords: string[] }> = [
  { match: /health|hospital|clinic|medical|pharma|diagnostic/i, keywords: ['hospital', 'clinic', 'pharmacy'] },
  { match: /hotel|hospitality|resort|lodge/i, keywords: ['hotel', 'resort'] },
  { match: /restaurant|food|cafe|bakery|catering/i, keywords: ['restaurant', 'cafe'] },
  { match: /retail|shop|supermarket|ecommerce|e-commerce|store|fashion|jewel/i, keywords: ['supermarket', 'mall', 'store'] },
  { match: /real\s*estate|construction|builder|architect|interior/i, keywords: ['builders', 'real estate', 'developers'] },
  { match: /finance|bank|insurance|accounting|ca\b/i, keywords: ['bank', 'finance'] },
  { match: /it\b|software|tech|digital|agency|consulting/i, keywords: ['software', 'technologies', 'IT'] },
  { match: /auto|car|motor|garage|dealership/i, keywords: ['motors', 'car showroom', 'auto'] },
  { match: /fitness|gym|wellness|salon|spa/i, keywords: ['gym', 'fitness', 'salon'] },
  { match: /manufactur|industrial|factory|logistics|warehouse|transport/i, keywords: ['industries', 'manufacturing', 'logistics'] },
  { match: /education|school|college|coaching|training|institute/i, keywords: ['school', 'academy', 'institute'] },
];

function getOsmIndustryKeywords(industry: string): string[] {
  for (const row of INDUSTRY_OSM_KEYWORDS) {
    if (row.match.test(industry)) return row.keywords;
  }
  const clean = industry.replace(/[^a-zA-Z0-9\s]/g, ' ').trim().split(/\s+/).slice(0, 2).join(' ');
  return clean ? [clean] : ['business'];
}

interface OsmPlaceHit {
  name: string;
  address: string;
  area: string;
  city: string;
  state: string;
  phone?: string;
  email?: string;
  website?: string;
  category?: string;
  mapsUrl: string;
}

async function queryOpenStreetMapPlaces(
  industry: string,
  location: string,
  maxResults = 10
): Promise<OsmPlaceHit[]> {
  const keywords = getOsmIndustryKeywords(industry);
  const primaryKw = keywords[0] || industry;
  const secondaryKw = keywords[1];
  const ua = { 'User-Agent': 'NattonSkillXJunior/1.0 (campus-lab-finder)', 'Accept-Language': 'en' };
  const isSchoolIndustry = /school|education|college|university/i.test(industry);

  const fetchNominatim = async (q: string): Promise<OsmPlaceHit[]> => {
    try {
      const c = new AbortController();
      const t = setTimeout(() => c.abort(), 3500);
      const resp = await fetch(
        `https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&extratags=1&limit=12&q=${encodeURIComponent(q)}`,
        { headers: ua, signal: c.signal }
      );
      clearTimeout(t);
      if (!resp.ok) return [];
      const arr = (await resp.json()) as Array<{
        name?: string;
        display_name?: string;
        type?: string;
        lat?: string;
        lon?: string;
        address?: Record<string, string>;
        extratags?: Record<string, string>;
      }>;
      if (!Array.isArray(arr)) return [];
      const out: OsmPlaceHit[] = [];
      for (const item of arr) {
        const rawName = (item.name || (item.display_name || '').split(',')[0] || '').trim();
        if (!rawName || rawName.length < 2) continue;
        if (
          !isSchoolIndustry &&
          /\b(school|vidyalaya|high school|public school|primary school|kendriya vidyalaya|college|university)\b/i.test(
            rawName
          )
        ) {
          continue;
        }
        const tags = item.extratags || {};
        const addr = item.address || {};
        const phone = cleanPhoneCandidate(tags.phone || tags['contact:phone'] || tags['contact:mobile'] || tags.mobile);
        const email = cleanEmailCandidate(tags.email || tags['contact:email']);
        const website = safeExternalUrl(tags.website || tags['contact:website'] || tags.url);
        const area = addr.suburb || addr.neighbourhood || addr.road || location.split(',')[0]?.trim() || location;
        const city = addr.city || addr.town || addr.county || addr.state_district || location.split(',')[0]?.trim() || location;
        const state = addr.state || location.split(',')[1]?.trim() || '';
        out.push({
          name: rawName,
          address: item.display_name || `${area}, ${city}`,
          area,
          city,
          state,
          phone,
          email,
          website,
          category: item.type || industry,
          mapsUrl:
            item.lat && item.lon
              ? `https://maps.google.com/?q=${item.lat},${item.lon}`
              : `https://maps.google.com/?q=${encodeURIComponent(`${rawName} ${location}`)}`,
        });
      }
      return out;
    } catch {
      return [];
    }
  };

  const fetchPhoton = async (q: string): Promise<OsmPlaceHit[]> => {
    try {
      const c = new AbortController();
      const t = setTimeout(() => c.abort(), 3500);
      const resp = await fetch(
        `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=12`,
        { headers: ua, signal: c.signal }
      );
      clearTimeout(t);
      if (!resp.ok) return [];
      const data = (await resp.json()) as {
        features?: Array<{
          geometry?: { coordinates?: [number, number] };
          properties?: {
            name?: string;
            street?: string;
            district?: string;
            city?: string;
            county?: string;
            state?: string;
            osm_value?: string;
          };
        }>;
      };
      const out: OsmPlaceHit[] = [];
      for (const f of data.features || []) {
        const p = f.properties || {};
        const rawName = (p.name || '').trim();
        if (!rawName || rawName.length < 2) continue;
        if (
          !isSchoolIndustry &&
          /\b(school|vidyalaya|high school|public school|primary school|kendriya vidyalaya|college|university)\b/i.test(
            rawName
          )
        ) {
          continue;
        }
        const area = p.district || p.street || location.split(',')[0]?.trim() || location;
        const city = p.city || p.county || location.split(',')[0]?.trim() || location;
        const state = p.state || location.split(',')[1]?.trim() || '';
        const coords = f.geometry?.coordinates;
        out.push({
          name: rawName,
          address: [p.street, p.district, city, state].filter(Boolean).join(', ') || location,
          area,
          city,
          state,
          category: p.osm_value || industry,
          mapsUrl:
            coords && coords.length === 2
              ? `https://maps.google.com/?q=${coords[1]},${coords[0]}`
              : `https://maps.google.com/?q=${encodeURIComponent(`${rawName} ${location}`)}`,
        });
      }
      return out;
    } catch {
      return [];
    }
  };

  const queries: Array<Promise<OsmPlaceHit[]>> = [
    fetchNominatim(`${primaryKw} ${location}`),
    fetchPhoton(`${primaryKw} ${location}`),
  ];
  if (secondaryKw) {
    queries.push(fetchNominatim(`${secondaryKw} ${location}`));
  }

  const batches = await Promise.all(queries);
  const seen = new Set<string>();
  const merged: OsmPlaceHit[] = [];
  for (const list of batches) {
    for (const item of list) {
      const key = item.name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
      if (merged.length >= maxResults) return merged;
    }
  }
  return merged;
}

async function queryOpenStreetMapSingle(name: string, location: string): Promise<OsmPlaceHit | null> {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 2800);
    const resp = await fetch(
      `https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&extratags=1&limit=3&q=${encodeURIComponent(`${name} ${location}`.trim())}`,
      { headers: { 'User-Agent': 'NattonSkillXJunior/1.0 (campus-lab-finder)' }, signal: c.signal }
    );
    clearTimeout(t);
    if (!resp.ok) return null;
    const arr = (await resp.json()) as Array<{
      name?: string;
      display_name?: string;
      lat?: string;
      lon?: string;
      address?: Record<string, string>;
      extratags?: Record<string, string>;
    }>;
    if (!Array.isArray(arr) || arr.length === 0) return null;
    const best = arr.find((x) => nameTokensMatch(name, `${x.name || ''} ${x.display_name || ''}`)) || arr[0];
    const tags = best.extratags || {};
    const addr = best.address || {};
    return {
      name: best.name || name,
      address: best.display_name || location,
      area: addr.suburb || addr.neighbourhood || location,
      city: addr.city || addr.town || addr.county || location,
      state: addr.state || '',
      phone: cleanPhoneCandidate(tags.phone || tags['contact:phone'] || tags['contact:mobile'] || tags.mobile),
      email: cleanEmailCandidate(tags.email || tags['contact:email']),
      website: safeExternalUrl(tags.website || tags['contact:website'] || tags.url),
      mapsUrl:
        best.lat && best.lon
          ? `https://maps.google.com/?q=${best.lat},${best.lon}`
          : `https://maps.google.com/?q=${encodeURIComponent(`${name} ${location}`)}`,
    };
  } catch {
    return null;
  }
}

async function runGeminiJsonPrompt<T>(
  prompt: string,
  useGoogleSearchTool: boolean,
  allowUngroundedFallback = false
): Promise<{ data: T | null; sources: GroundingSource[]; grounded: boolean }> {
  const ai = getGeminiClient();
  if (!ai) {
    throw new Error('GEMINI_API_KEY is not configured on the server.');
  }

  const now = Date.now();
  let lastError: unknown;
  let sawSearchRateLimit = false;
  let sawDirectRateLimit = false;

  // Phase 1: Try live Google Search grounding if requested and any model has search tool quota available
  if (useGoogleSearchTool) {
    const searchEligible = GEMINI_MODELS.filter((m) => (searchToolCooldownUntil.get(m) || 0) <= now);
    for (const model of searchEligible) {
      try {
        const response = await ai.models.generateContent({
          model,
          contents: prompt,
          config: { tools: [{ googleSearch: {} }] },
        });
        const sources = extractGroundingSources(response);
        const data = parseJsonFromModelText<T>(response.text);
        const diag = {
          status: data ? 'OK_GROUNDED' : 'PARSE_EMPTY',
          message: data
            ? `OK (${sources.length} Google Search source${sources.length === 1 ? '' : 's'})`
            : `Model returned unparsed text (${(response.text || '').slice(0, 80)})`,
          checkedAt: new Date().toISOString(),
        };
        lastGeminiDiagnostic = { model, ...diag };
        geminiModelDiagnostics[`${model}:search`] = diag;
        if (data) {
          return { data, sources, grounded: true };
        }
        lastError = new Error(`Model ${model} returned non-JSON response.`);
      } catch (err) {
        lastError = err;
        const rawErr = (err instanceof Error ? err.message : String(err || '')).replace(/AIza[0-9A-Za-z_-]{20,}/g, '[REDACTED]');
        const rateLimited = isRateLimitError(err);
        if (rateLimited) {
          sawSearchRateLimit = true;
          // Free-tier Google Search grounding quota takes minutes to reset — back off 15 minutes so we don't waste latency on every batch
          searchToolCooldownUntil.set(model, Date.now() + 900 * 1000);
        }
        const diag = {
          status: rateLimited ? 'RATE_LIMITED' : 'ERROR',
          message: rawErr.slice(0, 320),
          checkedAt: new Date().toISOString(),
        };
        lastGeminiDiagnostic = { model, ...diag };
        geminiModelDiagnostics[`${model}:search`] = diag;
      }
    }
  }

  // Phase 2: Fast direct generateContent (up to 2 attempts on brief 503 spikes)
  if (!useGoogleSearchTool || allowUngroundedFallback) {
    const directEligible = GEMINI_MODELS.filter((m) => (modelCooldownUntil.get(m) || 0) <= now);
    if (directEligible.length === 0) {
      const waitSec = getSoonestGeminiCooldownSeconds();
      throw new ApiQuotaError(
        `API rate limit active — auto-resuming in ~${waitSec}s.`,
        waitSec
      );
    }

    for (let round = 0; round < 2; round++) {
      let sawTransient503 = false;
      for (const model of directEligible) {
        try {
          const response = await ai.models.generateContent({
            model,
            contents: prompt,
          });
          const data = parseJsonFromModelText<T>(response.text);
          const diag = {
            status: data ? 'OK_DIRECT' : 'PARSE_EMPTY',
            message: data
              ? 'OK (Fast Gemini + live directory/website verification)'
              : `Model returned unparsed text (${(response.text || '').slice(0, 80)})`,
            checkedAt: new Date().toISOString(),
          };
          lastGeminiDiagnostic = { model, ...diag };
          geminiModelDiagnostics[`${model}:direct`] = diag;
          if (data) {
            return { data, sources: [], grounded: false };
          }
          lastError = new Error(`Model ${model} returned non-JSON response.`);
        } catch (err) {
          lastError = err;
          const rawErr = (err instanceof Error ? err.message : String(err || '')).replace(/AIza[0-9A-Za-z_-]{20,}/g, '[REDACTED]');
          const rateLimited = isRateLimitError(err);
          const is503 = isTransientUnavailableError(err);
          if (is503) sawTransient503 = true;
          if (rateLimited) {
            sawDirectRateLimit = true;
            const formatted = formatApiError(err);
            const waitSec = Math.max(12, Math.min(60, formatted.retryAfterSeconds || 20));
            modelCooldownUntil.set(model, Date.now() + waitSec * 1000);
          }
          const diag = {
            status: rateLimited ? 'RATE_LIMITED' : is503 ? 'BUSY_503' : 'ERROR',
            message: rawErr.slice(0, 320),
            checkedAt: new Date().toISOString(),
          };
          lastGeminiDiagnostic = { model, ...diag };
          geminiModelDiagnostics[`${model}:direct`] = diag;
        }
      }
      if (sawTransient503 && round === 0) {
        await new Promise((r) => setTimeout(r, 900));
        continue;
      }
      break;
    }
  }

  // Only raise 429 RATE_LIMITED if direct models actually hit 429 (or if fallback wasn't allowed and search hit 429)
  if (sawDirectRateLimit || (!allowUngroundedFallback && sawSearchRateLimit)) {
    const formatted = formatApiError(lastError);
    const waitSec = Math.max(10, Math.min(45, formatted.retryAfterSeconds || getSoonestGeminiCooldownSeconds() || 15));
    throw new ApiQuotaError(
      `API rate limit reached — auto-retrying in ~${waitSec}s.`,
      waitSec
    );
  }
  if (isTransientUnavailableError(lastError)) {
    throw new Error('Upstream AI server is briefly busy (503). Retrying automatically...');
  }
  throw lastError instanceof Error ? lastError : new Error('Search AI request failed');
}

function mergeSourcesFromSerp(serpItems: SerpResultItem[], extra: GroundingSource[] = []): GroundingSource[] {
  const seen = new Set<string>();
  const out: GroundingSource[] = [];
  for (const s of extra) {
    const u = safeExternalUrl(s.url);
    if (u && !seen.has(u)) {
      seen.add(u);
      out.push({ title: s.title || u, url: u, snippet: s.snippet });
    }
  }
  for (const r of serpItems) {
    const u = safeExternalUrl(r.link || r.website);
    if (u && !seen.has(u)) {
      seen.add(u);
      out.push({ title: r.title || u, url: u, snippet: r.snippet });
    }
  }
  return out.slice(0, 10);
}

function extractContactsFromSerpAndSite(
  serpItems: SerpResultItem[],
  site: WebsiteInspectionResult | null,
  extraPages: WebsiteInspectionResult[] = []
): {
  phone?: string;
  phoneSourceUrl?: string;
  email?: string;
  address?: string;
  website?: string;
  contactPerson?: string;
} {
  let phone: string | undefined;
  let phoneSourceUrl: string | undefined;

  // 1. Highest trust: structured phoneNumber from SerpForge places / knowledgeGraph
  for (const item of serpItems) {
    const p = cleanPhoneCandidate(item.phoneNumber);
    if (p) {
      phone = p;
      phoneSourceUrl = safeExternalUrl(item.website || item.link);
      break;
    }
  }

  // 2. Official website & inspected subpages/directory tel: / plain text phone
  if (!phone && site?.phones.length) {
    phone = site.phones[0];
    phoneSourceUrl = site.url;
  }
  if (!phone) {
    for (const page of extraPages) {
      if (page?.phones.length) {
        phone = page.phones[0];
        phoneSourceUrl = page.url;
        break;
      }
    }
  }

  // 3. Organic snippet phone extraction
  if (!phone) {
    for (const item of serpItems) {
      const found = extractPhonesFromText(`${item.title} ${item.snippet || ''}`);
      if (found.length) {
        phone = found[0];
        phoneSourceUrl = safeExternalUrl(item.link || item.website);
        break;
      }
    }
  }

  // Email
  let email = site?.emails[0] || extraPages.find((p) => p.emails.length)?.emails[0];
  if (!email) {
    for (const item of serpItems) {
      const found = extractEmailsFromText(item.snippet || '');
      if (found.length) {
        email = found[0];
        break;
      }
    }
  }

  // Address
  const address = serpItems.find((i) => i.address)?.address?.trim() || undefined;
  const website = pickBestOfficialWebsite(serpItems, site?.url);

  // Principal / Contact person from snippet/site if explicitly labelled
  let contactPerson: string | undefined;
  const fullText = [
    site?.plainText || '',
    ...extraPages.map((p) => p.plainText || ''),
    ...serpItems.map((i) => i.snippet || ''),
  ].join(' ');
  const personMatch = fullText.match(
    /\b(?:Principal|Headmaster|Headmistress|Director|Founder)\s*[:\-]\s*((?:Dr\.|Mr\.|Mrs\.|Ms\.|Prof\.|Rev\.|Sr\.)?\s*[A-Z][a-zA-Z.]+(?:\s+[A-Z][a-zA-Z.]+){0,3})/
  );
  if (personMatch && personMatch[1]) {
    contactPerson = personMatch[1].trim();
  }

  return { phone, phoneSourceUrl, email, address, website, contactPerson };
}

export interface VerifyLabInput {
  schoolName: string;
  websiteUrl?: string;
  city?: string;
  area?: string;
  state?: string;
  board?: string;
  existingPhone?: string;
  existingEmail?: string;
  regionHint?: string;
}

export interface VerifyLabOutput {
  computerLab: ComputerLabStatus;
  computerLabSource: LabVerificationSource;
  computerLabSourceUrl?: string;
  computerLabCheckedAt: string;
  labComputersCount: number | null;
  labInternetAvailable: string;
  labConfidence: number;
  labVerificationNote: string;
  website?: string;
  contactPhone?: string;
  contactPhoneSource?: ContactSourceType;
  contactPhoneSourceUrl?: string;
  contactEmail?: string;
  contactEmailSource?: ContactSourceType;
  contactPerson?: string;
  address?: string;
  sources: GroundingSource[];
}

export async function verifySchoolComputerLab(input: VerifyLabInput): Promise<VerifyLabOutput> {
  const now = new Date().toISOString();
  const effectiveLocation = buildEffectiveLocation(input.area, input.city, input.state, input.regionHint);
  const shortLoc = buildShortSearchLocation(input.area, input.city, input.state);
  const needPhone = !hasValidPhone(input.existingPhone);
  const needEmail = !cleanEmailCandidate(input.existingEmail);
  const hasGemini = Boolean(getGeminiClient());

  let serpFailureReason: string | undefined;
  let serpDraft: VerifyLabOutput | null = null;

  // Step 1: Fast direct inspection if a school website URL was supplied in Excel
  let directSite: WebsiteInspectionResult | null = null;
  let directSubpages: WebsiteInspectionResult[] = [];
  if (input.websiteUrl) {
    directSite = await inspectPublicWebsiteSafe(input.websiteUrl);
    if (directSite?.candidateSubpages?.length) {
      const subs = await Promise.all(
        directSite.candidateSubpages.slice(0, 2).map((u) => inspectPublicWebsiteSafe(u))
      );
      directSubpages = subs.filter((p): p is WebsiteInspectionResult => Boolean(p));
    }
  }

  // Step 2: Optional SerpForge check (skip redundant empty SerpForge calls when Gemini is active & SerpForge keeps returning 0 results)
  const shouldQuerySerpForge = hasSerpForgeKey() && (!hasGemini || consecutiveEmptySerpCount < 2);
  if (shouldQuerySerpForge) {
    const queryLoc = shortLoc || (input.regionHint || '').split(',')[0].trim();
    const generalRes = await querySerpForge(`${input.schoolName} ${queryLoc}`.trim(), 'search', 8);
    let allSerpItems = [...generalRes.items];
    let serpSucceeded = generalRes.ok;

    if (!generalRes.ok) {
      serpFailureReason = generalRes.errorMessage;
    }

    if (serpSucceeded && allSerpItems.length > 0) {
      const prelim = extractContactsFromSerpAndSite(allSerpItems, directSite, directSubpages);
      if ((needPhone && !prelim.phone) || (!input.websiteUrl && !prelim.website)) {
        const placesRes = await querySerpForge(`${input.schoolName} ${queryLoc}`.trim(), 'places', 5);
        if (placesRes.ok) {
          allSerpItems = [...placesRes.items, ...allSerpItems];
        }
      }

      const bestWebsite = pickBestOfficialWebsite(allSerpItems, input.websiteUrl);
      const directoryUrls = pickSchoolDirectoryUrls(allSerpItems, 2);

      const siteInspection =
        directSite && directSite.url === bestWebsite
          ? directSite
          : bestWebsite
          ? await inspectPublicWebsiteSafe(bestWebsite)
          : directSite;

      const dirInspections = directoryUrls.length
        ? await Promise.all(directoryUrls.map((u) => inspectPublicWebsiteSafe(u)))
        : [];

      const extraPages = [...directSubpages, ...dirInspections].filter(
        (p): p is WebsiteInspectionResult => Boolean(p)
      );

      const labAnalysis = analyzeComputerLabEvidence(input.schoolName, allSerpItems, siteInspection, extraPages);
      const contacts = extractContactsFromSerpAndSite(allSerpItems, siteInspection, extraPages);
      const mergedSources = mergeSourcesFromSerp(allSerpItems);

      const foundPhone = contacts.phone;
      const foundEmail = contacts.email;
      const foundWebsite = contacts.website || safeExternalUrl(input.websiteUrl);

      serpDraft = {
        computerLab: labAnalysis.computerLab,
        computerLabSource: siteInspection && labAnalysis.sourceUrl === siteInspection.url ? 'WEBSITE' : 'SERPFORGE',
        computerLabSourceUrl: labAnalysis.sourceUrl || foundWebsite || mergedSources[0]?.url,
        computerLabCheckedAt: now,
        labComputersCount: labAnalysis.labComputersCount,
        labInternetAvailable: labAnalysis.labInternetAvailable,
        labConfidence: labAnalysis.labConfidence,
        labVerificationNote: labAnalysis.labVerificationNote,
        website: foundWebsite,
        contactPhone: needPhone ? foundPhone : input.existingPhone,
        contactPhoneSource: needPhone && foundPhone ? 'SerpForge' : hasValidPhone(input.existingPhone) ? 'Uploaded Excel' : undefined,
        contactPhoneSourceUrl: needPhone && foundPhone ? contacts.phoneSourceUrl || labAnalysis.sourceUrl : undefined,
        contactEmail: needEmail ? foundEmail : input.existingEmail,
        contactEmailSource: needEmail && foundEmail ? 'SerpForge' : cleanEmailCandidate(input.existingEmail) ? 'Uploaded Excel' : undefined,
        contactPerson: contacts.contactPerson,
        address: contacts.address,
        sources: mergedSources,
      };

      const labResolved = serpDraft.computerLab !== 'Unverified';
      const phoneResolved = !needPhone || hasValidPhone(serpDraft.contactPhone);
      if (labResolved && phoneResolved) {
        return serpDraft;
      }
    }

    if ((generalRes.status === 401 || generalRes.status === 403) && !hasGemini) {
      throw new Error(
        `SerpForge rejected SERPFORGE_API_KEY (${serpFailureReason}). Paste the exact raw API key from serpforge.ai.studio in Settings > Secrets.`
      );
    }
  } else if (directSite) {
    // Evaluate direct official website evidence even if SerpForge was skipped
    const labAnalysis = analyzeComputerLabEvidence(input.schoolName, [], directSite, directSubpages);
    const contacts = extractContactsFromSerpAndSite([], directSite, directSubpages);
    if (labAnalysis.computerLab !== 'Unverified' || contacts.phone) {
      serpDraft = {
        computerLab: labAnalysis.computerLab,
        computerLabSource: 'WEBSITE',
        computerLabSourceUrl: labAnalysis.sourceUrl || directSite.url,
        computerLabCheckedAt: now,
        labComputersCount: labAnalysis.labComputersCount,
        labInternetAvailable: labAnalysis.labInternetAvailable,
        labConfidence: labAnalysis.labConfidence,
        labVerificationNote: labAnalysis.labVerificationNote,
        website: directSite.url,
        contactPhone: needPhone ? contacts.phone : input.existingPhone,
        contactPhoneSource: needPhone && contacts.phone ? 'Official Website' : hasValidPhone(input.existingPhone) ? 'Uploaded Excel' : undefined,
        contactPhoneSourceUrl: needPhone && contacts.phone ? contacts.phoneSourceUrl || directSite.url : undefined,
        contactEmail: needEmail ? contacts.email : input.existingEmail,
        contactEmailSource: needEmail && contacts.email ? 'Official Website' : cleanEmailCandidate(input.existingEmail) ? 'Uploaded Excel' : undefined,
        contactPerson: contacts.contactPerson,
        address: contacts.address,
        sources: [{ title: directSite.title || directSite.url, url: directSite.url }],
      };
      if (serpDraft.computerLab !== 'Unverified' && (!needPhone || hasValidPhone(serpDraft.contactPhone))) {
        return serpDraft;
      }
    }
  }

  // Step 3: Live Google Search Grounding via Gemini (multi-model resilient)
  if (!hasGemini) {
    if (serpDraft) return serpDraft;
    throw new Error('GEMINI_API_KEY is not configured in Settings > Secrets for live Google Search verification.');
  }

  const prompt = `You are a school infrastructure & public contact verifier for Natton SkillX Junior in India.
Use Google Search right now to search for this exact school on official websites, CBSE/ICSE mandatory disclosures, schools.org.in (UDISE+ data), icbse.com, edustoke.com, uniapply.com, shiksha.com, targetstudy.com, and Justdial.

School details:
- School Name: ${input.schoolName}
- Location / Region: ${effectiveLocation}
- Board: ${input.board || 'Unknown'}
- Supplied Website: ${input.websiteUrl || serpDraft?.website || 'None supplied'}

Decide "computerLab" strictly from real Google Search evidence:
- Return "Yes" if Google Search finds the school's official site, CBSE/ICSE disclosure, UDISE/schools.org.in, Edustoke, Shiksha, or Justdial confirming a Computer Lab, ICT Lab, STEM/ATL Lab, Coding Lab, Computer Room, computer education/smart-class computers, or >= 1 functional teaching computers.
- Return "No" if UDISE/schools.org.in/icbse/government directory reports 0 computers or "no computer aided learning lab", OR confirms it is a basic/rural primary, pre-primary, nursery, or kindergarten school with no computer lab facility.
- Return "Unverified" ONLY if Google Search finds zero verifiable listing or zero facility details for this school.

Also extract the school's real public contactPhone${needPhone ? ' (MISSING in Excel — prioritize finding the public phone number!)' : ''}, contactEmail, official website, principal/headmaster name, and full campus address.

Return ONLY a valid JSON object (no markdown prose outside JSON):
{
  "computerLab": "Yes" | "No" | "Unverified",
  "labComputersCount": number | null,
  "labInternetAvailable": "High-speed Broadband / LAN" | "Available" | "Not Connected" | "Unconfirmed",
  "labConfidence": number between 0.0 and 1.0,
  "labVerificationNote": "1-2 concise factual sentences citing the exact public listing/evidence found",
  "sourceUrl": "exact https URL where evidence was found, or empty string",
  "website": "official school website https URL if found, or empty string",
  "contactPhone": "verified public phone/landline/mobile number found on Google, or empty string",
  "contactPhoneSourceUrl": "https URL where phone was found, or empty string",
  "contactEmail": "public email if found, or empty string",
  "contactPerson": "Principal or Headmaster name if publicly listed, or empty string",
  "address": "full campus address if found, or empty string"
}
Rules: Never invent phone numbers or emails. Return "" for any field not found in real search results.`;

  type GeminiLabPayload = {
    computerLab?: string;
    labComputersCount?: number | null;
    labInternetAvailable?: string;
    labConfidence?: number;
    labVerificationNote?: string;
    sourceUrl?: string;
    website?: string;
    contactPhone?: string;
    contactPhoneSourceUrl?: string;
    contactEmail?: string;
    contactPerson?: string;
    address?: string;
  };

  let data: GeminiLabPayload | null = null;
  let sources: GroundingSource[] = [];
  let grounded = false;

  try {
    const res = await runGeminiJsonPrompt<GeminiLabPayload>(prompt, true, true);
    data = res.data;
    sources = res.sources;
    grounded = res.grounded;

    // If Gemini identified an official website we haven't inspected yet, live-fetch it to verify lab + extract real phone/email!
    const discoveredSiteUrl = safeExternalUrl(data?.website);
    if (discoveredSiteUrl && (!directSite || directSite.url !== discoveredSiteUrl)) {
      const liveSite = await inspectPublicWebsiteSafe(discoveredSiteUrl);
      if (liveSite) {
        const subUrls = liveSite.candidateSubpages?.slice(0, 2) || [];
        const liveSubs = subUrls.length
          ? (await Promise.all(subUrls.map((u) => inspectPublicWebsiteSafe(u)))).filter(
              (p): p is WebsiteInspectionResult => Boolean(p)
            )
          : [];
        const liveLab = analyzeComputerLabEvidence(input.schoolName, [], liveSite, liveSubs);
        const liveContacts = extractContactsFromSerpAndSite([], liveSite, liveSubs);
        serpDraft = {
          computerLab: liveLab.computerLab,
          computerLabSource: 'WEBSITE',
          computerLabSourceUrl: liveLab.sourceUrl || liveSite.url,
          computerLabCheckedAt: now,
          labComputersCount: liveLab.labComputersCount,
          labInternetAvailable: liveLab.labInternetAvailable,
          labConfidence: liveLab.labConfidence,
          labVerificationNote: liveLab.labVerificationNote,
          website: liveSite.url,
          contactPhone: needPhone ? liveContacts.phone : input.existingPhone,
          contactPhoneSource: needPhone && liveContacts.phone ? 'Official Website' : hasValidPhone(input.existingPhone) ? 'Uploaded Excel' : undefined,
          contactPhoneSourceUrl: needPhone && liveContacts.phone ? liveContacts.phoneSourceUrl || liveSite.url : undefined,
          contactEmail: needEmail ? liveContacts.email : input.existingEmail,
          contactEmailSource: needEmail && liveContacts.email ? 'Official Website' : cleanEmailCandidate(input.existingEmail) ? 'Uploaded Excel' : undefined,
          contactPerson: liveContacts.contactPerson,
          address: liveContacts.address,
          sources: [{ title: liveSite.title || liveSite.url, url: liveSite.url }],
        };
      }
    }
  } catch (err) {
    // Only fall back to serpDraft if it ACTUALLY resolved Yes or No; NEVER swallow errors into an Unverified empty draft!
    if (serpDraft && serpDraft.computerLab !== 'Unverified') {
      return serpDraft;
    }
    throw err;
  }

  return buildLabOutputFromPayload(input, data, sources, serpDraft, now, grounded);
}

type GeminiBatchItemPayload = {
  schoolId?: string;
  schoolName?: string;
  computerLab?: string;
  labComputersCount?: number | null;
  labInternetAvailable?: string;
  labConfidence?: number;
  labVerificationNote?: string;
  sourceUrl?: string;
  website?: string;
  contactPhone?: string;
  contactPhoneSourceUrl?: string;
  contactEmail?: string;
  contactPerson?: string;
  address?: string;
};

function buildLabOutputFromPayload(
  input: VerifyLabInput,
  data: GeminiBatchItemPayload | null,
  sources: GroundingSource[],
  serpDraft: VerifyLabOutput | null,
  now: string,
  grounded: boolean
): VerifyLabOutput {
  const needPhone = !hasValidPhone(input.existingPhone);
  const needEmail = !cleanEmailCandidate(input.existingEmail);

  const geminiStatus = normalizeLabStatus(data?.computerLab);
  // Only trust model-returned URLs & phone numbers when grounded by live Google Search OR verified by live HTTP website inspection (serpDraft)
  const foundSourceUrl =
    (grounded ? safeExternalUrl(data?.sourceUrl) : undefined) ||
    sources[0]?.url ||
    serpDraft?.computerLabSourceUrl ||
    serpDraft?.website ||
    safeExternalUrl(input.websiteUrl);
  const foundWebsite =
    serpDraft?.website ||
    (grounded ? safeExternalUrl(data?.website) : undefined) ||
    safeExternalUrl(input.websiteUrl);
  const foundPhone =
    serpDraft?.contactPhone || (grounded ? cleanPhoneCandidate(data?.contactPhone) : undefined);
  const foundEmail =
    serpDraft?.contactEmail || (grounded ? cleanEmailCandidate(data?.contactEmail) : undefined);
  const phoneSourceUrl =
    serpDraft?.contactPhoneSourceUrl ||
    (grounded ? safeExternalUrl(data?.contactPhoneSourceUrl) || foundSourceUrl : undefined);

  const useSerpLab = Boolean(serpDraft && serpDraft.computerLab !== 'Unverified');
  const finalLabStatus: ComputerLabStatus = useSerpLab ? serpDraft!.computerLab : geminiStatus;

  return {
    computerLab: finalLabStatus,
    computerLabSource: useSerpLab ? serpDraft!.computerLabSource : 'GOOGLE_SEARCH',
    computerLabSourceUrl: useSerpLab ? serpDraft!.computerLabSourceUrl : foundSourceUrl,
    computerLabCheckedAt: now,
    labComputersCount:
      (useSerpLab ? serpDraft!.labComputersCount : null) ??
      (typeof data?.labComputersCount === 'number' && data.labComputersCount >= 0 ? data.labComputersCount : null) ??
      serpDraft?.labComputersCount ??
      (finalLabStatus === 'No' ? 0 : null),
    labInternetAvailable:
      (useSerpLab ? serpDraft!.labInternetAvailable : data?.labInternetAvailable) ||
      (finalLabStatus === 'Yes'
        ? 'Broadband / LAN (Public Listing)'
        : finalLabStatus === 'No'
        ? 'Not Connected'
        : 'Unconfirmed'),
    labConfidence: useSerpLab
      ? serpDraft!.labConfidence
      : typeof data?.labConfidence === 'number'
      ? Math.max(0.1, Math.min(1, grounded ? data.labConfidence : Math.min(0.8, data.labConfidence)))
      : finalLabStatus === 'Unverified'
      ? 0.35
      : grounded
      ? 0.84
      : 0.72,
    labVerificationNote: useSerpLab
      ? serpDraft!.labVerificationNote
      : data?.labVerificationNote?.trim() ||
        (finalLabStatus === 'Yes'
          ? 'Computer lab confirmed via public school records.'
          : finalLabStatus === 'No'
          ? 'Public records report no computer lab facility at this campus.'
          : 'No explicit public computer lab listing found.'),
    website: foundWebsite,
    contactPhone: needPhone ? foundPhone : input.existingPhone,
    contactPhoneSource: needPhone && foundPhone
      ? serpDraft?.contactPhone
        ? serpDraft.contactPhoneSource || 'Official Website'
        : 'Google Search'
      : hasValidPhone(input.existingPhone)
      ? 'Uploaded Excel'
      : undefined,
    contactPhoneSourceUrl: needPhone && foundPhone ? phoneSourceUrl : undefined,
    contactEmail: needEmail ? foundEmail : input.existingEmail,
    contactEmailSource: needEmail && foundEmail
      ? serpDraft?.contactEmail
        ? serpDraft.contactEmailSource || 'Official Website'
        : 'Google Search'
      : cleanEmailCandidate(input.existingEmail)
      ? 'Uploaded Excel'
      : undefined,
    contactPerson: serpDraft?.contactPerson || (grounded ? data?.contactPerson?.trim() : undefined) || undefined,
    address: serpDraft?.address || (grounded ? data?.address?.trim() : undefined) || undefined,
    sources: [...sources, ...(serpDraft?.sources || [])].slice(0, 10),
  };
}

export async function verifySchoolComputerLabsBatch(
  inputs: Array<VerifyLabInput & { schoolId: string }>,
  regionHint?: string
): Promise<Record<string, VerifyLabOutput>> {
  const now = new Date().toISOString();
  const batch = inputs.slice(0, 10);
  const out: Record<string, VerifyLabOutput> = {};
  if (batch.length === 0) return out;

  if (!getGeminiClient()) {
    // Fallback to single-school path if only SerpForge is configured
    for (const item of batch) {
      out[item.schoolId] = await verifySchoolComputerLab({ ...item, regionHint: item.regionHint || regionHint });
    }
    return out;
  }

  // Fast parallel check of any supplied websites in this batch (2.5s cap per site)
  const siteDrafts = new Map<string, VerifyLabOutput>();
  await Promise.all(
    batch.map(async (item) => {
      if (!item.websiteUrl) return;
      const site = await inspectPublicWebsiteSafe(item.websiteUrl, 2500);
      if (!site) return;
      const labAnalysis = analyzeComputerLabEvidence(item.schoolName, [], site, []);
      const contacts = extractContactsFromSerpAndSite([], site, []);
      if (labAnalysis.computerLab !== 'Unverified' || contacts.phone || contacts.email) {
        const needPhone = !hasValidPhone(item.existingPhone);
        const needEmail = !cleanEmailCandidate(item.existingEmail);
        siteDrafts.set(item.schoolId, {
          computerLab: labAnalysis.computerLab,
          computerLabSource: 'WEBSITE',
          computerLabSourceUrl: labAnalysis.sourceUrl || site.url,
          computerLabCheckedAt: now,
          labComputersCount: labAnalysis.labComputersCount,
          labInternetAvailable: labAnalysis.labInternetAvailable,
          labConfidence: labAnalysis.labConfidence,
          labVerificationNote: labAnalysis.labVerificationNote,
          website: site.url,
          contactPhone: needPhone ? contacts.phone : item.existingPhone,
          contactPhoneSource: needPhone && contacts.phone ? 'Official Website' : hasValidPhone(item.existingPhone) ? 'Uploaded Excel' : undefined,
          contactPhoneSourceUrl: needPhone && contacts.phone ? contacts.phoneSourceUrl || site.url : undefined,
          contactEmail: needEmail ? contacts.email : item.existingEmail,
          contactEmailSource: needEmail && contacts.email ? 'Official Website' : cleanEmailCandidate(item.existingEmail) ? 'Uploaded Excel' : undefined,
          contactPerson: contacts.contactPerson,
          address: contacts.address,
          sources: [{ title: site.title || site.url, url: site.url }],
        });
      }
    })
  );

  // Only send schools to Gemini that still need lab verification or missing phone lookup
  const toQuery = batch.filter((item) => {
    const draft = siteDrafts.get(item.schoolId);
    const labDone = draft && draft.computerLab !== 'Unverified';
    const phoneDone = hasValidPhone(item.existingPhone) || hasValidPhone(draft?.contactPhone);
    if (labDone && phoneDone && draft) {
      out[item.schoolId] = draft;
      return false;
    }
    return true;
  });

  if (toQuery.length === 0) return out;

  const schoolListLines = toQuery
    .map((item, idx) => {
      const loc = buildEffectiveLocation(item.area, item.city, item.state, item.regionHint || regionHint);
      const phoneNeed = hasValidPhone(item.existingPhone) ? 'phone present' : 'PHONE MISSING';
      return `${idx + 1}. schoolId="${item.schoolId}" | name="${item.schoolName}" | location="${loc}" | board="${item.board || 'Unknown'}" | website="${item.websiteUrl || 'None'}" | status="${phoneNeed}"`;
    })
    .join('\n');

  const prompt = `You are a fast school infrastructure & contact verifier for Natton SkillX Junior in India.
Evaluate ALL ${toQuery.length} schools below using official websites, CBSE/ICSE mandatory disclosures, schools.org.in (UDISE+), icbse.com, edustoke.com, shiksha.com, and public school records.

Schools to verify:
${schoolListLines}

For EACH school, classify "computerLab" clearly:
- "Yes": Confirmed CBSE, ICSE, International, Kendriya Vidyalaya, Navodaya, Public, Convent, Techno, Vidya Mandir, Composite, or High School / PUC campus with documented Computer Lab, ICT Lab, STEM/ATL Lab, or functional teaching computers.
- "No": Government Lower Primary School (GLPS/LPS), small rural village primary school, standalone nursery / pre-primary / play school / kindergarten / Montessori / Anganwadi, OR UDISE/schools.org.in record reporting 0 computers / no computer lab.
- "Unverified": ONLY if zero school type or infrastructure evidence can be determined.

Also return official school website URL (so we can live-inspect it for phone & lab proof) and any verified public contactPhone, contactEmail, contactPerson, and address.
CRITICAL: NEVER copy a phone number between schools and NEVER invent phone numbers; return "" if not genuinely verified for that exact school.

Return ONLY valid JSON:
{
  "results": [
    {
      "schoolId": "exact schoolId from input",
      "schoolName": "school name",
      "computerLab": "Yes" | "No" | "Unverified",
      "labComputersCount": number | null,
      "labInternetAvailable": "High-speed Broadband / LAN" | "Available" | "Not Connected" | "Unconfirmed",
      "labConfidence": 0.0 to 1.0,
      "labVerificationNote": "1 concise factual sentence citing the evidence",
      "sourceUrl": "https URL if known else empty string",
      "website": "official school website https URL if known else empty string",
      "contactPhone": "verified public phone if known else empty string",
      "contactPhoneSourceUrl": "https URL else empty string",
      "contactEmail": "public email if known else empty string",
      "contactPerson": "Principal/Headmaster name if known else empty string",
      "address": "campus address if known else empty string"
    }
  ]
}`;

  const { data, sources, grounded } = await runGeminiJsonPrompt<
    { results?: GeminiBatchItemPayload[] } | GeminiBatchItemPayload[]
  >(prompt, true, true);

  const itemsList: GeminiBatchItemPayload[] = Array.isArray(data)
    ? data
    : Array.isArray(data?.results)
    ? data.results
    : [];

  const byId = new Map<string, GeminiBatchItemPayload>();
  const byName = new Map<string, GeminiBatchItemPayload>();
  for (const row of itemsList) {
    if (row?.schoolId) byId.set(String(row.schoolId).trim(), row);
    if (row?.schoolName) byName.set(String(row.schoolName).trim().toLowerCase(), row);
  }

  // Live-inspect any official school websites discovered in this batch (fast 2.2s cap so batch stays snappy!)
  await Promise.all(
    toQuery.map(async (item) => {
      const matched =
        byId.get(item.schoolId) ||
        byName.get(item.schoolName.trim().toLowerCase()) ||
        null;
      const discoveredUrl = safeExternalUrl(matched?.website);
      if (!discoveredUrl || siteDrafts.has(item.schoolId)) return;
      const liveSite = await inspectPublicWebsiteSafe(discoveredUrl, 2200);
      if (!liveSite) return;
      const liveLab = analyzeComputerLabEvidence(item.schoolName, [], liveSite, []);
      const liveContacts = extractContactsFromSerpAndSite([], liveSite, []);
      const needPhone = !hasValidPhone(item.existingPhone);
      const needEmail = !cleanEmailCandidate(item.existingEmail);
      siteDrafts.set(item.schoolId, {
        computerLab: liveLab.computerLab,
        computerLabSource: 'WEBSITE',
        computerLabSourceUrl: liveLab.sourceUrl || liveSite.url,
        computerLabCheckedAt: now,
        labComputersCount: liveLab.labComputersCount,
        labInternetAvailable: liveLab.labInternetAvailable,
        labConfidence: liveLab.labConfidence,
        labVerificationNote: liveLab.labVerificationNote,
        website: liveSite.url,
        contactPhone: needPhone ? liveContacts.phone : item.existingPhone,
        contactPhoneSource: needPhone && liveContacts.phone ? 'Official Website' : hasValidPhone(item.existingPhone) ? 'Uploaded Excel' : undefined,
        contactPhoneSourceUrl: needPhone && liveContacts.phone ? liveContacts.phoneSourceUrl || liveSite.url : undefined,
        contactEmail: needEmail ? liveContacts.email : item.existingEmail,
        contactEmailSource: needEmail && liveContacts.email ? 'Official Website' : cleanEmailCandidate(item.existingEmail) ? 'Uploaded Excel' : undefined,
        contactPerson: liveContacts.contactPerson,
        address: liveContacts.address,
        sources: [{ title: liveSite.title || liveSite.url, url: liveSite.url }],
      });
    })
  );

  for (const item of toQuery) {
    const matched =
      byId.get(item.schoolId) ||
      byName.get(item.schoolName.trim().toLowerCase()) ||
      itemsList.find(
        (r) =>
          r?.schoolName &&
          (r.schoolName.toLowerCase().includes(item.schoolName.toLowerCase().slice(0, 16)) ||
            item.schoolName.toLowerCase().includes(r.schoolName.toLowerCase().slice(0, 16)))
      ) ||
      null;

    out[item.schoolId] = buildLabOutputFromPayload(
      { ...item, regionHint: item.regionHint || regionHint },
      matched,
      sources,
      siteDrafts.get(item.schoolId) || null,
      now,
      grounded
    );
  }

  return out;
}

export interface EnrichContactInput {
  name: string;
  industry?: string;
  area?: string;
  city?: string;
  state?: string;
  website?: string;
  existingPhone?: string;
  existingEmail?: string;
  regionHint?: string;
}

export async function enrichMissingContact(input: EnrichContactInput): Promise<{
  contactPhone?: string;
  contactPhoneSource?: ContactSourceType;
  contactPhoneSourceUrl?: string;
  contactEmail?: string;
  contactEmailSource?: ContactSourceType;
  website?: string;
  address?: string;
  contactPerson?: string;
  sources: GroundingSource[];
}> {
  const effectiveLocation = buildEffectiveLocation(input.area, input.city, input.state, input.regionHint);
  const shortLoc = buildShortSearchLocation(input.area, input.city, input.state);
  const keepExistingPhone = hasValidPhone(input.existingPhone);
  const keepExistingEmail = Boolean(cleanEmailCandidate(input.existingEmail));
  const hasGemini = Boolean(getGeminiClient());

  let serpDraft: {
    contactPhone?: string;
    contactPhoneSource?: ContactSourceType;
    contactPhoneSourceUrl?: string;
    contactEmail?: string;
    contactEmailSource?: ContactSourceType;
    website?: string;
    address?: string;
    contactPerson?: string;
    sources: GroundingSource[];
  } | null = null;

  // Step 1: Fast lifetime-free OpenStreetMap Nominatim/Photon + live website inspection (< 1.5s, zero rate limits)
  let osmDraft: {
    contactPhone?: string;
    contactPhoneSource?: ContactSourceType;
    contactPhoneSourceUrl?: string;
    contactEmail?: string;
    contactEmailSource?: ContactSourceType;
    website?: string;
    address?: string;
    contactPerson?: string;
    sources: GroundingSource[];
  } | null = null;

  const knownWeb = safeExternalUrl(input.website);
  const [osmHit, knownSite] = await Promise.all([
    queryOpenStreetMapSingle(input.name, effectiveLocation),
    knownWeb ? inspectPublicWebsiteSafe(knownWeb, 2500) : Promise.resolve(null),
  ]);

  let osmSite: WebsiteInspectionResult | null = null;
  if (!knownSite && osmHit?.website) {
    osmSite = await inspectPublicWebsiteSafe(osmHit.website, 2500);
  }
  const activeSite = knownSite || osmSite;
  const sitePhone = activeSite?.phones[0];
  const siteEmail = activeSite?.emails[0];
  const osmPhone = cleanPhoneCandidate(osmHit?.phone);
  const osmEmail = cleanEmailCandidate(osmHit?.email);
  const freePhone = sitePhone || osmPhone;
  const freeEmail = siteEmail || osmEmail;
  const freeWeb = activeSite?.url || safeExternalUrl(osmHit?.website) || knownWeb;
  const freeSources: GroundingSource[] = [];
  if (activeSite) freeSources.push({ title: activeSite.title || activeSite.url, url: activeSite.url });
  if (osmHit?.mapsUrl) freeSources.push({ title: `${osmHit.name} (Directory)`, url: osmHit.mapsUrl });

  if (freePhone || freeEmail || freeWeb || osmHit?.address) {
    osmDraft = {
      contactPhone: keepExistingPhone ? input.existingPhone : freePhone,
      contactPhoneSource: keepExistingPhone
        ? 'Uploaded Excel'
        : sitePhone
        ? 'Official Website'
        : osmPhone
        ? 'Google Search'
        : undefined,
      contactPhoneSourceUrl: keepExistingPhone
        ? undefined
        : sitePhone
        ? activeSite?.url
        : osmPhone
        ? osmHit?.website || osmHit?.mapsUrl
        : undefined,
      contactEmail: keepExistingEmail ? input.existingEmail : freeEmail,
      contactEmailSource: keepExistingEmail
        ? 'Uploaded Excel'
        : siteEmail
        ? 'Official Website'
        : osmEmail
        ? 'Google Search'
        : undefined,
      website: freeWeb,
      address: osmHit?.address,
      contactPerson: undefined,
      sources: freeSources,
    };

    if (keepExistingPhone || hasValidPhone(osmDraft.contactPhone)) {
      return osmDraft;
    }
  }

  // Step 2: Optional SerpForge check when not repeatedly returning 0 results
  if (hasSerpForgeKey() && (!hasGemini || consecutiveEmptySerpCount < 2)) {
    const queryLoc = shortLoc || (input.regionHint || '').split(',')[0].trim();
    const [placesRes, searchRes] = await Promise.all([
      querySerpForge(`${input.name} ${queryLoc}`.trim(), 'places', 5),
      querySerpForge(`${input.name} ${queryLoc} phone`.trim(), 'search', 8),
    ]);

    if (placesRes.ok || searchRes.ok) {
      const combined = [...placesRes.items, ...searchRes.items];
      if (combined.length > 0) {
        const bestWebsite = pickBestOfficialWebsite(combined, freeWeb || input.website);
        const dirUrls = pickSchoolDirectoryUrls(combined, 1);
        const [siteInspection, ...dirInspections] = await Promise.all([
          bestWebsite ? inspectPublicWebsiteSafe(bestWebsite, 2500) : Promise.resolve(null),
          ...dirUrls.map((u) => inspectPublicWebsiteSafe(u, 2500)),
        ]);
        const contactSub = siteInspection?.candidateSubpages?.find((u) => /contact/i.test(u));
        const contactPage = contactSub ? await inspectPublicWebsiteSafe(contactSub, 2200) : null;
        const extraPages = [contactPage, ...dirInspections].filter((p): p is WebsiteInspectionResult => Boolean(p));

        const contacts = extractContactsFromSerpAndSite(combined, siteInspection, extraPages);
        const mergedSources = mergeSourcesFromSerp(combined);

        serpDraft = {
          contactPhone: keepExistingPhone ? input.existingPhone : contacts.phone || osmDraft?.contactPhone,
          contactPhoneSource: keepExistingPhone ? 'Uploaded Excel' : contacts.phone ? 'SerpForge' : osmDraft?.contactPhoneSource,
          contactPhoneSourceUrl: keepExistingPhone
            ? undefined
            : contacts.phone
            ? contacts.phoneSourceUrl || mergedSources[0]?.url
            : osmDraft?.contactPhoneSourceUrl,
          contactEmail: keepExistingEmail ? input.existingEmail : contacts.email || osmDraft?.contactEmail,
          contactEmailSource: keepExistingEmail ? 'Uploaded Excel' : contacts.email ? 'SerpForge' : osmDraft?.contactEmailSource,
          website: contacts.website || freeWeb || safeExternalUrl(input.website),
          address: contacts.address || osmDraft?.address,
          contactPerson: contacts.contactPerson || osmDraft?.contactPerson,
          sources: [...mergedSources, ...(osmDraft?.sources || [])].slice(0, 10),
        };

        if (keepExistingPhone || hasValidPhone(serpDraft.contactPhone) || !hasGemini) {
          return serpDraft;
        }
      }
    }
  }

  const baseDraft = serpDraft || osmDraft;

  // Step 3: Live Google Search Grounding via Gemini (or direct website discovery + live HTTP check)
  const prompt = `Use Google Search to find verified public contact details for this organization whose phone/contact number was missing in an uploaded Excel sheet.

Organization: ${input.name}
Industry: ${input.industry || 'Education / Business'}
Location / Region: ${effectiveLocation}
Known Website: ${baseDraft?.website || input.website || 'None'}

Return ONLY valid JSON:
{
  "contactPhone": "official public phone/mobile number if found on Google Maps, official site, Justdial, IndiaMART, or school directory; otherwise empty string",
  "contactEmail": "official public email if found; otherwise empty string",
  "website": "official https website URL if found; otherwise empty string",
  "address": "verified street address if found; otherwise empty string",
  "contactPerson": "Principal, owner, or key contact name if publicly listed; otherwise empty string",
  "sourceUrl": "exact https URL where the contact number was found; otherwise empty string"
}
Rules: Never invent or guess phone numbers. Return "" if not publicly listed.`;

  try {
    const { data, sources, grounded } = await runGeminiJsonPrompt<{
      contactPhone?: string;
      contactEmail?: string;
      website?: string;
      address?: string;
      contactPerson?: string;
      sourceUrl?: string;
    }>(prompt, true, true);

    // If Gemini discovered an official website we haven't inspected yet, live-inspect it for real phone/email
    const discoveredSiteUrl = safeExternalUrl(data?.website);
    let liveSite: WebsiteInspectionResult | null = null;
    if (discoveredSiteUrl && discoveredSiteUrl !== freeWeb) {
      liveSite = await inspectPublicWebsiteSafe(discoveredSiteUrl, 2500);
    }

    // Never trust ungrounded LLM-memorized phone numbers; only accept grounded search, live HTTP website, OSM, or SerpForge
    const liveSitePhone = liveSite?.phones[0];
    const groundedGeminiPhone = grounded ? cleanPhoneCandidate(data?.contactPhone) : undefined;
    const foundPhone = liveSitePhone || groundedGeminiPhone || baseDraft?.contactPhone;

    const liveSiteEmail = liveSite?.emails[0];
    const groundedGeminiEmail = grounded ? cleanEmailCandidate(data?.contactEmail) : undefined;
    const foundEmail = liveSiteEmail || groundedGeminiEmail || baseDraft?.contactEmail;

    const foundWebsite =
      liveSite?.url ||
      (grounded ? discoveredSiteUrl : undefined) ||
      baseDraft?.website ||
      safeExternalUrl(input.website);
    const sourceUrl =
      (liveSitePhone ? liveSite?.url : undefined) ||
      (grounded ? safeExternalUrl(data?.sourceUrl) || sources[0]?.url : undefined) ||
      baseDraft?.contactPhoneSourceUrl;

    const mergedSources = [
      ...(liveSite ? [{ title: liveSite.title || liveSite.url, url: liveSite.url }] : []),
      ...sources,
      ...(baseDraft?.sources || []),
    ].slice(0, 10);

    return {
      contactPhone: keepExistingPhone ? input.existingPhone : foundPhone,
      contactPhoneSource: keepExistingPhone
        ? 'Uploaded Excel'
        : foundPhone
        ? liveSitePhone
          ? 'Official Website'
          : groundedGeminiPhone
          ? 'Google Search'
          : baseDraft?.contactPhoneSource || 'Google Search'
        : undefined,
      contactPhoneSourceUrl: keepExistingPhone ? undefined : foundPhone ? sourceUrl : undefined,
      contactEmail: keepExistingEmail ? input.existingEmail : foundEmail,
      contactEmailSource: keepExistingEmail
        ? 'Uploaded Excel'
        : foundEmail
        ? liveSiteEmail
          ? 'Official Website'
          : groundedGeminiEmail
          ? 'Google Search'
          : baseDraft?.contactEmailSource || 'Google Search'
        : undefined,
      website: foundWebsite,
      address: (grounded ? data?.address?.trim() : undefined) || baseDraft?.address || undefined,
      contactPerson:
        (grounded ? data?.contactPerson?.trim() : undefined) ||
        baseDraft?.contactPerson ||
        undefined,
      sources: mergedSources,
    };
  } catch (err) {
    if (baseDraft) return baseDraft;
    // Never crash contact lookup on transient 429/503 spikes; return clean empty result
    const formatted = formatApiError(err);
    if (formatted.status === 429 || formatted.status === 503) {
      return {
        contactPhone: keepExistingPhone ? input.existingPhone : undefined,
        contactPhoneSource: keepExistingPhone ? 'Uploaded Excel' : undefined,
        contactEmail: keepExistingEmail ? input.existingEmail : undefined,
        contactEmailSource: keepExistingEmail ? 'Uploaded Excel' : undefined,
        website: safeExternalUrl(input.website),
        sources: [],
      };
    }
    throw err;
  }
}

export async function discoverBusinessesOnGoogle(params: {
  industry: string;
  location: string;
  serviceId?: string;
}): Promise<SchoolRecord[]> {
  const { industry, location, serviceId } = params;
  const now = new Date().toISOString();

  // Step 1: Fast lifetime-free OpenStreetMap Nominatim + Photon POI search (sub-second, zero rate limits!)
  const osmHits = await queryOpenStreetMapPlaces(industry, location, 10);
  const osmRecords: SchoolRecord[] = osmHits.map((hit, idx) => {
    const slug = hit.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 32);
    return {
      id: `biz-${slug}-${Date.now().toString(36)}-${idx}`,
      name: hit.name,
      recordType: 'BUSINESS' as const,
      industry,
      area: hit.area,
      city: hit.city,
      state: hit.state,
      board: undefined,
      address: hit.address,
      website: hit.website,
      contactPhone: hit.phone,
      contactPhoneSource: hit.phone ? ('Google Search' as ContactSourceType) : undefined,
      contactPhoneSourceUrl: hit.phone ? hit.website || hit.mapsUrl : undefined,
      contactEmail: hit.email,
      contactEmailSource: hit.email ? ('Google Search' as ContactSourceType) : undefined,
      mapsUrl: hit.mapsUrl,
      computerLab: 'Unverified' as ComputerLabStatus,
      priorityLevel: 'P2_HIGH',
      priorityScore: 68,
      targetPriorityReason: `Discovered in ${industry} (${location}) — ready for industry audit`,
      daysSinceLastVisit: 60,
      targetServiceId: serviceId && serviceId !== 'ALL' ? serviceId : undefined,
      analysisStatus: 'QUEUED',
      research: {
        matchStatus: 'Verified',
        matchReason: `Verified live directory listing (${hit.category || industry}) in ${location}`,
        checkedAt: now,
        emails: hit.email
          ? [{ value: hit.email, sourceUrl: hit.website || hit.mapsUrl, sourceType: 'Google Search', confidence: 'High', checkedAt: now }]
          : [],
        phones: hit.phone
          ? [{ value: hit.phone, sourceUrl: hit.website || hit.mapsUrl, sourceType: 'Google Search', confidence: 'High', checkedAt: now }]
          : [],
        addresses: [
          { value: hit.address, sourceUrl: hit.mapsUrl, sourceType: 'Google Search', confidence: 'High', checkedAt: now },
        ],
        socialProfiles: [],
        metadata: [
          { label: 'Industry', value: industry, sourceUrl: hit.mapsUrl },
          ...(hit.category ? [{ label: 'Directory Category', value: hit.category, sourceUrl: hit.mapsUrl }] : []),
        ],
        fieldCoverage: [
          { field: 'Phone', status: hit.phone ? 'Found' : 'Missing', detail: hit.phone || 'Queued for live website/directory lookup' },
          { field: 'Email', status: hit.email ? 'Found' : 'Missing', detail: hit.email || 'Queued for industry analysis' },
          { field: 'Website', status: hit.website ? 'Found' : 'Missing', detail: hit.website || 'Queued for industry analysis' },
        ],
        marketingIntent: {
          status: 'Unknown',
          summary: 'Queued for industry-specific analysis.',
          evidence: [],
        },
        warnings: [],
      },
    };
  });

  // Live-inspect any official websites returned by OSM in parallel (fast 2.2s cap) to extract real phone/email immediately!
  await Promise.all(
    osmRecords.slice(0, 6).map(async (rec) => {
      if (!rec.website || hasValidPhone(rec.contactPhone)) return;
      const site = await inspectPublicWebsiteSafe(rec.website, 2200);
      if (!site) return;
      if (site.phones[0]) {
        rec.contactPhone = site.phones[0];
        rec.contactPhoneSource = 'Official Website';
        rec.contactPhoneSourceUrl = site.url;
      }
      if (!rec.contactEmail && site.emails[0]) {
        rec.contactEmail = site.emails[0];
        rec.contactEmailSource = 'Official Website';
      }
    })
  );

  // Step 2: Enrich / supplement with Gemini if available (never fails if OSM already found real businesses!)
  if (hasAvailableGeminiModel()) {
    try {
      const gemRecords = await discoverBusinessesViaGemini(industry, location, serviceId, now);
      if (gemRecords.length > 0) {
        const seen = new Set(osmRecords.map((r) => r.name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()));
        const combined = [...osmRecords];
        for (const g of gemRecords) {
          const key = g.name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
          if (key && !seen.has(key)) {
            seen.add(key);
            combined.push(g);
          }
          if (combined.length >= 10) break;
        }
        return combined;
      }
    } catch {
      if (osmRecords.length > 0) return osmRecords;
    }
  }

  if (osmRecords.length > 0) {
    return osmRecords;
  }

  // Fallback to SerpForge if OSM returned 0 for a niche query
  if (hasSerpForgeKey()) {
    const placesRes = await querySerpForge(`${industry} in ${location}`, 'places', 10);
    const items = placesRes.items.filter((i) => i.title && i.title.trim().length > 1);
    if (items.length > 0) {
      const seenNames = new Set<string>();
      const out: SchoolRecord[] = [];
      for (const item of items) {
        const cleanName = item.title.replace(/\s*[|\-–—]\s*.*$/, '').trim();
        const key = cleanName.toLowerCase();
        if (!cleanName || seenNames.has(key)) continue;
        seenNames.add(key);
        const isSchoolIndustry = /school|education|college|university/i.test(industry);
        if (!isSchoolIndustry && /\b(school|vidyalaya|high school|public school|primary school|kendriya vidyalaya)\b/i.test(cleanName)) {
          continue;
        }
        const slug = cleanName.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 32);
        const phone = cleanPhoneCandidate(item.phoneNumber) || extractPhonesFromText(item.snippet || '')[0];
        const email = extractEmailsFromText(item.snippet || '')[0];
        const web = safeExternalUrl(item.website) || (!isDirectoryOrSocialUrl(item.link) ? safeExternalUrl(item.link) : undefined);
        const srcUrl = safeExternalUrl(item.link) || web;
        out.push({
          id: `biz-${slug}-${Date.now().toString(36)}-${out.length}`,
          name: cleanName,
          recordType: 'BUSINESS',
          industry,
          area: location.split(',')[0]?.trim() || location,
          city: location.trim(),
          state: location.split(',')[1]?.trim() || '',
          board: undefined,
          address: item.address?.trim() || location,
          website: web,
          contactPhone: phone,
          contactPhoneSource: phone ? 'SerpForge' : undefined,
          contactPhoneSourceUrl: phone ? srcUrl : undefined,
          contactEmail: email,
          contactEmailSource: email ? 'SerpForge' : undefined,
          mapsUrl: `https://maps.google.com/?q=${encodeURIComponent(`${cleanName} ${location}`)}`,
          computerLab: 'Unverified',
          priorityLevel: 'P2_HIGH',
          priorityScore: 68,
          targetPriorityReason: `Discovered in ${industry} (${location}) — ready for industry audit`,
          daysSinceLastVisit: 60,
          targetServiceId: serviceId && serviceId !== 'ALL' ? serviceId : undefined,
          analysisStatus: 'QUEUED',
        });
        if (out.length >= 10) break;
      }
      if (out.length > 0) return out;
    }
  }

  return discoverBusinessesViaGemini(industry, location, serviceId, now);
}

async function discoverBusinessesViaGemini(
  industry: string,
  location: string,
  serviceId: string | undefined,
  now: string
): Promise<SchoolRecord[]> {
  const serviceFocus = NATTON_SERVICES.find((s) => s.id === serviceId)?.label || 'All digital & growth services';
  const prompt = `Use Google Search to discover 8 to 10 REAL, verifiable commercial businesses in the "${industry}" industry located in "${location}".
Review focus: ${serviceFocus}.
IMPORTANT: Do NOT include schools, colleges, coaching centers, or educational institutions unless "${industry}" explicitly asks for them.

Return ONLY valid JSON:
{
  "businesses": [
    {
      "name": "Exact real business name",
      "area": "Neighborhood / locality",
      "city": "City name",
      "state": "State name",
      "address": "Full public address",
      "contactPhone": "Public phone number if found, else empty string",
      "contactEmail": "Public email if found, else empty string",
      "website": "Official https website URL if found, else empty string",
      "snippet": "Brief 1-sentence factual description of what this business offers",
      "sourceUrl": "https URL of listing or website"
    }
  ]
}
Rules:
- Only return REAL businesses verified via Google Search in "${location}". Never invent fake businesses or fake phone numbers.`;

  const { data, sources, grounded } = await runGeminiJsonPrompt<{
    businesses?: Array<{
      name?: string;
      area?: string;
      city?: string;
      state?: string;
      address?: string;
      contactPhone?: string;
      contactEmail?: string;
      website?: string;
      snippet?: string;
      sourceUrl?: string;
    }>;
  }>(prompt, true, true);

  const isSchoolIndustry = /school|education|college|university/i.test(industry);
  const list = Array.isArray(data?.businesses) ? data.businesses : [];
  return list
    .filter((b) => {
      if (!b.name || b.name.trim().length <= 1) return false;
      if (
        !isSchoolIndustry &&
        /\b(school|vidyalaya|high school|public school|primary school|kendriya vidyalaya|college|university)\b/i.test(
          b.name
        )
      ) {
        return false;
      }
      return true;
    })
    .map((b, idx) => {
      const cleanName = b.name!.trim();
      const slug = cleanName.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 32);
      const phone = grounded ? cleanPhoneCandidate(b.contactPhone) : undefined;
      const email = grounded ? cleanEmailCandidate(b.contactEmail) : undefined;
      const web = safeExternalUrl(b.website);
      const srcUrl = (grounded ? safeExternalUrl(b.sourceUrl) : undefined) || web || sources[idx]?.url;
      const area = (b.area || location).trim();
      const city = (b.city || location).trim();

      return {
        id: `biz-${slug}-${Date.now().toString(36)}-${idx}`,
        name: cleanName,
        recordType: 'BUSINESS' as const,
        industry,
        area,
        city,
        state: b.state?.trim() || '',
        board: undefined,
        address: b.address?.trim() || `${area}, ${city}`,
        website: web,
        contactPhone: phone,
        contactPhoneSource: phone ? 'Google Search' : undefined,
        contactPhoneSourceUrl: phone ? srcUrl : undefined,
        contactEmail: email,
        contactEmailSource: email ? 'Google Search' : undefined,
        mapsUrl: `https://maps.google.com/?q=${encodeURIComponent(`${cleanName} ${area} ${city}`)}`,
        computerLab: 'Unverified',
        priorityLevel: 'P2_HIGH',
        priorityScore: 68,
        targetPriorityReason: `Discovered in ${industry} (${location}) — ready for industry audit`,
        daysSinceLastVisit: 60,
        targetServiceId: serviceId && serviceId !== 'ALL' ? serviceId : undefined,
        analysisStatus: 'QUEUED',
        research: {
          matchStatus: 'Likely match',
          matchReason: b.snippet || `Discovered via Google Search for ${industry} in ${location}`,
          checkedAt: now,
          emails: email
            ? [{ value: email, sourceUrl: srcUrl, sourceType: 'Google Search', confidence: 'Medium', checkedAt: now }]
            : [],
          phones: phone
            ? [{ value: phone, sourceUrl: srcUrl, sourceType: 'Google Search', confidence: 'High', checkedAt: now }]
            : [],
          addresses: b.address
            ? [{ value: b.address.trim(), sourceUrl: srcUrl, sourceType: 'Google Search', confidence: 'High', checkedAt: now }]
            : [],
          socialProfiles: [],
          metadata: [{ label: 'Industry', value: industry, sourceUrl: srcUrl }],
          fieldCoverage: [
            { field: 'Phone', status: phone ? 'Found' : 'Missing', detail: phone || 'Will check during deep analysis' },
            { field: 'Email', status: email ? 'Found' : 'Missing', detail: email || 'Will check during deep analysis' },
            { field: 'Website', status: web ? 'Found' : 'Missing', detail: web || 'Will check during deep analysis' },
          ],
          marketingIntent: {
            status: 'Unknown',
            summary: 'Queued for industry-specific analysis.',
            evidence: [],
          },
          warnings: [],
        },
      };
    });
}

interface IndustryPlaybook {
  subCategoryDefault: string;
  context: string;
  criteriaGuide: string;
  buildBenchmarks: (ctx: {
    industry: string;
    site: WebsiteInspectionResult | null;
    serpItems: SerpResultItem[];
    labResult?: LabEvidenceAnalysis;
    hasPhone: boolean;
  }) => IndustryBenchmarkItem[];
  recommendedServiceIds: string[];
  outreachAngle: string;
}

function getIndustryPlaybook(industry: string): IndustryPlaybook {
  const lower = industry.toLowerCase();

  if (/education|school|college|coaching|training/.test(lower)) {
    return {
      subCategoryDefault: 'K-12 School / Educational Institution',
      context:
        'Parents compare schools via Google Maps ratings, CBSE/ICSE disclosures, computer/STEM lab facilities, and instant WhatsApp admission inquiry funnels.',
      criteriaGuide:
        'Evaluate: (1) Computer Lab / ICT & STEM readiness, (2) Affiliation disclosures & campus transparency, (3) Online admission inquiry & prospectus funnel, (4) Parent WhatsApp & CRM communication, (5) Local Google Business Profile visibility & reviews, (6) Mobile website performance & local SEO.',
      recommendedServiceIds: ['website', 'seo', 'whatsapp', 'gbp', 'google-ads'],
      outreachAngle: 'digital admission inquiries, parent WhatsApp automation, and SkillX Junior computer lab programs',
      buildBenchmarks: ({ site, serpItems, labResult, hasPhone }) => [
        {
          criterion: 'Computer Lab / ICT & STEM Infrastructure',
          status: labResult?.computerLab === 'Yes' ? 'Strong' : labResult?.computerLab === 'No' ? 'Gap' : 'Unconfirmed',
          finding: labResult?.labVerificationNote || 'No explicit public computer lab confirmation found.',
          impact: 'Key readiness criterion for Natton SkillX Junior lab partnerships and parent trust.',
        },
        {
          criterion: 'Official Website & Mobile Parent Experience',
          status: site?.reachable ? (site.hasViewport ? 'Strong' : 'Partial') : 'Gap',
          finding: site?.reachable
            ? `Active site (${site.url})${site.hasViewport ? ' with mobile viewport' : ', missing mobile viewport optimization'}.`
            : 'No verified official school website detected in Google search.',
          impact: 'Over 80% of parents evaluate school credentials and fee/admission details on mobile.',
        },
        {
          criterion: 'Online Admission Inquiry & WhatsApp Desk',
          status: site?.hasLeadForm && site?.hasWhatsApp ? 'Strong' : site?.hasLeadForm || site?.hasWhatsApp ? 'Partial' : 'Gap',
          finding: site
            ? `${site.hasLeadForm ? 'Inquiry form detected' : 'No clear online admission form'}; ${site.hasWhatsApp ? 'WhatsApp link present' : 'no WhatsApp admission desk detected'}.`
            : 'No digital admission funnel detected.',
          impact: 'Directly drives admission conversion during peak enrollment season.',
        },
        {
          criterion: 'Google Business Profile & Public Contact Reachability',
          status: serpItems.some((i) => i.sourceKind === 'places' || i.sourceKind === 'knowledgeGraph') && hasPhone ? 'Strong' : hasPhone ? 'Partial' : 'Gap',
          finding: hasPhone
            ? 'Public contact phone verified across Excel/Google listings.'
            : 'Public phone number missing or hard to discover on Google Maps.',
          impact: 'Parents abandon listings without click-to-call numbers and clear campus directions.',
        },
        {
          criterion: 'Local Search SEO & Analytics Tracking',
          status: site?.metaDescription && site?.hasAnalytics ? 'Strong' : site?.title ? 'Partial' : 'Gap',
          finding: site
            ? `Title ${site.title ? 'present' : 'missing'}, meta description ${site.metaDescription ? 'present' : 'missing'}, analytics ${site.hasAnalytics ? 'detected' : 'not detected'}.`
            : 'No owned SEO foundation to rank for "best school near me" searches.',
          impact: 'Captures organic admission searches without recurring ad spend.',
        },
      ],
    };
  }

  if (/health|hospital|clinic|dental|pharmac|diagnostic|wellness/.test(lower)) {
    return {
      subCategoryDefault: 'Healthcare Clinic / Medical Facility',
      context:
        'Patients in healthcare choose providers based on Google Maps reviews, specialist doctor profiles, instant WhatsApp appointment booking, and local treatment SEO.',
      criteriaGuide:
        'Evaluate: (1) Online appointment booking & WhatsApp patient desk, (2) Doctor credentials & treatment pages, (3) Google Business Profile & Practo/Justdial presence, (4) Patient trust signals & reviews, (5) Local treatment SEO, (6) Follow-up & recall CRM automation.',
      recommendedServiceIds: ['seo', 'whatsapp', 'website', 'google-ads', 'crm'],
      outreachAngle: 'online appointment bookings, WhatsApp patient reminders, and local Google Maps visibility',
      buildBenchmarks: ({ site, serpItems, hasPhone }) => [
        {
          criterion: 'Online Appointment Booking & WhatsApp Patient Desk',
          status: site?.hasLeadForm && site?.hasWhatsApp ? 'Strong' : site?.hasLeadForm || site?.hasWhatsApp ? 'Partial' : 'Gap',
          finding: site
            ? `${site.hasLeadForm ? 'Booking/contact form detected' : 'No appointment form detected'}; ${site.hasWhatsApp ? 'WhatsApp link active' : 'no WhatsApp desk detected'}.`
            : 'No owned online appointment booking portal detected.',
          impact: 'Reduces front-desk drop-offs and increases confirmed consultations.',
        },
        {
          criterion: 'Google Business Profile & Patient Directory Visibility',
          status: serpItems.some((i) => i.sourceKind === 'places' || i.sourceKind === 'knowledgeGraph') ? 'Strong' : 'Partial',
          finding: serpItems.find((i) => i.rating)
            ? `Listed on Google Places (${serpItems.find((i) => i.rating)?.rating}/5 rating).`
            : `Found ${serpItems.length} public web listing(s).`,
          impact: 'High-intent patients search "doctor/clinic near me" before booking.',
        },
        {
          criterion: 'Direct Contact & Emergency Reachability',
          status: hasPhone ? 'Strong' : 'Gap',
          finding: hasPhone ? 'Public patient phone verified.' : 'No verified public phone number found.',
          impact: 'Critical for urgent consultations and patient trust.',
        },
        {
          criterion: 'Treatment SEO & Structured Medical Schema',
          status: site?.hasSchema && site?.metaDescription ? 'Strong' : site?.title ? 'Partial' : 'Gap',
          finding: site
            ? `Meta description ${site.metaDescription ? 'present' : 'missing'}; Schema markup ${site.hasSchema ? 'detected' : 'not detected'}.`
            : 'No website found for specialty/treatment search ranking.',
          impact: 'Captures local treatment searches organically.',
        },
        {
          criterion: 'Analytics & Patient Acquisition Attribution',
          status: site?.hasAnalytics ? 'Strong' : 'Gap',
          finding: site?.hasAnalytics ? 'Analytics tracking detected on website.' : 'No conversion analytics or ad tracking detected.',
          impact: 'Enables measurable ROI across Google Search and Meta health campaigns.',
        },
      ],
    };
  }

  if (/restaurant|cafe|hotel|resort|hospitality|food|beverage/.test(lower)) {
    return {
      subCategoryDefault: 'Hospitality / Food & Beverage Venue',
      context:
        'Winning hospitality brands maximize direct table/room bookings, Google Maps visual ratings, Instagram Reels engagement, and WhatsApp direct ordering to reduce aggregator commissions.',
      criteriaGuide:
        'Evaluate: (1) Direct reservation / room booking / digital menu, (2) Google Maps ratings & photos, (3) Direct WhatsApp ordering vs aggregator dependency, (4) Visual social presence (Instagram/Meta), (5) Local "near me" SEO, (6) Repeat-guest loyalty messaging.',
      recommendedServiceIds: ['social', 'seo', 'whatsapp', 'meta-ads', 'website'],
      outreachAngle: 'direct table/room reservations, Google Maps review growth, and commission-free WhatsApp bookings',
      buildBenchmarks: ({ site, serpItems, hasPhone }) => [
        {
          criterion: 'Direct Booking / Digital Menu Website',
          status: site?.reachable && site.hasLeadForm ? 'Strong' : site?.reachable ? 'Partial' : 'Gap',
          finding: site?.reachable ? `Website active (${site.url}).` : 'No owned booking/menu website detected; likely reliant on third-party aggregators.',
          impact: 'Direct bookings save 15–25% in aggregator commissions.',
        },
        {
          criterion: 'Google Maps Local Pack & Guest Ratings',
          status: serpItems.some((i) => i.rating) ? 'Strong' : serpItems.length > 0 ? 'Partial' : 'Gap',
          finding: serpItems.find((i) => i.rating)
            ? `Google Places rating: ${serpItems.find((i) => i.rating)?.rating}/5 (${serpItems.find((i) => i.rating)?.ratingCount || 0} reviews).`
            : 'Limited Google Places review signals retrieved.',
          impact: 'Primary discovery driver for dining and stay searches.',
        },
        {
          criterion: 'WhatsApp Direct Ordering & Table Inquiries',
          status: site?.hasWhatsApp ? 'Strong' : 'Gap',
          finding: site?.hasWhatsApp ? 'WhatsApp link detected.' : 'No automated WhatsApp reservation/order link detected.',
          impact: 'Speeds up group bookings, catering inquiries, and repeat orders.',
        },
        {
          criterion: 'Visual Social Media (Instagram/Facebook)',
          status: (site?.socialProfiles.length || 0) > 0 ? 'Strong' : 'Partial',
          finding: site?.socialProfiles.length
            ? `Detected ${site.socialProfiles.map((p) => p.platform).join(', ')}.`
            : 'No linked social profiles detected on owned site.',
          impact: 'Visual reels and geo-targeted Meta ads drive weekend footfall.',
        },
        {
          criterion: 'Phone Reachability & Local SEO',
          status: hasPhone && site?.metaDescription ? 'Strong' : hasPhone ? 'Partial' : 'Gap',
          finding: hasPhone ? 'Public reservation phone available.' : 'No verified reservation phone number found.',
          impact: 'Converts mobile "near me" searches into walk-ins.',
        },
      ],
    };
  }

  if (/real estate|property|construction|architecture|interior/.test(lower)) {
    return {
      subCategoryDefault: 'Real Estate / Construction & Interiors',
      context:
        'High-ticket property and interior firms win with project portfolio landing pages, instant WhatsApp brochure delivery, CRM lead pipelines, and Google/Meta lead generation campaigns.',
      criteriaGuide:
        'Evaluate: (1) Project portfolio & floor-plan showcase, (2) High-intent lead capture & WhatsApp instant response, (3) CRM & AI calling follow-up for site visits, (4) Google/Meta performance ads readiness, (5) Local project SEO, (6) Trust & RERA/client proof.',
      recommendedServiceIds: ['meta-ads', 'google-ads', 'crm', 'whatsapp', 'calling'],
      outreachAngle: 'qualified site-visit leads, instant WhatsApp brochure automation, and CRM follow-up workflows',
      buildBenchmarks: ({ site, serpItems, hasPhone }) => [
        {
          criterion: 'Project Showcase & Mobile Conversion Website',
          status: site?.reachable && site.hasLeadForm ? 'Strong' : site?.reachable ? 'Partial' : 'Gap',
          finding: site?.reachable ? `Website live at ${site.url}.` : 'No verified project showcase website detected.',
          impact: 'Buyers expect floor plans, walkthroughs, and transparent specs before scheduling visits.',
        },
        {
          criterion: 'Instant Lead Capture & WhatsApp Brochure Automation',
          status: site?.hasLeadForm && site?.hasWhatsApp ? 'Strong' : site?.hasLeadForm || site?.hasWhatsApp ? 'Partial' : 'Gap',
          finding: site?.hasWhatsApp ? 'WhatsApp contact option detected.' : 'No automated WhatsApp brochure/inquiry desk detected.',
          impact: 'Responding within 5 minutes multiplies site-visit conversion rates.',
        },
        {
          criterion: 'Paid Acquisition Tracking (Google & Meta Pixels)',
          status: site?.hasPaidPixels ? 'Strong' : 'Gap',
          finding: site?.hasPaidPixels ? 'Ad conversion tracking pixel detected.' : 'No Meta/Google Ads conversion pixels detected.',
          impact: 'Prevents wasted ad budget on unqualified property leads.',
        },
        {
          criterion: 'Local Search Visibility & Directory Trust',
          status: serpItems.length >= 3 ? 'Partial' : 'Gap',
          finding: `Found ${serpItems.length} public Google listings/references.`,
          impact: 'Builds buyer confidence during high-value purchase research.',
        },
        {
          criterion: 'Direct Sales Contact Reachability',
          status: hasPhone ? 'Strong' : 'Gap',
          finding: hasPhone ? 'Sales phone number verified.' : 'No verified public phone number found.',
          impact: 'Essential for immediate site-visit scheduling.',
        },
      ],
    };
  }

  if (/ecommerce|e-commerce|retail|fashion|jewell|electronics|furniture|grocery/.test(lower)) {
    return {
      subCategoryDefault: 'Retail / E-Commerce Brand',
      context:
        'Retail and e-commerce growth depends on mobile-first product catalogs, frictionless UPI/online checkout, Meta/Google Shopping pixels, and WhatsApp repeat-purchase automation.',
      criteriaGuide:
        'Evaluate: (1) Online catalog & checkout UX, (2) Google Shopping / Meta pixel tracking, (3) WhatsApp Commerce & repeat-order automation, (4) Google Business Profile for store discovery, (5) Product SEO & schema, (6) Retention CRM.',
      recommendedServiceIds: ['ecommerce', 'meta-ads', 'whatsapp', 'seo', 'analytics'],
      outreachAngle: 'online catalog conversion, Meta/Google shopping campaigns, and WhatsApp repeat-order flows',
      buildBenchmarks: ({ site, serpItems, hasPhone }) => [
        {
          criterion: 'Online Storefront & Checkout Readiness',
          status: site?.hasEcommerce ? 'Strong' : site?.reachable ? 'Partial' : 'Gap',
          finding: site?.hasEcommerce ? 'E-commerce/checkout signals detected.' : site?.reachable ? 'Website exists without clear online checkout.' : 'No owned e-commerce store detected.',
          impact: 'Enables 24/7 direct revenue beyond walk-in store hours.',
        },
        {
          criterion: 'Ad Retargeting Pixels & Analytics',
          status: site?.hasPaidPixels && site?.hasAnalytics ? 'Strong' : site?.hasAnalytics || site?.hasPaidPixels ? 'Partial' : 'Gap',
          finding: site
            ? `Analytics: ${site.hasAnalytics ? 'Detected' : 'Not detected'} · Ad Pixels: ${site.hasPaidPixels ? 'Detected' : 'Not detected'}.`
            : 'No tracking infrastructure detected.',
          impact: 'Required for profitable catalog ads and abandoned-cart recovery.',
        },
        {
          criterion: 'WhatsApp Commerce & Customer Retention',
          status: site?.hasWhatsApp ? 'Strong' : 'Gap',
          finding: site?.hasWhatsApp ? 'WhatsApp channel detected.' : 'No WhatsApp shopping/support channel detected.',
          impact: 'Drives high-margin repeat purchases from existing buyers.',
        },
        {
          criterion: 'Local Store Discovery & Contact',
          status: serpItems.some((i) => i.sourceKind === 'places') && hasPhone ? 'Strong' : hasPhone ? 'Partial' : 'Gap',
          finding: hasPhone ? 'Store phone verified in public listings.' : 'Public store phone missing.',
          impact: 'Captures local shoppers comparing availability and pricing.',
        },
        {
          criterion: 'Product SEO & Structured Schema',
          status: site?.hasSchema ? 'Strong' : 'Gap',
          finding: site?.hasSchema ? 'Structured schema markup detected.' : 'No structured product/store schema detected.',
          impact: 'Improves rich snippets and organic Google Shopping discovery.',
        },
      ],
    };
  }

  if (/manufactur|industrial|automotive|logistics|warehous|wholesale|import|export|solar|energy|agriculture/.test(lower)) {
    return {
      subCategoryDefault: `${industry} B2B Enterprise`,
      context:
        'B2B industrial and manufacturing companies win RFQs through technical spec catalogs, owned website SEO (beyond IndiaMART), fast WhatsApp/CRM quote turnaround, and LinkedIn buyer credibility.',
      criteriaGuide:
        'Evaluate: (1) B2B product catalog & spec sheets, (2) Request-for-Quote (RFQ) workflow & CRM, (3) Directory consistency vs owned SEO, (4) Industrial buyer search visibility & LinkedIn, (5) Fast inquiry response, (6) Lead tracking analytics.',
      recommendedServiceIds: ['website', 'seo', 'crm', 'google-ads', 'whatsapp'],
      outreachAngle: 'direct B2B RFQ generation, technical catalog SEO, and CRM quotation tracking',
      buildBenchmarks: ({ site, serpItems, hasPhone }) => [
        {
          criterion: 'Owned B2B Technical Catalog & RFQ Funnel',
          status: site?.reachable && site.hasLeadForm ? 'Strong' : site?.reachable ? 'Partial' : 'Gap',
          finding: site?.reachable ? `Website active (${site.url}).` : 'No owned B2B catalog website detected.',
          impact: 'Procurement teams shortlist suppliers with clear technical capabilities and instant RFQ forms.',
        },
        {
          criterion: 'B2B Search Visibility vs Directory Dependency',
          status: site?.metaDescription ? 'Partial' : 'Gap',
          finding: `Found ${serpItems.length} Google results; owned SEO ${site?.metaDescription ? 'partially configured' : 'missing'}.`,
          impact: 'Reduces reliance on shared B2B portals where competitors bid on the same lead.',
        },
        {
          criterion: 'Direct Procurement Desk Phone & Email',
          status: hasPhone ? 'Strong' : 'Gap',
          finding: hasPhone ? 'Public sales/office contact number verified.' : 'No verified public phone number found.',
          impact: 'Speeds up urgent commercial and distributor inquiries.',
        },
        {
          criterion: 'WhatsApp & CRM Quote Follow-up Readiness',
          status: site?.hasWhatsApp ? 'Partial' : 'Gap',
          finding: site?.hasWhatsApp ? 'WhatsApp link present.' : 'No instant WhatsApp RFQ channel detected.',
          impact: 'Prevents high-value B2B inquiries from stalling in email inboxes.',
        },
        {
          criterion: 'Analytics & Commercial Lead Attribution',
          status: site?.hasAnalytics ? 'Strong' : 'Gap',
          finding: site?.hasAnalytics ? 'Analytics tracking present.' : 'No web analytics detected.',
          impact: 'Measures cost per qualified industrial RFQ.',
        },
      ],
    };
  }

  return {
    subCategoryDefault: `${industry} Business`,
    context: `Top-performing ${industry} organizations combine a fast mobile website, strong Google Business Profile reviews, targeted local SEO/ads, and automated WhatsApp/CRM lead follow-up.`,
    criteriaGuide: `Evaluate industry-specific digital maturity for ${industry}: (1) Owned website & mobile UX, (2) Google Business Profile & local directory presence, (3) Lead capture / booking funnel, (4) SEO & analytics setup, (5) Social proof & WhatsApp/CRM automation.`,
    recommendedServiceIds: ['website', 'seo', 'whatsapp', 'gbp', 'social'],
    outreachAngle: `${industry}-focused local Google visibility, website conversion upgrades, and WhatsApp lead automation`,
    buildBenchmarks: ({ industry: ind, site, serpItems, hasPhone }) => [
      {
        criterion: `${ind} Owned Website & Mobile Conversion UX`,
        status: site?.reachable && site.hasViewport ? 'Strong' : site?.reachable ? 'Partial' : 'Gap',
        finding: site?.reachable ? `Official site detected (${site.url}).` : 'No verified official website found on Google.',
        impact: `Establishes credibility and captures high-intent ${ind} inquiries directly.`,
      },
      {
        criterion: `${ind} Google Business Profile & Public Reachability`,
        status: serpItems.some((i) => i.sourceKind === 'places' || i.sourceKind === 'knowledgeGraph') && hasPhone ? 'Strong' : hasPhone ? 'Partial' : 'Gap',
        finding: hasPhone ? 'Verified public contact number available.' : 'Public phone number missing or unverified.',
        impact: 'Customers compare nearby listings and call the highest-trust option first.',
      },
      {
        criterion: `${ind} Lead Capture & WhatsApp Desk`,
        status: site?.hasLeadForm && site?.hasWhatsApp ? 'Strong' : site?.hasLeadForm || site?.hasWhatsApp ? 'Partial' : 'Gap',
        finding: site
          ? `Lead form: ${site.hasLeadForm ? 'Detected' : 'Not detected'} · WhatsApp: ${site.hasWhatsApp ? 'Detected' : 'Not detected'}.`
          : 'No online lead capture funnel detected.',
        impact: 'Directly increases qualified inquiry-to-customer conversion.',
      },
      {
        criterion: 'Organic Search SEO & Structured Data',
        status: site?.metaDescription && site?.hasSchema ? 'Strong' : site?.title ? 'Partial' : 'Gap',
        finding: site
          ? `Meta tags: ${site.metaDescription ? 'Detected' : 'Missing'} · Schema: ${site.hasSchema ? 'Detected' : 'Missing'}.`
          : 'No owned SEO presence detected.',
        impact: `Captures recurring organic searches in ${ind}.`,
      },
      {
        criterion: 'Social Media & Performance Tracking',
        status: site?.hasAnalytics || (site?.socialProfiles.length || 0) > 0 ? 'Partial' : 'Gap',
        finding: site
          ? `Social links: ${site.socialProfiles.length} · Analytics: ${site.hasAnalytics ? 'Detected' : 'Not detected'}.`
          : 'No verified analytics or social tracking signals detected.',
        impact: 'Enables measurable brand growth and customer retargeting.',
      },
    ],
  };
}

function buildEvidenceBackedIndustryAnalysis(params: {
  record: SchoolRecord;
  industry: string;
  locationText: string;
  site: WebsiteInspectionResult | null;
  serpItems: SerpResultItem[];
  labResult?: LabEvidenceAnalysis;
  finalPhone?: string;
  finalWebsite?: string;
  mergedSources: GroundingSource[];
  now: string;
}): {
  industryAnalysis: IndustryAnalysis;
  digitalChecks: DigitalCheckItem[];
  websiteReview: WebsiteReview;
} {
  const { record, industry, locationText, site, serpItems, labResult, finalPhone, finalWebsite, mergedSources, now } = params;
  const playbook = getIndustryPlaybook(industry);
  const hasPhone = hasValidPhone(finalPhone);
  const benchmarks = playbook.buildBenchmarks({ industry, site, serpItems, labResult, hasPhone });

  const strongCount = benchmarks.filter((b) => b.status === 'Strong').length;
  const partialCount = benchmarks.filter((b) => b.status === 'Partial').length;
  const maturityScore = Math.max(18, Math.min(92, Math.round(18 + strongCount * 15 + partialCount * 7)));
  const maturityLabel: IndustryAnalysis['maturityLabel'] =
    maturityScore >= 75 ? 'Advanced' : maturityScore >= 55 ? 'Developing' : maturityScore >= 38 ? 'Early Stage' : 'Needs Foundation';

  const strengths = benchmarks
    .filter((b) => b.status === 'Strong')
    .map((b) => `${b.criterion}: ${b.finding}`);
  if (strengths.length === 0 && serpItems.length > 0) {
    strengths.push(`Discoverable in ${serpItems.length} public Google search/directory listing(s).`);
  }

  const gaps = benchmarks
    .filter((b) => b.status === 'Gap' || b.status === 'Unconfirmed')
    .map((b) => `${b.criterion} — ${b.finding}`);

  const recommendedServices = playbook.recommendedServiceIds
    .map((id) => NATTON_SERVICES.find((s) => s.id === id))
    .filter((s): s is (typeof NATTON_SERVICES)[number] => Boolean(s))
    .slice(0, 4)
    .map((svc, idx) => ({
      serviceId: svc.id,
      serviceName: svc.label,
      priority: (idx < 2 ? 'High' : 'Medium') as 'High' | 'Medium',
      rationale: `Directly addresses observed ${industry} digital gaps for ${record.name}${!finalWebsite && svc.id === 'website' ? ' (no official website detected)' : ''}.`,
      expectedOutcome: `Improves qualified ${industry} inquiries and measurable conversion in ${locationText || 'the local market'}.`,
    }));

  const primaryUrl = finalWebsite || mergedSources[0]?.url;

  const digitalChecks: DigitalCheckItem[] = [
    {
      service: 'Website development',
      status: site?.reachable ? 'Detected' : finalWebsite ? 'Needs review' : 'Not detected',
      evidence: site?.reachable ? `Live website inspected (${site.url}).` : finalWebsite ? `URL listed (${finalWebsite}) but did not respond to live HTML check.` : 'No official website found in live directory/search results.',
      sourceUrl: primaryUrl,
    },
    {
      service: 'Mobile responsiveness',
      status: site?.hasViewport ? 'Detected' : site?.reachable ? 'Not detected' : 'Not detected',
      evidence: site?.hasViewport ? 'Responsive mobile viewport meta tag detected.' : site?.reachable ? 'Website loaded without a mobile viewport meta tag.' : 'No live mobile-responsive website detected.',
      sourceUrl: primaryUrl,
    },
    {
      service: 'SEO: page title',
      status: site?.title ? 'Detected' : 'Not detected',
      evidence: site?.title ? `Page title detected: "${site.title}"` : 'No HTML page title tag verified.',
      sourceUrl: primaryUrl,
    },
    {
      service: 'SEO: meta description',
      status: site?.metaDescription ? 'Detected' : 'Not detected',
      evidence: site?.metaDescription ? `Meta description detected (${site.metaDescription.slice(0, 90)}...).` : 'No meta description tag detected.',
      sourceUrl: primaryUrl,
    },
    {
      service: 'SEO: heading',
      status: site?.hasH1Heading ? 'Detected' : 'Not detected',
      evidence: site?.hasH1Heading ? 'Primary H1 heading structure detected on homepage.' : 'No H1 heading structure detected.',
      sourceUrl: primaryUrl,
    },
    {
      service: 'Google Business Profile',
      status:
        serpItems.some((i) => i.sourceKind === 'places' || i.sourceKind === 'knowledgeGraph') ||
        site?.hasGoogleMapsEmbed ||
        Boolean(record.mapsUrl && hasPhone)
          ? 'Detected'
          : serpItems.length > 0 || Boolean(record.mapsUrl)
          ? 'Needs review'
          : 'Not detected',
      evidence:
        serpItems.find((i) => i.sourceKind === 'places' || i.sourceKind === 'knowledgeGraph')?.snippet ||
        (site?.hasGoogleMapsEmbed ? 'Google Maps / Business Profile link embedded on website.' : `Public map/directory listing present (${record.area || record.city}); confirm GBP ownership & reviews.`),
      sourceUrl: primaryUrl || record.mapsUrl,
    },
    {
      service: 'Social media presence',
      status: (site?.socialProfiles.length || 0) > 0 ? 'Detected' : site?.reachable ? 'Not detected' : 'Needs review',
      evidence: site?.socialProfiles.length ? `Linked social profiles: ${site.socialProfiles.map((p) => p.platform).join(', ')}.` : 'No linked Instagram/Facebook/LinkedIn/YouTube profiles found on website.',
      sourceUrl: primaryUrl,
    },
    {
      service: 'Lead generation / booking',
      status: site?.hasLeadForm || site?.hasWhatsApp ? 'Detected' : 'Not detected',
      evidence: site?.hasLeadForm || site?.hasWhatsApp ? 'Online inquiry/booking form or WhatsApp contact detected.' : 'No online inquiry, quote, or appointment form detected.',
      sourceUrl: primaryUrl,
    },
    {
      service: 'Analytics setup',
      status: site?.hasAnalytics ? 'Detected' : 'Not detected',
      evidence: site?.hasAnalytics ? 'Google Analytics / Tag Manager / Clarity script detected in HTML.' : 'No Google Analytics or Tag Manager script detected.',
      sourceUrl: primaryUrl,
    },
    {
      service: 'Paid ads tracking',
      status: site?.hasPaidPixels ? 'Detected' : 'Not detected',
      evidence: site?.hasPaidPixels ? 'Paid ad conversion tracking pixel detected in HTML.' : 'No Google Ads or Meta conversion pixel detected.',
      sourceUrl: primaryUrl,
    },
    {
      service: 'Google Ads tracking',
      status: site?.hasGoogleAdsTag ? 'Detected' : 'Not detected',
      evidence: site?.hasGoogleAdsTag ? 'Google Ads conversion/remarketing tag (AW-/googleadservices) detected.' : 'No Google Ads conversion tag detected on website.',
      sourceUrl: primaryUrl,
    },
    {
      service: 'Meta Ads tracking',
      status: site?.hasMetaPixel ? 'Detected' : 'Not detected',
      evidence: site?.hasMetaPixel ? 'Meta Pixel (Facebook/Instagram fbevents/fbq) detected on website.' : 'No Meta Pixel (Facebook/Instagram ads tracking) detected.',
      sourceUrl: primaryUrl,
    },
    {
      service: 'Content marketing',
      status: site?.hasBlogOrContent ? 'Detected' : 'Not detected',
      evidence: site?.hasBlogOrContent ? 'Blog, articles, or news/insights section detected on website.' : 'No blog or educational content section detected.',
      sourceUrl: primaryUrl,
    },
    {
      service: 'AEO & FAQ structure',
      status: site?.hasFaqOrAeo ? 'Detected' : 'Not detected',
      evidence: site?.hasFaqOrAeo ? 'FAQ section or FAQPage/HowTo schema detected for AI answer engines.' : 'No FAQ/AEO structured answers detected.',
      sourceUrl: primaryUrl,
    },
    {
      service: 'Brand & visual media',
      status: site?.hasBrandMedia ? 'Detected' : 'Not detected',
      evidence: site?.hasBrandMedia ? 'OpenGraph brand creatives, video, or downloadable brochure assets detected.' : 'No OpenGraph brand creatives or digital brochure assets detected.',
      sourceUrl: primaryUrl,
    },
    {
      service: 'Email marketing & newsletter',
      status: site?.hasEmailMarketing ? 'Detected' : 'Not detected',
      evidence: site?.hasEmailMarketing ? 'Newsletter signup or email marketing platform script detected.' : 'No email newsletter signup or email automation tool detected.',
      sourceUrl: primaryUrl,
    },
    {
      service: 'E-commerce functionality',
      status: site?.hasEcommerce ? 'Detected' : 'Not detected',
      evidence: site?.hasEcommerce ? 'Online cart, checkout, or payment gateway signals detected.' : 'No online store checkout or payment gateway detected.',
      sourceUrl: primaryUrl,
    },
    {
      service: 'Structured data',
      status: site?.hasSchema ? 'Detected' : 'Not detected',
      evidence: site?.hasSchema ? 'JSON-LD structured schema markup detected.' : 'No JSON-LD structured schema markup detected.',
      sourceUrl: primaryUrl,
    },
    {
      service: 'WhatsApp automation',
      status: site?.hasWhatsApp ? 'Detected' : 'Not detected',
      evidence: site?.hasWhatsApp ? 'WhatsApp chat link or WhatsApp Business widget detected on website.' : 'No WhatsApp chat button or WhatsApp automation link detected.',
      sourceUrl: primaryUrl,
    },
    {
      service: 'Live chat & conversational AI',
      status: site?.hasChatbotOrLiveChat ? 'Detected' : 'Not detected',
      evidence: site?.hasChatbotOrLiveChat ? 'Live chat widget or conversational chatbot script detected on website.' : 'No live chat widget or AI chatbot detected on website.',
      sourceUrl: primaryUrl,
    },
    {
      service: 'CRM & marketing automation',
      status: site?.hasCrmScript ? 'Detected' : 'Not detected',
      evidence: site?.hasCrmScript ? 'CRM/automation embed (HubSpot/Zoho/LeadSquared/Salesforce) detected.' : 'No public CRM or marketing automation script detected.',
      sourceUrl: primaryUrl,
    },
    {
      service: 'Cloud telephony & click-to-call',
      status: site?.hasCloudTelephony || hasPhone ? (site?.hasCloudTelephony ? 'Detected' : 'Needs review') : 'Not detected',
      evidence: site?.hasCloudTelephony
        ? 'Click-to-call (tel:), toll-free, or cloud telephony/callback script detected.'
        : hasPhone
        ? `Public phone (${finalPhone}) exists; no automated cloud telephony / AI calling IVR detected.`
        : 'No click-to-call or cloud telephony system detected.',
      sourceUrl: primaryUrl,
    },
  ];

  const websiteReview: WebsiteReview = {
    checkedAt: now,
    verdict: site?.reachable
      ? maturityScore >= 70
        ? 'Solid web presence — ready for growth automation & SEO scaling'
        : 'Website live — upgrade mobile conversion, SEO metadata & WhatsApp funnel'
      : 'No official website detected — high-priority foundation opportunity',
    summary: site?.reachable
      ? `Inspected ${site.url} against ${industry} benchmarks. Key improvements focus on ${gaps[0] || 'conversion optimization and local search visibility'}.`
      : `No verified official website was found for ${record.name} in Google search results. Launching an industry-tailored ${industry} website with WhatsApp lead capture is the highest-impact first step.`,
    pagesInspected: site?.reachable ? [site.url] : [],
    checks: benchmarks.map((b) => ({
      label: b.criterion,
      result: b.status === 'Strong' ? 'Pass' : b.status === 'Partial' ? 'Improve' : 'Not detected',
      priority: b.status === 'Gap' ? 'High' : b.status === 'Partial' ? 'Medium' : 'Low',
      evidence: b.finding,
      recommendation: b.impact,
      sourceUrl: primaryUrl,
    })),
    limitations: ['Based on live SerpForge Google search results and public homepage inspection.'],
  };

  const industryAnalysis: IndustryAnalysis = {
    industry,
    subCategory: serpItems.find((i) => i.category)?.category || playbook.subCategoryDefault,
    analyzedAt: now,
    maturityScore,
    maturityLabel,
    executiveSummary: `${record.name} (${industry}${locationText ? `, ${locationText}` : ''}) scored ${maturityScore}/100 (${maturityLabel}) based on live Google Search and public website inspection. ${
      gaps.length > 0
        ? `Primary ${industry} growth opportunities include addressing ${gaps.slice(0, 2).map((g) => g.split(' — ')[0]).join(' and ')}.`
        : `Public digital fundamentals are in place and ready for performance scaling.`
    }`,
    industryContext: playbook.context,
    benchmarks,
    strengths,
    gaps,
    recommendedServices,
    outreachPitch: `Hello team at ${record.name}, we reviewed your ${industry} digital presence in ${locationText || 'your area'} and identified practical quick wins around ${playbook.outreachAngle}. Would you be open to a brief 10-minute walkthrough tailored for ${record.name}?`,
    sources: mergedSources,
  };

  return { industryAnalysis, digitalChecks, websiteReview };
}

export async function analyzeBusinessByIndustry(
  record: SchoolRecord,
  overrideWebsite?: string,
  options?: { businessOnly?: boolean }
): Promise<SchoolRecord> {
  const now = new Date().toISOString();
  const industry = (record.industry || (options?.businessOnly ? 'General Business' : 'Education')).trim();
  const locationText = buildCleanLocation(record.area, record.city, record.state);
  const websiteHint = safeExternalUrl(overrideWebsite) || safeExternalUrl(record.website);
  const playbook = getIndustryPlaybook(industry);
  // Strictly NEVER fetch or evaluate school computer lab info when analyzing a Business!
  const isEdu = !options?.businessOnly && record.recordType !== 'BUSINESS' && isEducationRecord({ ...record, industry });

  // Step 1: Gather real public directory (lifetime-free OSM) + optional SerpForge + live HTML inspection!
  let serpItems: SerpResultItem[] = [];
  const [osmSingle] = await Promise.all([
    !websiteHint || !hasValidPhone(record.contactPhone)
      ? queryOpenStreetMapSingle(record.name, locationText)
      : Promise.resolve(null),
  ]);

  if (hasSerpForgeKey() && consecutiveEmptySerpCount < 2) {
    const webRes = await querySerpForge(
      `${record.name} ${locationText} ${isEdu ? 'computer lab ICT lab' : industry} official website phone contact`.trim(),
      'search',
      8
    );
    serpItems = [...webRes.items];
    if (webRes.status !== 401 && webRes.status !== 403 && !hasValidPhone(record.contactPhone)) {
      const placesRes = await querySerpForge(`${record.name} ${locationText}`.trim(), 'places', 5);
      if (placesRes.ok) {
        serpItems = [...placesRes.items, ...serpItems];
      }
    }
  }

  const candidateWebsite = websiteHint || safeExternalUrl(osmSingle?.website) || pickBestOfficialWebsite(serpItems);
  const siteInspection = candidateWebsite ? await inspectPublicWebsiteSafe(candidateWebsite, 3200) : null;
  const serpContacts = extractContactsFromSerpAndSite(serpItems, siteInspection);
  if (!serpContacts.phone && osmSingle?.phone) {
    serpContacts.phone = cleanPhoneCandidate(osmSingle.phone);
    serpContacts.phoneSourceUrl = osmSingle.website || osmSingle.mapsUrl;
  }
  if (!serpContacts.email && osmSingle?.email) {
    serpContacts.email = cleanEmailCandidate(osmSingle.email);
  }
  if (!serpContacts.website && osmSingle?.website) {
    serpContacts.website = safeExternalUrl(osmSingle.website);
  }
  if (!serpContacts.address && osmSingle?.address) {
    serpContacts.address = osmSingle.address;
  }
  const serpLabAnalysis = isEdu ? analyzeComputerLabEvidence(record.name, serpItems, siteInspection) : undefined;

  // Step 2: Try Gemini synthesis if configured
  type GeminiAnalysisPayload = {
    matchStatus?: ResearchProfile['matchStatus'];
    matchReason?: string;
    website?: string;
    contactPhone?: string;
    contactEmail?: string;
    address?: string;
    contactPerson?: string;
    socialProfiles?: Array<{ platform?: string; url?: string }>;
    marketingIntent?: {
      status?: ResearchProfile['marketingIntent']['status'];
      summary?: string;
    };
    computerLab?: string;
    labComputersCount?: number | null;
    labInternetAvailable?: string;
    labVerificationNote?: string;
    industryAnalysis?: Omit<IndustryAnalysis, 'industry' | 'analyzedAt' | 'sources'>;
    digitalChecks?: DigitalCheckItem[];
    websiteReview?: {
      verdict?: string;
      summary?: string;
      checks?: WebsiteReview['checks'];
    };
  };
  let aiData: GeminiAnalysisPayload | null = null;
  let geminiSources: GroundingSource[] = [];
  let geminiGrounded = false;

  const hasSerpEvidence = serpItems.length > 0 || Boolean(siteInspection?.reachable);
  const geminiAvailable = Boolean(getGeminiClient());

  if (geminiAvailable) {
    const serpContext = serpItems.length
      ? `\nLive Search & Directory results:\n${serpItems
          .map((r) => `- [${r.sourceKind}] ${r.title} (${r.link || r.website || ''}): ${r.snippet || ''}${r.phoneNumber ? ` | Phone: ${r.phoneNumber}` : ''}${r.address ? ` | Address: ${r.address}` : ''}`)
          .join('\n')}`
      : '';
    const siteContext = siteInspection?.reachable
      ? `\nLive Website HTML Inspection (${siteInspection.url}):\n- Title: ${siteInspection.title || 'None'}\n- Meta Description: ${siteInspection.metaDescription || 'None'}\n- H1 Heading: ${siteInspection.hasH1Heading}\n- Mobile Viewport: ${siteInspection.hasViewport}\n- Schema JSON-LD: ${siteInspection.hasSchema}\n- Analytics: ${siteInspection.hasAnalytics}\n- Google Ads Tag: ${siteInspection.hasGoogleAdsTag}\n- Meta Pixel: ${siteInspection.hasMetaPixel}\n- Lead Form: ${siteInspection.hasLeadForm}\n- WhatsApp: ${siteInspection.hasWhatsApp}\n- Live Chat / Chatbot: ${siteInspection.hasChatbotOrLiveChat}\n- CRM Script: ${siteInspection.hasCrmScript}\n- Email Newsletter: ${siteInspection.hasEmailMarketing}\n- Blog / Content: ${siteInspection.hasBlogOrContent}\n- FAQ / AEO: ${siteInspection.hasFaqOrAeo}\n- Brand Media: ${siteInspection.hasBrandMedia}\n- Cloud Telephony / Tel: ${siteInspection.hasCloudTelephony}\n- E-commerce: ${siteInspection.hasEcommerce}\n- Social Links: ${siteInspection.socialProfiles.map((p) => p.platform).join(', ') || 'None'}\n- Hiring/Need Signals: ${siteInspection.hiringOrNeedSignals.join('; ') || 'None'}\n- Phones found: ${siteInspection.phones.join(', ') || 'None'}\n- Emails found: ${siteInspection.emails.join(', ') || 'None'}\n- Text excerpt: ${siteInspection.plainText.slice(0, 1200)}`
      : '';

    const serviceIdsText = NATTON_SERVICES.map((s) => `${s.id} (${s.label})`).join(', ');
    const prompt = `You are a Senior Business Intelligence Analyst for Natton Digital & Natton SkillX Junior.
Produce an **INDUSTRY-SPECIFIC BUSINESS ANALYSIS** tailored strictly to the **${industry}** industry for this organization, using the verified public search and website evidence below${hasSerpEvidence ? '' : ' and Google Search'}.

Target Business:
- Name: ${record.name}
- Industry: ${industry}
- Location: ${locationText || 'India'}
- Supplied Website: ${websiteHint || 'None'}
- Existing Phone from Excel: ${hasValidPhone(record.contactPhone) ? record.contactPhone : 'MISSING — extract verified public phone if present'}
- Existing Email from Excel: ${record.contactEmail || 'MISSING'}
${isEdu ? '- Special Requirement (Education/School): ALSO verify whether this school has a Computer Lab / ICT Lab ("Yes", "No", or "Unverified"), approximate computer count if stated, and evidence quote.' : ''}
${serpContext}
${siteContext}

Industry Evaluation Criteria for ${industry}:
${playbook.criteriaGuide}

Available Natton Service IDs (pick 3 to 5 BEST-FIT services specifically for this ${industry} business):
${serviceIdsText}

Return ONLY a valid JSON object matching this exact schema:
{
  "matchStatus": "Verified" | "Likely match" | "Needs review" | "No match",
  "matchReason": "1-sentence confirmation of which real entity matched",
  "website": "official https URL if found, else empty string",
  "contactPhone": "verified public phone number if found, else empty string",
  "contactEmail": "verified public email if found, else empty string",
  "address": "verified physical address if found, else empty string",
  "contactPerson": "owner, principal, or key decision-maker name if publicly listed, else empty string",
  "socialProfiles": [{ "platform": "Instagram|Facebook|LinkedIn|YouTube|X", "url": "https://..." }],
  "marketingIntent": {
    "status": "Public request found" | "Growth signals detected" | "No public request" | "Unknown",
    "summary": "Brief factual note on hiring, expansion, ads, or growth activity observed publicly"
  },
  "computerLab": ${isEdu ? '"Yes" | "No" | "Unverified"' : '"Unverified"'},
  "labComputersCount": null,
  "labInternetAvailable": "${isEdu ? 'High-speed Broadband / LAN or Unconfirmed' : ''}",
  "labVerificationNote": "${isEdu ? 'Evidence quote regarding school computer lab' : ''}",
  "industryAnalysis": {
    "subCategory": "Specific niche inside ${industry}",
    "maturityScore": 50,
    "maturityLabel": "Advanced" | "Developing" | "Early Stage" | "Needs Foundation",
    "executiveSummary": "2-3 sentence tailored analysis of this business in ${industry}",
    "industryContext": "1-2 sentences explaining what winning competitors in ${industry} do digitally",
    "benchmarks": [
      {
        "criterion": "Specific ${industry} criterion",
        "status": "Strong" | "Partial" | "Gap" | "Unconfirmed",
        "finding": "What was actually found",
        "impact": "Business impact in ${industry}"
      }
    ],
    "strengths": ["Concrete observed strength"],
    "gaps": ["Concrete ${industry}-specific gap"],
    "recommendedServices": [
      {
        "serviceId": "exact id from list above",
        "serviceName": "exact label",
        "priority": "High" | "Medium" | "Low",
        "rationale": "Why this service solves a specific ${industry} gap for ${record.name}",
        "expectedOutcome": "Measurable business benefit for ${industry}"
      }
    ],
    "outreachPitch": "2-3 sentence consultative outreach opener tailored specifically to ${record.name} in ${industry}"
  },
  "digitalChecks": [
    { "service": "Website development", "status": "Detected" | "Not detected" | "Needs review", "evidence": "factual observation" },
    { "service": "Mobile responsiveness", "status": "Detected" | "Not detected" | "Needs review", "evidence": "factual observation" },
    { "service": "SEO: page title", "status": "Detected" | "Not detected" | "Needs review", "evidence": "factual observation" },
    { "service": "SEO: meta description", "status": "Detected" | "Not detected" | "Needs review", "evidence": "factual observation" },
    { "service": "Google Business Profile", "status": "Detected" | "Not detected" | "Needs review", "evidence": "factual observation" },
    { "service": "Social media presence", "status": "Detected" | "Not detected" | "Needs review", "evidence": "factual observation" },
    { "service": "Lead generation / booking", "status": "Detected" | "Not detected" | "Needs review", "evidence": "factual observation" },
    { "service": "Analytics setup", "status": "Detected" | "Not detected" | "Needs review", "evidence": "factual observation" },
    { "service": "Paid ads tracking", "status": "Detected" | "Not detected" | "Needs review", "evidence": "factual observation" },
    { "service": "Structured data", "status": "Detected" | "Not detected" | "Needs review", "evidence": "factual observation" }
  ],
  "websiteReview": {
    "verdict": "Short verdict",
    "summary": "2 sentences summarizing website state and highest-impact improvement for ${industry}",
    "checks": [
      {
        "label": "Check name",
        "result": "Pass" | "Improve" | "Not detected",
        "priority": "High" | "Medium" | "Low",
        "evidence": "Observed finding",
        "recommendation": "Actionable improvement"
      }
    ]
  }
}
Rules:
- Benchmarks array MUST contain 5 to 6 criteria tailored specifically to "${industry}".
- Never fabricate phone numbers, emails, or URLs.`;

    try {
      // Only enable Gemini Google Search tool when SerpForge/live inspection did NOT already provide search evidence
      const res = await runGeminiJsonPrompt<GeminiAnalysisPayload>(prompt, !hasSerpEvidence, true);
      aiData = res.data;
      geminiSources = res.sources;
      geminiGrounded = res.grounded;
    } catch {
      // Gracefully synthesize tailored industry benchmarks from live website / directory / industry rubric instead of failing on transient 429/503!
    }
  }

  // If Gemini returned an official website URL we hadn't inspected yet, live-inspect it now so ALL 27 services get real HTML evidence!
  let finalSiteInspection = siteInspection;
  const geminiDiscoveredWeb = safeExternalUrl(aiData?.website);
  if (!finalSiteInspection && geminiDiscoveredWeb && geminiDiscoveredWeb !== candidateWebsite) {
    finalSiteInspection = await inspectPublicWebsiteSafe(geminiDiscoveredWeb, 2800);
  }

  const mergedSources = mergeSourcesFromSerp(serpItems, geminiSources);
  if (finalSiteInspection?.reachable && !mergedSources.some((s) => s.url === finalSiteInspection!.url)) {
    mergedSources.unshift({ title: finalSiteInspection.title || finalSiteInspection.url, url: finalSiteInspection.url });
  }
  const sourceTag: ContactSourceType = finalSiteInspection?.reachable
    ? 'Official Website'
    : serpItems.length > 0
    ? 'SerpForge'
    : 'Google Search';

  const finalWebsite =
    safeExternalUrl(overrideWebsite) ||
    finalSiteInspection?.url ||
    (geminiGrounded ? geminiDiscoveredWeb : undefined) ||
    serpContacts.website ||
    safeExternalUrl(record.website);
  const primarySourceUrl = finalWebsite || mergedSources[0]?.url;

  // Anti-hallucination guard: only accept phone/email from Excel, live HTML site, OSM, SerpForge, or grounded Google Search!
  const excelHasPhone = hasValidPhone(record.contactPhone);
  const discoveredPhone =
    finalSiteInspection?.phones[0] ||
    serpContacts.phone ||
    (geminiGrounded ? cleanPhoneCandidate(aiData?.contactPhone) : undefined);
  const finalPhone = excelHasPhone ? record.contactPhone : discoveredPhone;
  const finalPhoneSource: ContactSourceType | undefined = excelHasPhone
    ? record.contactPhoneSource || 'Uploaded Excel'
    : discoveredPhone
    ? finalSiteInspection?.phones[0]
      ? 'Official Website'
      : serpContacts.phone
      ? serpItems.length > 0
        ? 'SerpForge'
        : 'Google Search'
      : 'Google Search'
    : undefined;
  const finalPhoneSourceUrl = excelHasPhone
    ? record.contactPhoneSourceUrl
    : discoveredPhone
    ? (finalSiteInspection?.phones[0] ? finalSiteInspection.url : serpContacts.phoneSourceUrl) || primarySourceUrl
    : undefined;

  const excelHasEmail = Boolean(cleanEmailCandidate(record.contactEmail));
  const discoveredEmail =
    finalSiteInspection?.emails[0] ||
    serpContacts.email ||
    (geminiGrounded ? cleanEmailCandidate(aiData?.contactEmail) : undefined);
  const finalEmail = excelHasEmail ? record.contactEmail : discoveredEmail;
  const finalEmailSource: ContactSourceType | undefined = excelHasEmail
    ? record.contactEmailSource || 'Uploaded Excel'
    : discoveredEmail
    ? finalSiteInspection?.emails[0]
      ? 'Official Website'
      : sourceTag
    : undefined;

  const finalAddress = record.address?.trim() || serpContacts.address || (geminiGrounded ? aiData?.address?.trim() : undefined) || locationText || record.area;

  const fallbackBundle = buildEvidenceBackedIndustryAnalysis({
    record,
    industry,
    locationText,
    site: finalSiteInspection,
    serpItems,
    labResult: serpLabAnalysis,
    finalPhone,
    finalWebsite,
    mergedSources,
    now,
  });

  const phonesList: ContactEvidenceItem[] = [];
  if (excelHasPhone && record.contactPhone) {
    phonesList.push({
      value: record.contactPhone,
      sourceType: record.contactPhoneSource || 'Uploaded Excel',
      sourceUrl: record.contactPhoneSourceUrl,
      confidence: 'High',
      checkedAt: now,
    });
  }
  if (discoveredPhone && discoveredPhone !== record.contactPhone) {
    phonesList.push({
      value: discoveredPhone,
      sourceType: sourceTag,
      sourceUrl: finalPhoneSourceUrl,
      confidence: 'High',
      checkedAt: now,
    });
  }

  const emailsList: ContactEvidenceItem[] = [];
  if (excelHasEmail && record.contactEmail) {
    emailsList.push({
      value: record.contactEmail,
      sourceType: record.contactEmailSource || 'Uploaded Excel',
      confidence: 'High',
      checkedAt: now,
    });
  }
  if (discoveredEmail && discoveredEmail !== record.contactEmail) {
    emailsList.push({
      value: discoveredEmail,
      sourceType: sourceTag,
      sourceUrl: primarySourceUrl,
      confidence: 'Medium',
      checkedAt: now,
    });
  }

  const socialProfiles = [
    ...(aiData?.socialProfiles || [])
      .filter((s) => s.platform && safeExternalUrl(s.url))
      .map((s) => ({ platform: s.platform!, url: safeExternalUrl(s.url)!, sourceUrl: primarySourceUrl })),
    ...(siteInspection?.socialProfiles || []).map((s) => ({ ...s, sourceUrl: siteInspection?.url })),
  ].filter((item, idx, arr) => arr.findIndex((x) => x.url === item.url) === idx);

  const industryAnalysis: IndustryAnalysis = aiData?.industryAnalysis?.benchmarks?.length
    ? {
        industry,
        subCategory: aiData.industryAnalysis.subCategory || fallbackBundle.industryAnalysis.subCategory,
        analyzedAt: now,
        maturityScore:
          typeof aiData.industryAnalysis.maturityScore === 'number'
            ? Math.max(5, Math.min(100, Math.round(aiData.industryAnalysis.maturityScore)))
            : fallbackBundle.industryAnalysis.maturityScore,
        maturityLabel: aiData.industryAnalysis.maturityLabel || fallbackBundle.industryAnalysis.maturityLabel,
        executiveSummary: aiData.industryAnalysis.executiveSummary || fallbackBundle.industryAnalysis.executiveSummary,
        industryContext: aiData.industryAnalysis.industryContext || fallbackBundle.industryAnalysis.industryContext,
        benchmarks: aiData.industryAnalysis.benchmarks,
        strengths: Array.isArray(aiData.industryAnalysis.strengths) && aiData.industryAnalysis.strengths.length > 0
          ? aiData.industryAnalysis.strengths
          : fallbackBundle.industryAnalysis.strengths,
        gaps: Array.isArray(aiData.industryAnalysis.gaps) && aiData.industryAnalysis.gaps.length > 0
          ? aiData.industryAnalysis.gaps
          : fallbackBundle.industryAnalysis.gaps,
        recommendedServices:
          Array.isArray(aiData.industryAnalysis.recommendedServices) && aiData.industryAnalysis.recommendedServices.length > 0
            ? aiData.industryAnalysis.recommendedServices
            : fallbackBundle.industryAnalysis.recommendedServices,
        outreachPitch: aiData.industryAnalysis.outreachPitch || fallbackBundle.industryAnalysis.outreachPitch,
        sources: mergedSources,
      }
    : fallbackBundle.industryAnalysis;

  // Merge live HTML digitalChecks with any additional Gemini checks (live HTML proof always takes precedence for accuracy!)
  const liveCheckMap = new Map(fallbackBundle.digitalChecks.map((c) => [c.service, c]));
  if (Array.isArray(aiData?.digitalChecks) && geminiGrounded) {
    for (const c of aiData.digitalChecks) {
      if (!c?.service) continue;
      const existing = liveCheckMap.get(c.service);
      if (!existing || (!finalSiteInspection?.reachable && existing.status === 'Not detected' && c.status === 'Detected')) {
        liveCheckMap.set(c.service, {
          service: c.service,
          status: c.status || 'Needs review',
          evidence: c.evidence || 'Evaluated from grounded search results.',
          sourceUrl: primarySourceUrl,
        });
      }
    }
  }
  const checks: DigitalCheckItem[] = Array.from(liveCheckMap.values());

  const detectedNeedSignals = finalSiteInspection?.hiringOrNeedSignals || [];
  const computedIntentStatus: ResearchProfile['marketingIntent']['status'] =
    detectedNeedSignals.length > 0
      ? 'Public request found'
      : aiData?.marketingIntent?.status || (fallbackBundle.industryAnalysis.gaps.length >= 3 ? 'Growth signals detected' : 'No public request');
  const computedIntentSummary =
    detectedNeedSignals.length > 0
      ? detectedNeedSignals.join('. ')
      : aiData?.marketingIntent?.summary ||
        `Evaluated live digital footprint across all 27 Natton services for ${industry} opportunities.`;

  const research: ResearchProfile = {
    matchStatus: aiData?.matchStatus || (mergedSources.length > 0 ? 'Verified' : 'Needs review'),
    matchReason: aiData?.matchReason || `Researched in ${industry} (${locationText || 'India'}) via ${sourceTag}.`,
    checkedAt: now,
    emails: emailsList,
    phones: phonesList,
    addresses: finalAddress
      ? [{ value: finalAddress, sourceUrl: primarySourceUrl, sourceType: record.address ? 'Uploaded Excel' : sourceTag, confidence: 'High', checkedAt: now }]
      : [],
    socialProfiles,
    metadata: [
      { label: 'Industry', value: industry, sourceUrl: primarySourceUrl },
      ...(industryAnalysis.subCategory ? [{ label: 'Sub-category', value: industryAnalysis.subCategory, sourceUrl: primarySourceUrl }] : []),
      ...(aiData?.contactPerson || serpContacts.contactPerson
        ? [{ label: 'Key Contact', value: (aiData?.contactPerson || serpContacts.contactPerson)!, sourceUrl: primarySourceUrl }]
        : []),
    ],
    fieldCoverage: [
      {
        field: 'Contact Phone',
        status: finalPhone ? 'Found' : 'Missing',
        detail: finalPhone ? `${finalPhone} (${finalPhoneSource})` : 'No public phone found yet',
      },
      {
        field: 'Email',
        status: finalEmail ? 'Found' : 'Missing',
        detail: finalEmail ? `${finalEmail} (${finalEmailSource})` : 'No public email found',
      },
      {
        field: 'Website',
        status: finalWebsite ? 'Found' : 'Missing',
        detail: finalWebsite || 'No official website detected',
      },
      {
        field: 'Industry Audit',
        status: 'Found',
        detail: `${industry} tailored analysis + 27-service scan completed`,
      },
    ],
    marketingIntent: {
      status: computedIntentStatus,
      summary: computedIntentSummary,
      evidence: [
        ...detectedNeedSignals.map((sig) => ({ text: sig, sourceUrl: finalSiteInspection?.url })),
        ...mergedSources.slice(0, 3).map((s) => ({ text: s.title, sourceUrl: s.url })),
      ],
    },
    warnings: !finalWebsite ? ['No official website verified; findings rely on public directory & search listings.'] : [],
  };

  const digitalAudit: DigitalAudit = {
    checkedAt: now,
    websiteUrl: finalWebsite,
    identityStatus: research.matchStatus,
    checks,
    recommendations: industryAnalysis.recommendedServices.map(
      (r) => `${r.serviceName} (${r.priority} priority): ${r.rationale}`
    ),
    sources: mergedSources,
    limitations: ['Public search & website evidence only. Confirm internal software, ad spend, and buying goals directly with the business.'],
  };

  const websiteReview: WebsiteReview =
    aiData?.websiteReview?.checks?.length
      ? {
          checkedAt: now,
          verdict: aiData.websiteReview.verdict || fallbackBundle.websiteReview.verdict,
          summary: aiData.websiteReview.summary || fallbackBundle.websiteReview.summary,
          pagesInspected: finalWebsite ? [finalWebsite] : [],
          checks: aiData.websiteReview.checks.map((c) => ({ ...c, sourceUrl: primarySourceUrl })),
          limitations: ['Private analytics and backend CRM configurations require customer confirmation.'],
        }
      : fallbackBundle.websiteReview;

  let computerLab = record.computerLab;
  let computerLabSource = record.computerLabSource;
  let computerLabSourceUrl = record.computerLabSourceUrl;
  let computerLabCheckedAt = record.computerLabCheckedAt;
  let labComputersCount = record.labComputersCount;
  let labInternetAvailable = record.labInternetAvailable;
  let labVerificationNote = record.labVerificationNote;

  if (isEdu && record.computerLabSource !== 'VISIT') {
    const aiLab = normalizeLabStatus(aiData?.computerLab);
    const chosenLab = aiLab !== 'Unverified' ? aiLab : serpLabAnalysis?.computerLab || 'Unverified';
    if (chosenLab !== 'Unverified' || record.computerLab === 'Unverified') {
      computerLab = chosenLab;
      computerLabSource = serpItems.length > 0 ? 'SERPFORGE' : 'GOOGLE_SEARCH';
      computerLabSourceUrl = serpLabAnalysis?.sourceUrl || primarySourceUrl;
      computerLabCheckedAt = now;
      labComputersCount =
        typeof aiData?.labComputersCount === 'number'
          ? aiData.labComputersCount
          : serpLabAnalysis?.labComputersCount ?? labComputersCount;
      labInternetAvailable = aiData?.labInternetAvailable || serpLabAnalysis?.labInternetAvailable || labInternetAvailable;
      labVerificationNote = aiData?.labVerificationNote || serpLabAnalysis?.labVerificationNote || labVerificationNote;
    }
  }

  const updated: SchoolRecord = {
    ...record,
    industry,
    website: finalWebsite,
    address: finalAddress,
    contactPerson: record.contactPerson || aiData?.contactPerson?.trim() || serpContacts.contactPerson || undefined,
    contactPhone: finalPhone,
    contactPhoneSource: finalPhoneSource,
    contactPhoneSourceUrl: finalPhoneSourceUrl,
    contactEmail: finalEmail,
    contactEmailSource: finalEmailSource,
    computerLab,
    computerLabSource,
    computerLabSourceUrl,
    computerLabCheckedAt,
    labComputersCount,
    labInternetAvailable,
    labVerificationNote,
    analysisStatus: 'COMPLETED',
    analysisError: undefined,
    research,
    digitalAudit,
    websiteReview,
    industryAnalysis,
  };

  updated.serviceAssessment = computeServiceAssessment(updated);
  return updated;
}

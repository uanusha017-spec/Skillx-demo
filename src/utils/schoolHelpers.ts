import type { ComputerLabStatus, PriorityLevel, SchoolRecord } from '../types';

export function safeExternalUrl(raw?: string | null): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  try {
    const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const parsed = new URL(candidate);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.href;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function normalizeLabStatus(raw?: string | number | boolean | null): ComputerLabStatus {
  if (raw === undefined || raw === null || raw === '') return 'Unverified';
  const text = String(raw).trim().toLowerCase();
  if (/^(yes|y|true|available|present|existing|functional|active)$/i.test(text)) return 'Yes';
  if (/^(no|n|false|not available|unavailable|absent|none|nil|0)$/i.test(text)) return 'No';
  if (/^(?:yes|available|present)\b/i.test(text) && !/\b(not|no|planned|proposed|unavailable)\b/i.test(text)) {
    return 'Yes';
  }
  if (/^(?:not available|unavailable|absent)\b|^no\s*[(—-]/i.test(text)) return 'No';
  const num = Number(text);
  if (!Number.isNaN(num)) return num > 0 ? 'Yes' : 'No';
  return 'Unverified';
}

export function hasValidPhone(phone?: string | null): boolean {
  if (!phone) return false;
  const trimmed = phone.trim();
  if (!trimmed) return false;
  if (/^(n\/?a|nil|none|unknown|pending|not\s*available|-+|0+)$/i.test(trimmed)) return false;
  const digits = trimmed.replace(/\D/g, '');
  return digits.length >= 7;
}

export function normalizeArea(name: string, area?: string, city?: string): string {
  const cleanArea = (area || '').trim();
  if (cleanArea && !/^(unknown|unassigned|unassigned area|n\/?a|none)$/i.test(cleanArea)) return cleanArea;
  const cleanCity = (city || '').trim();
  if (cleanCity && !/^(unknown|unassigned|unassigned area|n\/?a|none)$/i.test(cleanCity)) return cleanCity;
  const parts = name.split(',');
  if (parts.length > 1) return parts[parts.length - 1].trim();
  return 'Unassigned Area';
}

export function formatLocation(name: string, area?: string, city?: string, state?: string): string {
  const tokens: string[] = [];
  const seen = new Set<string>();
  const primary = normalizeArea(name, area, city);
  for (const raw of [primary, city, state]) {
    const t = (raw || '').trim();
    if (!t) continue;
    const lower = t.toLowerCase();
    if (/^(unknown|unassigned|unassigned area|n\/?a|none)$/i.test(lower)) continue;
    if (seen.has(lower)) continue;
    if (tokens.some((existing) => existing.toLowerCase().includes(lower) || lower.includes(existing.toLowerCase()))) {
      continue;
    }
    seen.add(lower);
    tokens.push(t);
  }
  return tokens.length > 0 ? tokens.join(', ') : 'Unassigned Area';
}

export function isEducationRecord(record: SchoolRecord): boolean {
  if (record.recordType === 'SCHOOL') return true;
  if (record.recordType === 'BUSINESS') return false;
  const ind = (record.industry || '').trim();
  if (!ind) return true;
  return /education|school|college|university|academy|coaching|institute|vidyalaya|public school|high school/i.test(
    `${ind} ${record.name}`
  );
}

export function isBusinessRecord(record: SchoolRecord): boolean {
  if (record.recordType === 'BUSINESS') return true;
  if (record.recordType === 'SCHOOL') return false;
  return !isEducationRecord(record);
}

export function computePriority(record: Partial<SchoolRecord>): {
  priorityLevel: PriorityLevel;
  priorityScore: number;
  targetPriorityReason: string;
} {
  let score = 45;
  const reasons: string[] = [];

  const days = typeof record.daysSinceLastVisit === 'number' ? record.daysSinceLastVisit : 65;
  if (days >= 60) {
    score += 25;
    reasons.push(`Overdue visit (${days}d)`);
  } else if (days >= 30) {
    score += 15;
    reasons.push(`Due for follow-up (${days}d)`);
  } else if (days <= 14) {
    score -= 20;
    reasons.push(`Recently visited (${days}d ago)`);
  }

  if (record.computerLab === 'Yes') {
    score += 15;
    reasons.push('Confirmed computer lab ready for SkillX');
  } else if (record.computerLab === 'No') {
    score += 5;
    reasons.push('No lab yet — infrastructure pitch opportunity');
  } else {
    score += 8;
    reasons.push('Computer lab verification pending');
  }

  if ((record.studentEnrollment || 0) >= 500) {
    score += 12;
    reasons.push(`High enrollment (${record.studentEnrollment})`);
  } else if ((record.studentEnrollment || 0) >= 200) {
    score += 6;
  }

  if (hasValidPhone(record.contactPhone)) {
    score += 5;
  } else {
    reasons.push('Contact lookup needed');
  }

  const clamped = Math.max(10, Math.min(100, score));
  let priorityLevel: PriorityLevel = 'P3_MEDIUM';
  if (clamped >= 80) priorityLevel = 'P1_CRITICAL';
  else if (clamped >= 62) priorityLevel = 'P2_HIGH';
  else if (clamped >= 42) priorityLevel = 'P3_MEDIUM';
  else priorityLevel = 'P4_LOW';

  return {
    priorityLevel,
    priorityScore: clamped,
    targetPriorityReason: reasons.join(' · ') || 'Standard territory outreach target',
  };
}

export function formatIST(iso?: string): string {
  if (!iso) return 'Pending';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`;
}

export function createMapsUrl(name: string, area?: string, city?: string): string {
  const q = [name, area, city].filter(Boolean).join(' ');
  return `https://maps.google.com/?q=${encodeURIComponent(q)}`;
}

export function ensureUniqueRecordIds<T extends { id: string }>(
  records: T[]
): { items: T[]; changed: boolean } {
  const seen = new Set<string>();
  let changed = false;
  const items = records.map((record, idx) => {
    const baseId = (record.id || '').trim() || `rec-${idx}`;
    if (!seen.has(baseId)) {
      seen.add(baseId);
      if (baseId !== record.id) {
        changed = true;
        return { ...record, id: baseId };
      }
      return record;
    }
    changed = true;
    let suffix = 2;
    let candidate = `${baseId}-r${suffix}`;
    while (seen.has(candidate)) {
      suffix++;
      candidate = `${baseId}-r${suffix}`;
    }
    seen.add(candidate);
    return { ...record, id: candidate };
  });
  return { items, changed };
}

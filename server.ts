import 'dotenv/config';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import type {
  DPRReport,
  FieldReview,
  SchoolAutoVerifyStatus,
  SchoolRecord,
  UploadedFileRecord,
  UserRole,
  UserSession,
} from './src/types';
import {
  analyzeBusinessByIndustry,
  discoverBusinessesOnGoogle,
  enrichMissingContact,
  formatApiError,
  getSearchEngineStatus,
  inferDatasetRegionHint,
  verifySchoolComputerLab,
  verifySchoolComputerLabsBatch,
} from './server/researchEngine';
import {
  computePriority,
  ensureUniqueRecordIds,
  hasValidPhone,
  isEducationRecord,
  normalizeArea,
} from './src/utils/schoolHelpers';

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = path.resolve(process.cwd(), '.data');
const STORE_PATH = path.resolve(DATA_DIR, 'store.json');
const AUTH_PATH = path.resolve(DATA_DIR, 'auth.json');

// Fallback in-memory secret used only before initial workspace setup when no env override is set
const EPHEMERAL_FALLBACK_SECRET = crypto.randomBytes(32).toString('hex');
let cachedPersistentSecret: string | null = null;

const PORTAL_USERS: Record<string, UserSession> = {
  'superadmin@nattonskillx.in': {
    id: 'usr-super-01',
    name: 'Master Super Admin',
    email: 'superadmin@nattonskillx.in',
    role: 'SUPER_ADMIN',
    designation: 'Director of Operations',
    state: 'All States (National)',
  },
  'nattonskillxjunior@gmail.com': {
    id: 'usr-admin-01',
    name: 'Operations Lead (Admin)',
    email: 'nattonskillxjunior@gmail.com',
    role: 'ADMIN',
    designation: 'Territory Operations Admin',
    state: 'Karnataka',
  },
  'rohan.field@nattonskillx.in': {
    id: 'usr-field-01',
    name: 'Rohan Kulkarni',
    email: 'rohan.field@nattonskillx.in',
    role: 'USER',
    designation: 'Field Outreach Executive',
    state: 'Karnataka (Hubli-Dharwad)',
  },
};

interface PersistedStore {
  schools: SchoolRecord[];
  reports: DPRReport[];
  reviews: FieldReview[];
  uploads: UploadedFileRecord[];
  activeUploadId: string | null;
}

interface AuthConfigFile {
  passcodeSalt: string;
  passcodeHash: string;
  claimedAt: string;
  sessionSecret?: string;
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadStore(): PersistedStore {
  ensureDataDir();
  if (fs.existsSync(STORE_PATH)) {
    try {
      const raw = fs.readFileSync(STORE_PATH, 'utf8');
      const parsed = JSON.parse(raw) as Partial<PersistedStore>;
      const schoolsRaw = Array.isArray(parsed.schools) ? parsed.schools : [];
      const uploadsRaw = Array.isArray(parsed.uploads) ? parsed.uploads : [];
      const dedupedSchools = ensureUniqueRecordIds(schoolsRaw);
      let uploadsChanged = false;
      const cleanedUploads = uploadsRaw.map((u) => {
        if (!Array.isArray(u.records)) return u;
        const deduped = ensureUniqueRecordIds(u.records);
        if (deduped.changed) uploadsChanged = true;
        return deduped.changed ? { ...u, records: deduped.items } : u;
      });
      const loaded: PersistedStore = {
        schools: dedupedSchools.items,
        reports: Array.isArray(parsed.reports) ? parsed.reports : [],
        reviews: Array.isArray(parsed.reviews) ? parsed.reviews : [],
        uploads: cleanedUploads,
        activeUploadId: parsed.activeUploadId ?? null,
      };
      if (dedupedSchools.changed || uploadsChanged) {
        saveStore(loaded);
      }
      return loaded;
    } catch {
      // fall through to clean store
    }
  }
  return { schools: [], reports: [], reviews: [], uploads: [], activeUploadId: null };
}

function saveStore(data: PersistedStore) {
  ensureDataDir();
  fs.writeFileSync(STORE_PATH, JSON.stringify(data, null, 2), 'utf8');
}

function loadAuthFile(): AuthConfigFile | null {
  ensureDataDir();
  if (!fs.existsSync(AUTH_PATH)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(AUTH_PATH, 'utf8')) as AuthConfigFile;
    if (parsed.passcodeSalt && parsed.passcodeHash) return parsed;
    return null;
  } catch {
    return null;
  }
}

function hashPasscode(passcode: string, salt: string): string {
  return crypto.scryptSync(passcode, salt, 64).toString('hex');
}

function verifyPasscode(candidate: string): boolean {
  const envPasscode = process.env.PORTAL_ADMIN_PASSCODE?.trim();
  if (envPasscode) {
    const a = Buffer.from(candidate);
    const b = Buffer.from(envPasscode);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }
  const saved = loadAuthFile();
  if (!saved) return false;
  const computed = Buffer.from(hashPasscode(candidate, saved.passcodeSalt), 'hex');
  const stored = Buffer.from(saved.passcodeHash, 'hex');
  if (computed.length !== stored.length) return false;
  return crypto.timingSafeEqual(computed, stored);
}

function isPasscodeConfigured(): boolean {
  return Boolean(process.env.PORTAL_ADMIN_PASSCODE?.trim() || loadAuthFile());
}

function getSessionSecret(): string {
  const envSecret = process.env.SESSION_SECRET?.trim();
  if (envSecret) return envSecret;
  if (cachedPersistentSecret) return cachedPersistentSecret;

  const saved = loadAuthFile();
  if (saved) {
    if (saved.sessionSecret) {
      cachedPersistentSecret = saved.sessionSecret;
      return cachedPersistentSecret;
    }
    const derived = crypto
      .createHash('sha256')
      .update(`${saved.passcodeSalt}:${saved.passcodeHash}:natton-session-v1`)
      .digest('hex');
    cachedPersistentSecret = derived;
    try {
      fs.writeFileSync(AUTH_PATH, JSON.stringify({ ...saved, sessionSecret: derived }, null, 2), 'utf8');
    } catch {
      // ignore write failure, derived secret remains stable across restarts
    }
    return derived;
  }

  const envPass = process.env.PORTAL_ADMIN_PASSCODE?.trim();
  if (envPass) {
    cachedPersistentSecret = crypto
      .createHash('sha256')
      .update(`${envPass}:natton-env-session-v1`)
      .digest('hex');
    return cachedPersistentSecret;
  }

  return EPHEMERAL_FALLBACK_SECRET;
}

function signSessionToken(user: UserSession): string {
  const payload = Buffer.from(
    JSON.stringify({
      user,
      exp: Date.now() + 1000 * 60 * 60 * 24 * 7, // 7 days
    })
  ).toString('base64url');
  const sig = crypto.createHmac('sha256', getSessionSecret()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifySessionToken(token: string): UserSession | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const expectedSig = crypto.createHmac('sha256', getSessionSecret()).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      user?: UserSession;
      exp?: number;
    };
    if (!decoded.user || !decoded.exp || decoded.exp < Date.now()) return null;
    return decoded.user;
  } catch {
    return null;
  }
}

let store = loadStore();

// Active background analysis tracking to avoid duplicate concurrent work per record
const inFlightAnalyses = new Map<string, Promise<SchoolRecord | null>>();

async function runAnalysisForRecord(
  recordId: string,
  overrideWebsite?: string,
  businessOnly = false
): Promise<SchoolRecord | null> {
  const existing = store.schools.find((s) => s.id === recordId);
  if (!existing) return null;
  const pending = inFlightAnalyses.get(recordId);
  if (pending) return pending;

  const task = (async (): Promise<SchoolRecord | null> => {
    try {
      const checking: SchoolRecord = { ...existing, analysisStatus: 'CHECKING', analysisError: undefined };
      store.schools = store.schools.map((s) => (s.id === recordId ? checking : s));
      saveStore(store);

      const enriched = await analyzeBusinessByIndustry(checking, overrideWebsite, {
        businessOnly: businessOnly || existing.recordType === 'BUSINESS',
      });
      const priority = computePriority(enriched);
      const finalized: SchoolRecord = { ...enriched, ...priority };

      // Guard against record being deleted while analysis was in flight
      if (!store.schools.some((s) => s.id === recordId)) return finalized;
      store.schools = store.schools.map((s) => (s.id === recordId ? finalized : s));
      store.uploads = store.uploads.map((u) => ({
        ...u,
        records: u.records.map((r) => (r.id === recordId ? finalized : r)),
      }));
      saveStore(store);
      return finalized;
    } catch (err) {
      const formatted = formatApiError(err);
      const failed: SchoolRecord = {
        ...existing,
        analysisStatus: 'FAILED',
        analysisError: formatted.message,
      };
      if (store.schools.some((s) => s.id === recordId)) {
        store.schools = store.schools.map((s) => (s.id === recordId ? failed : s));
        saveStore(store);
      }
      return failed;
    } finally {
      inFlightAnalyses.delete(recordId);
    }
  })();

  inFlightAnalyses.set(recordId, task);
  return task;
}

// Background sequential queue for newly discovered businesses
const backgroundQueue: string[] = [];
let queueRunning = false;

function enqueueAnalysis(ids: string[]) {
  for (const id of ids) {
    if (!backgroundQueue.includes(id) && !inFlightAnalyses.has(id)) {
      backgroundQueue.push(id);
    }
  }
  if (!queueRunning) {
    void processBackgroundQueue();
  }
}

async function processBackgroundQueue() {
  queueRunning = true;
  try {
    while (backgroundQueue.length > 0) {
      const nextId = backgroundQueue.shift();
      if (!nextId) break;
      const result = await runAnalysisForRecord(nextId);
      if (result?.analysisError && /rate limit/i.test(result.analysisError)) {
        break;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  } finally {
    queueRunning = false;
  }
}

// =========================================================================
// AUTOMATIC BACKGROUND SCHOOL COMPUTER LAB + MISSING PHONE VERIFIER
// Runs automatically on server startup & whenever schools are uploaded/saved
// so the user never has to manually click a button to start verification!
// =========================================================================
let schoolAutoRunning = false;
let schoolAutoPausedByUser = false;
let schoolAutoStopRequested = false;
let schoolAutoMode: 'LAB_AND_PHONE' | 'MISSING_PHONE_ONLY' = 'LAB_AND_PHONE';
let schoolAutoPhonesFetched = 0;
let schoolAutoMessage = '';
let schoolAutoLastError = '';
let schoolAutoStatus: SchoolAutoVerifyStatus['status'] = 'IDLE';

function getSchoolAutoVerifyStatus(): SchoolAutoVerifyStatus {
  const eduSchools = store.schools.filter((s) => isEducationRecord(s));
  const confirmedYes = eduSchools.filter((s) => s.computerLab === 'Yes').length;
  const confirmedNo = eduSchools.filter((s) => s.computerLab === 'No').length;
  const unverifiedCount = eduSchools.filter((s) => s.computerLab === 'Unverified').length;
  const missingPhoneCount = eduSchools.filter((s) => !hasValidPhone(s.contactPhone)).length;
  const checked = eduSchools.filter((s) => s.computerLab !== 'Unverified' || Boolean(s.computerLabCheckedAt)).length;
  return {
    status: schoolAutoRunning ? 'RUNNING' : schoolAutoStatus,
    mode: schoolAutoMode,
    total: eduSchools.length,
    checked,
    confirmedYes,
    confirmedNo,
    unverifiedCount,
    missingPhoneCount,
    phonesFetched: schoolAutoPhonesFetched,
    message:
      schoolAutoMessage ||
      (eduSchools.length === 0
        ? 'Upload an Excel sheet to automatically verify Computer Labs & fetch missing phones.'
        : unverifiedCount === 0
        ? `All ${eduSchools.length} school(s) automatically verified · ${confirmedYes} Lab Yes · ${confirmedNo} Lab No.`
        : `Ready · ${unverifiedCount} school(s) queued for automatic Computer Lab & phone verification.`),
    lastError: schoolAutoLastError || undefined,
  };
}

function triggerAutomaticSchoolVerification(
  mode: 'LAB_AND_PHONE' | 'MISSING_PHONE_ONLY' = 'LAB_AND_PHONE',
  force = false
) {
  if (schoolAutoPausedByUser && !force) return;
  if (force) {
    schoolAutoPausedByUser = false;
    schoolAutoStopRequested = false;
  }
  schoolAutoMode = mode;
  if (schoolAutoRunning) return;
  const eduSchools = store.schools.filter((s) => isEducationRecord(s));
  const hasPending =
    mode === 'MISSING_PHONE_ONLY'
      ? eduSchools.some((s) => !hasValidPhone(s.contactPhone))
      : eduSchools.some((s) => s.computerLab === 'Unverified' || (!hasValidPhone(s.contactPhone) && !s.computerLabCheckedAt));
  if (!hasPending) {
    if (eduSchools.length > 0) {
      schoolAutoStatus = 'COMPLETE';
      schoolAutoMessage = `All ${eduSchools.length} school(s) verified automatically.`;
    }
    return;
  }
  void runSchoolAutoVerifyLoop();
}

async function runSchoolAutoVerifyLoop() {
  if (schoolAutoRunning) return;
  schoolAutoRunning = true;
  schoolAutoStatus = 'RUNNING';
  schoolAutoLastError = '';
  const BATCH_SIZE = 10;
  let consecutiveFailures = 0;
  const attemptedThisRun = new Set<string>();

  try {
    while (!schoolAutoStopRequested && !schoolAutoPausedByUser) {
      const eduSchools = store.schools.filter((s) => isEducationRecord(s));
      const pending = eduSchools.filter((s) => {
        if (attemptedThisRun.has(s.id)) return false;
        if (schoolAutoMode === 'MISSING_PHONE_ONLY') {
          return !hasValidPhone(s.contactPhone);
        }
        return s.computerLab === 'Unverified' || (!hasValidPhone(s.contactPhone) && !s.computerLabCheckedAt);
      });

      if (pending.length === 0) {
        schoolAutoStatus = 'COMPLETE';
        const stats = getSchoolAutoVerifyStatus();
        schoolAutoMessage = `Automatic verification complete · ${stats.confirmedYes} Lab Yes · ${stats.confirmedNo} Lab No · ${schoolAutoPhonesFetched} phone(s) fetched.`;
        break;
      }

      const batch = pending.slice(0, BATCH_SIZE);
      const preview = batch.slice(0, 2).map((b) => b.name).join(', ');
      const doneSoFar = eduSchools.length - pending.length;
      schoolAutoMessage = `Auto-verifying Computer Labs & phones (${doneSoFar + 1}–${Math.min(eduSchools.length, doneSoFar + batch.length)}/${eduSchools.length}): ${preview}${batch.length > 2 ? ` +${batch.length - 2} more` : ''}`;

      try {
        const regionHint = inferDatasetRegionHint(store.schools);
        const results = await verifySchoolComputerLabsBatch(
          batch.map((s) => ({
            schoolId: s.id,
            schoolName: s.name,
            websiteUrl: s.website || '',
            city: s.city || '',
            area: s.area || '',
            state: s.state || '',
            board: s.board || '',
            existingPhone: s.contactPhone || '',
            existingEmail: s.contactEmail || '',
          })),
          regionHint
        );

        consecutiveFailures = 0;
        schoolAutoLastError = '';
        let storeChanged = false;
        const mergedById = new Map<string, SchoolRecord>();

        for (const item of batch) {
          attemptedThisRun.add(item.id);
          const result = results[item.id];
          if (!result) continue;
          const idx = store.schools.findIndex((s) => s.id === item.id);
          if (idx === -1) continue;
          const current = store.schools[idx];
          const hadPhone = hasValidPhone(current.contactPhone);
          const nextPhone = hadPhone ? current.contactPhone : result.contactPhone;
          if (!hadPhone && hasValidPhone(nextPhone)) {
            schoolAutoPhonesFetched++;
          }
          const updated: SchoolRecord = {
            ...current,
            computerLab: result.computerLab,
            computerLabSource: result.computerLabSource,
            computerLabSourceUrl: result.computerLabSourceUrl || current.computerLabSourceUrl,
            computerLabCheckedAt: result.computerLabCheckedAt,
            labComputersCount: result.labComputersCount,
            labInternetAvailable: result.labInternetAvailable,
            labConfidence: result.labConfidence,
            labVerificationNote: result.labVerificationNote,
            website: current.website || result.website,
            address: current.address || result.address,
            contactPerson: current.contactPerson || result.contactPerson,
            contactPhone: nextPhone,
            contactPhoneSource: hadPhone
              ? current.contactPhoneSource || 'Uploaded Excel'
              : result.contactPhoneSource,
            contactPhoneSourceUrl: hadPhone ? current.contactPhoneSourceUrl : result.contactPhoneSourceUrl,
            contactEmail: current.contactEmail || result.contactEmail,
            contactEmailSource: current.contactEmail ? current.contactEmailSource || 'Uploaded Excel' : result.contactEmailSource,
          };
          const merged = { ...updated, ...computePriority(updated) };
          store.schools[idx] = merged;
          mergedById.set(item.id, merged);
          storeChanged = true;
        }

        if (storeChanged) {
          store.uploads = store.uploads.map((u) => ({
            ...u,
            records: u.records.map((r) => mergedById.get(r.id) || r),
          }));
          saveStore(store);
        }

        await new Promise((r) => setTimeout(r, 300));
      } catch (err) {
        const formatted = formatApiError(err);
        schoolAutoLastError = formatted.message;
        consecutiveFailures++;
        const waitMs = formatted.status === 429 ? 15000 : 4000;
        if (consecutiveFailures >= 4) {
          // Mark this batch attempted so we don't spin forever on a single bad batch, then keep going
          for (const item of batch) attemptedThisRun.add(item.id);
          consecutiveFailures = 0;
        }
        schoolAutoMessage = `Search engine busy — auto-retrying in ${Math.round(waitMs / 1000)}s...`;
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }

    if (schoolAutoPausedByUser) {
      schoolAutoStatus = 'PAUSED';
      schoolAutoMessage = 'Automatic verification paused by user.';
    } else if (schoolAutoStopRequested) {
      schoolAutoStatus = 'IDLE';
      schoolAutoMessage = 'Automatic verification stopped by user.';
    }
  } finally {
    schoolAutoRunning = false;
  }
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '25mb' }));

  const requireAuth: express.RequestHandler = (req, res, next) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const user = token ? verifySessionToken(token) : null;
    if (!user) {
      res.status(401).json({ error: 'Authentication required. Please sign in.' });
      return;
    }
    (req as express.Request & { user?: UserSession }).user = user;
    next();
  };

  // Health check
  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      service: 'Campus Lab Finder - Natton SkillX Junior',
      search: getSearchEngineStatus(),
      passcodeConfigured: isPasscodeConfigured(),
      recordsCount: store.schools.length,
    });
  });

  // Auth status (whether first-run passcode setup is needed)
  app.get('/api/auth/status', (_req, res) => {
    res.json({
      configured: isPasscodeConfigured(),
      envOverride: Boolean(process.env.PORTAL_ADMIN_PASSCODE?.trim()),
    });
  });

  // First-run workspace passcode claim (locks immediately once claimed or when env secret is set)
  app.post('/api/auth/setup', (req, res) => {
    if (isPasscodeConfigured()) {
      res.status(409).json({ error: 'Workspace passcode is already configured. Please sign in.' });
      return;
    }
    const { email, password } = req.body || {};
    const cleanEmail = String(email || '').trim().toLowerCase();
    const cleanPass = String(password || '').trim();
    if (cleanPass.length < 4) {
      res.status(400).json({ error: 'Choose a workspace passcode of at least 4 characters.' });
      return;
    }
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = hashPasscode(cleanPass, salt);
    const sessionSecret = crypto.randomBytes(32).toString('hex');
    cachedPersistentSecret = sessionSecret;
    ensureDataDir();
    fs.writeFileSync(
      AUTH_PATH,
      JSON.stringify(
        { passcodeSalt: salt, passcodeHash: hash, sessionSecret, claimedAt: new Date().toISOString() },
        null,
        2
      ),
      'utf8'
    );

    const user: UserSession =
      PORTAL_USERS[cleanEmail] || {
        id: `usr-${crypto.randomBytes(4).toString('hex')}`,
        name: cleanEmail.split('@')[0] || 'Field Executive',
        email: cleanEmail || 'rohan.field@nattonskillx.in',
        role: 'USER' as UserRole,
        designation: 'Field Outreach Executive',
        state: 'Karnataka',
      };
    const accessToken = signSessionToken(user);
    res.json({ user, accessToken });
  });

  // Role portal login
  app.post('/api/auth/login', (req, res) => {
    const { email, password } = req.body || {};
    const cleanEmail = String(email || '').trim().toLowerCase();
    const cleanPass = String(password || '').trim();

    if (!cleanEmail || !cleanPass) {
      res.status(400).json({ error: 'Email and passcode are required.' });
      return;
    }
    if (!isPasscodeConfigured()) {
      res.status(409).json({
        error: 'No workspace passcode has been set yet. Complete first-run setup to activate portals.',
        needsSetup: true,
      });
      return;
    }
    if (!verifyPasscode(cleanPass)) {
      res.status(401).json({ error: 'Invalid passcode. Please check your workspace passcode and retry.' });
      return;
    }

    const user: UserSession =
      PORTAL_USERS[cleanEmail] || {
        id: `usr-${crypto.createHash('sha256').update(cleanEmail).digest('hex').slice(0, 8)}`,
        name: cleanEmail.split('@')[0] || 'Field Executive',
        email: cleanEmail,
        role: cleanEmail.includes('superadmin')
          ? 'SUPER_ADMIN'
          : cleanEmail.includes('admin') || cleanEmail.includes('nattonskillxjunior')
          ? 'ADMIN'
          : 'USER',
        designation: 'Team Member',
        state: 'Karnataka',
      };
    const accessToken = signSessionToken(user);
    res.json({ user, accessToken });
  });

  app.post('/api/auth/logout', (_req, res) => {
    res.json({ ok: true });
  });

  // Research engine status (read-only, never exposes secrets)
  app.get('/api/research/status', requireAuth, (_req, res) => {
    res.json(getSearchEngineStatus());
  });

  // Persistent store read/write
  app.get('/api/store', requireAuth, (_req, res) => {
    res.json({ success: true, data: store });
  });

  app.post('/api/store', requireAuth, (req, res) => {
    const body = req.body || {};
    if (Array.isArray(body.schools)) {
      store.schools = ensureUniqueRecordIds<SchoolRecord>(body.schools.slice(0, 5000)).items;
    }
    if (Array.isArray(body.reports)) store.reports = body.reports.slice(0, 2000);
    if (Array.isArray(body.reviews)) store.reviews = body.reviews.slice(0, 2000);
    if (Array.isArray(body.uploads)) {
      store.uploads = body.uploads.slice(0, 100).map((u: UploadedFileRecord) =>
        Array.isArray(u.records) ? { ...u, records: ensureUniqueRecordIds(u.records).items } : u
      );
    }
    if (body.activeUploadId !== undefined) store.activeUploadId = body.activeUploadId;
    saveStore(store);
    // Automatically start Computer Lab + Missing Phone verification for any newly saved/unverified schools
    triggerAutomaticSchoolVerification('LAB_AND_PHONE', false);
    res.json({ success: true, count: store.schools.length });
  });

  // Live status & control for automatic background School Lab + Missing Phone verification
  app.get('/api/school-verify/status', requireAuth, (_req, res) => {
    // Auto-kick if unverified schools exist and user hasn't paused/stopped
    if (!schoolAutoRunning && !schoolAutoPausedByUser && !schoolAutoStopRequested) {
      triggerAutomaticSchoolVerification('LAB_AND_PHONE', false);
    }
    res.json({ success: true, status: getSchoolAutoVerifyStatus() });
  });

  app.post('/api/school-verify/control', requireAuth, (req, res) => {
    const action = String(req.body?.action || '').toLowerCase();
    if (action === 'pause') {
      schoolAutoPausedByUser = true;
      schoolAutoStatus = 'PAUSED';
      schoolAutoMessage = 'Automatic verification paused by user.';
    } else if (action === 'stop') {
      schoolAutoStopRequested = true;
      schoolAutoPausedByUser = true;
      schoolAutoStatus = 'IDLE';
      schoolAutoMessage = 'Automatic verification stopped by user.';
    } else if (action === 'resume' || action === 'start') {
      triggerAutomaticSchoolVerification('LAB_AND_PHONE', true);
    } else if (action === 'fetch-missing-phones') {
      triggerAutomaticSchoolVerification('MISSING_PHONE_ONLY', true);
    }
    res.json({ success: true, status: getSchoolAutoVerifyStatus() });
  });

  app.post('/api/store/clear', requireAuth, (_req, res) => {
    store.schools = [];
    store.uploads = [];
    store.activeUploadId = null;
    saveStore(store);
    res.json({ success: true });
  });

  // Delete a single school or business record permanently
  app.delete('/api/records/:id', requireAuth, (req, res) => {
    const id = String(req.params.id || '').trim();
    if (!id) {
      res.status(400).json({ error: 'Record ID is required.' });
      return;
    }
    const before = store.schools.length;
    store.schools = store.schools.filter((s) => s.id !== id);
    store.uploads = store.uploads
      .map((u) => {
        const nextRecords = u.records.filter((r) => r.id !== id);
        return { ...u, records: nextRecords, recordsCount: nextRecords.length };
      })
      .filter((u) => u.records.length > 0);
    if (store.activeUploadId && !store.uploads.some((u) => u.id === store.activeUploadId)) {
      store.activeUploadId = store.uploads[0]?.id ?? null;
    }
    saveStore(store);
    res.json({
      success: true,
      deletedId: id,
      deletedCount: before - store.schools.length,
      remainingCount: store.schools.length,
    });
  });

  // Delete multiple school or business records by ID list permanently
  app.delete('/api/records', requireAuth, (req, res) => {
    const rawIds = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const idSet = new Set(
      rawIds
        .filter((x: unknown): x is string => typeof x === 'string' && x.trim().length > 0)
        .map((x: string) => x.trim())
    );
    if (idSet.size === 0) {
      res.status(400).json({ error: 'At least one record ID is required.' });
      return;
    }
    const before = store.schools.length;
    store.schools = store.schools.filter((s) => !idSet.has(s.id));
    store.uploads = store.uploads
      .map((u) => {
        const nextRecords = u.records.filter((r) => !idSet.has(r.id));
        return { ...u, records: nextRecords, recordsCount: nextRecords.length };
      })
      .filter((u) => u.records.length > 0);
    if (store.activeUploadId && !store.uploads.some((u) => u.id === store.activeUploadId)) {
      store.activeUploadId = store.uploads[0]?.id ?? null;
    }
    saveStore(store);
    res.json({
      success: true,
      deletedCount: before - store.schools.length,
      remainingCount: store.schools.length,
    });
  });

  // Delete an uploaded file batch and its exclusive records permanently
  app.delete('/api/uploads/:id', requireAuth, (req, res) => {
    const uploadId = String(req.params.id || '').trim();
    const target = store.uploads.find((u) => u.id === uploadId);
    if (!target) {
      res.status(404).json({ error: 'Upload batch not found.' });
      return;
    }
    const remainingUploads = store.uploads.filter((u) => u.id !== uploadId);
    const keptUploadRecordIds = new Set(
      remainingUploads.flatMap((u) => u.records.map((r) => r.id))
    );
    const removeIds = new Set(
      target.records.map((r) => r.id).filter((id) => !keptUploadRecordIds.has(id))
    );
    const before = store.schools.length;
    store.schools = store.schools.filter((s) => !removeIds.has(s.id));
    store.uploads = remainingUploads;
    if (store.activeUploadId === uploadId) {
      store.activeUploadId = remainingUploads[0]?.id ?? null;
    }
    saveStore(store);
    res.json({
      success: true,
      deletedUploadId: uploadId,
      deletedCount: before - store.schools.length,
      remainingCount: store.schools.length,
    });
  });

  // Verify School Computer Lab + Auto-fetch missing phone/contact from Google
  app.post('/api/verify-lab', requireAuth, async (req, res) => {
    try {
      const { schoolId, schoolName, websiteUrl, city, area, state, board, existingPhone, existingEmail } = req.body || {};
      if (!schoolName || typeof schoolName !== 'string') {
        res.status(400).json({ error: 'schoolName is required.' });
        return;
      }

      const regionHint = inferDatasetRegionHint(store.schools);
      const result = await verifySchoolComputerLab({
        schoolName: schoolName.trim(),
        websiteUrl,
        city,
        area,
        state,
        board,
        existingPhone,
        existingEmail,
        regionHint,
      });

      if (schoolId) {
        const idx = store.schools.findIndex((s) => s.id === schoolId);
        if (idx !== -1) {
          const current = store.schools[idx];
          const updated: SchoolRecord = {
            ...current,
            computerLab: result.computerLab,
            computerLabSource: result.computerLabSource,
            computerLabSourceUrl: result.computerLabSourceUrl || current.computerLabSourceUrl,
            computerLabCheckedAt: result.computerLabCheckedAt,
            labComputersCount: result.labComputersCount,
            labInternetAvailable: result.labInternetAvailable,
            labConfidence: result.labConfidence,
            labVerificationNote: result.labVerificationNote,
            website: current.website || result.website,
            address: current.address || result.address,
            contactPerson: current.contactPerson || result.contactPerson,
            contactPhone: hasValidPhone(current.contactPhone) ? current.contactPhone : result.contactPhone,
            contactPhoneSource: hasValidPhone(current.contactPhone)
              ? current.contactPhoneSource || 'Uploaded Excel'
              : result.contactPhoneSource,
            contactPhoneSourceUrl: hasValidPhone(current.contactPhone)
              ? current.contactPhoneSourceUrl
              : result.contactPhoneSourceUrl,
            contactEmail: current.contactEmail || result.contactEmail,
            contactEmailSource: current.contactEmail ? current.contactEmailSource || 'Uploaded Excel' : result.contactEmailSource,
          };
          const priority = computePriority(updated);
          const merged = { ...updated, ...priority };
          store.schools[idx] = merged;
          store.uploads = store.uploads.map((u) => ({
            ...u,
            records: u.records.map((r) => (r.id === schoolId ? merged : r)),
          }));
          saveStore(store);
        }
      }

      res.json({ success: true, result });
    } catch (err) {
      const formatted = formatApiError(err);
      res.status(formatted.status).json({
        error: formatted.message,
        code: formatted.code,
        retryAfterSeconds: formatted.retryAfterSeconds,
      });
    }
  });

  // Batch verify up to 10 schools per request (10x faster, much lower RPM usage)
  app.post('/api/verify-labs-batch', requireAuth, async (req, res) => {
    try {
      const rawList = Array.isArray(req.body?.schools) ? req.body.schools : [];
      const items = rawList
        .slice(0, 10)
        .filter((s: unknown): s is Record<string, unknown> => Boolean(s && typeof s === 'object'))
        .map((s: Record<string, unknown>) => ({
          schoolId: String(s.schoolId || '').trim(),
          schoolName: String(s.schoolName || '').trim(),
          websiteUrl: typeof s.websiteUrl === 'string' ? s.websiteUrl : undefined,
          city: typeof s.city === 'string' ? s.city : undefined,
          area: typeof s.area === 'string' ? s.area : undefined,
          state: typeof s.state === 'string' ? s.state : undefined,
          board: typeof s.board === 'string' ? s.board : undefined,
          existingPhone: typeof s.existingPhone === 'string' ? s.existingPhone : undefined,
          existingEmail: typeof s.existingEmail === 'string' ? s.existingEmail : undefined,
        }))
        .filter((s: { schoolId: string; schoolName: string }) => Boolean(s.schoolId && s.schoolName));

      if (items.length === 0) {
        res.status(400).json({ error: 'At least one school with schoolId and schoolName is required.' });
        return;
      }

      const regionHint = inferDatasetRegionHint(store.schools);
      const results = await verifySchoolComputerLabsBatch(items, regionHint);

      let storeChanged = false;
      const mergedById = new Map<string, SchoolRecord>();
      for (const [schoolId, result] of Object.entries(results)) {
        const idx = store.schools.findIndex((s) => s.id === schoolId);
        if (idx === -1) continue;
        const current = store.schools[idx];
        const updated: SchoolRecord = {
          ...current,
          computerLab: result.computerLab,
          computerLabSource: result.computerLabSource,
          computerLabSourceUrl: result.computerLabSourceUrl || current.computerLabSourceUrl,
          computerLabCheckedAt: result.computerLabCheckedAt,
          labComputersCount: result.labComputersCount,
          labInternetAvailable: result.labInternetAvailable,
          labConfidence: result.labConfidence,
          labVerificationNote: result.labVerificationNote,
          website: current.website || result.website,
          address: current.address || result.address,
          contactPerson: current.contactPerson || result.contactPerson,
          contactPhone: hasValidPhone(current.contactPhone) ? current.contactPhone : result.contactPhone,
          contactPhoneSource: hasValidPhone(current.contactPhone)
            ? current.contactPhoneSource || 'Uploaded Excel'
            : result.contactPhoneSource,
          contactPhoneSourceUrl: hasValidPhone(current.contactPhone)
            ? current.contactPhoneSourceUrl
            : result.contactPhoneSourceUrl,
          contactEmail: current.contactEmail || result.contactEmail,
          contactEmailSource: current.contactEmail ? current.contactEmailSource || 'Uploaded Excel' : result.contactEmailSource,
        };
        const priority = computePriority(updated);
        const merged = { ...updated, ...priority };
        store.schools[idx] = merged;
        mergedById.set(schoolId, merged);
        storeChanged = true;
      }

      if (storeChanged) {
        store.uploads = store.uploads.map((u) => ({
          ...u,
          records: u.records.map((r) => mergedById.get(r.id) || r),
        }));
        saveStore(store);
      }

      res.json({ success: true, results });
    } catch (err) {
      const formatted = formatApiError(err);
      res.status(formatted.status).json({
        error: formatted.message,
        code: formatted.code,
        retryAfterSeconds: formatted.retryAfterSeconds,
      });
    }
  });

  // Dedicated Google Contact Number Enrichment for Excel rows missing phone/email
  app.post('/api/enrich-contact', requireAuth, async (req, res) => {
    try {
      const { recordId, name, industry, area, city, state, website, existingPhone, existingEmail } = req.body || {};
      if (!name || typeof name !== 'string') {
        res.status(400).json({ error: 'name is required.' });
        return;
      }

      const regionHint = inferDatasetRegionHint(store.schools);
      const result = await enrichMissingContact({
        name: name.trim(),
        industry,
        area,
        city,
        state,
        website,
        existingPhone,
        existingEmail,
        regionHint,
      });

      if (recordId) {
        const idx = store.schools.findIndex((s) => s.id === recordId);
        if (idx !== -1) {
          const current = store.schools[idx];
          const updated: SchoolRecord = {
            ...current,
            contactPhone: hasValidPhone(current.contactPhone) ? current.contactPhone : result.contactPhone,
            contactPhoneSource: hasValidPhone(current.contactPhone)
              ? current.contactPhoneSource || 'Uploaded Excel'
              : result.contactPhoneSource,
            contactPhoneSourceUrl: hasValidPhone(current.contactPhone)
              ? current.contactPhoneSourceUrl
              : result.contactPhoneSourceUrl,
            contactEmail: current.contactEmail || result.contactEmail,
            contactEmailSource: current.contactEmail ? current.contactEmailSource || 'Uploaded Excel' : result.contactEmailSource,
            website: current.website || result.website,
            address: current.address || result.address,
            contactPerson: current.contactPerson || result.contactPerson,
          };
          store.schools[idx] = updated;
          saveStore(store);
        }
      }

      res.json({ success: true, result });
    } catch (err) {
      const formatted = formatApiError(err);
      res.status(formatted.status).json({
        error: formatted.message,
        code: formatted.code,
        retryAfterSeconds: formatted.retryAfterSeconds,
      });
    }
  });

  // Discover real businesses on Google by industry + location
  app.post('/api/discover', requireAuth, async (req, res) => {
    try {
      const { industry, location, serviceId } = req.body || {};
      const cleanIndustry = String(industry || '').trim();
      const cleanLocation = String(location || '').trim();
      if (!cleanIndustry || !cleanLocation) {
        res.status(400).json({ error: 'Industry and location are required.' });
        return;
      }

      const status = getSearchEngineStatus();
      if (!status.ready) {
        res.status(503).json({
          code: 'SEARCH_NOT_CONFIGURED',
          error: 'Google Search AI is not configured. Please check GEMINI_API_KEY in Settings > Secrets.',
        });
        return;
      }

      const discovered = await discoverBusinessesOnGoogle({
        industry: cleanIndustry,
        location: cleanLocation,
        serviceId: typeof serviceId === 'string' ? serviceId : 'ALL',
      });

      const existingKeys = new Set(
        store.schools.map((s) => `${s.name.toLowerCase().trim()}::${(s.city || '').toLowerCase().trim()}`)
      );

      let added = 0;
      const savedRecords: SchoolRecord[] = [];
      const toAnalyze: string[] = [];

      for (const rec of discovered) {
        const key = `${rec.name.toLowerCase().trim()}::${(rec.city || '').toLowerCase().trim()}`;
        if (!existingKeys.has(key)) {
          existingKeys.add(key);
          store.schools.unshift(rec);
          savedRecords.push(rec);
          toAnalyze.push(rec.id);
          added++;
        } else {
          const match = store.schools.find(
            (s) => `${s.name.toLowerCase().trim()}::${(s.city || '').toLowerCase().trim()}` === key
          );
          if (match) savedRecords.push(match);
        }
      }

      saveStore(store);
      if (toAnalyze.length > 0) {
        enqueueAnalysis(toAnalyze);
      }

      res.json({
        success: true,
        added,
        records: savedRecords,
      });
    } catch (err) {
      const formatted = formatApiError(err);
      res.status(formatted.status).json({
        error: formatted.message,
        code: formatted.code,
        retryAfterSeconds: formatted.retryAfterSeconds,
      });
    }
  });

  // Run industry-specific business analysis + contact fetch for a specific record
  app.post('/api/analyze/:id', requireAuth, async (req, res) => {
    try {
      const recordId = req.params.id;
      const { website, immediate, businessOnly } = req.body || {};
      const exists = store.schools.find((s) => s.id === recordId);
      if (!exists) {
        res.status(404).json({ error: 'Record not found on server. Save or sync records first.' });
        return;
      }

      if (immediate !== false) {
        const updated = await runAnalysisForRecord(
          recordId,
          typeof website === 'string' ? website : undefined,
          Boolean(businessOnly)
        );
        res.json({ success: true, record: updated });
      } else {
        enqueueAnalysis([recordId]);
        res.json({ success: true, queued: true });
      }
    } catch (err) {
      const formatted = formatApiError(err);
      res.status(formatted.status).json({
        error: formatted.message,
        code: formatted.code,
        retryAfterSeconds: formatted.retryAfterSeconds,
      });
    }
  });

  // 9am to 3pm Field Visit Roadmap Schedule generator
  app.post('/api/roadmap-schedule', requireAuth, (req, res) => {
    const { schoolsPerDay = 4, startDate, scope = 'SCHOOLS' } = req.body || {};
    const perDay = Math.max(1, Math.min(10, Number(schoolsPerDay) || 4));
    const slots = ['09:00 AM', '10:30 AM', '12:00 PM', '01:30 PM', '02:30 PM'];

    const baseList =
      scope === 'ALL'
        ? store.schools
        : store.schools.filter((s) => isEducationRecord(s));

    const sorted = [...baseList].sort((a, b) => {
      const areaCmp = normalizeArea(a.name, a.area, a.city).localeCompare(normalizeArea(b.name, b.area, b.city));
      if (areaCmp !== 0) return areaCmp;
      return (b.priorityScore || 0) - (a.priorityScore || 0);
    });

    const baseDate = startDate ? new Date(startDate) : new Date();
    const days: Array<{
      dayNumber: number;
      date: string;
      areaCluster: string;
      visits: Array<{
        slot: string;
        schoolId: string;
        schoolName: string;
        area: string;
        priorityLevel: string;
        computerLab: string;
        contactPhone: string;
      }>;
    }> = [];

    let cursor = new Date(baseDate);
    for (let i = 0; i < sorted.length; i += perDay) {
      // Skip Sundays
      if (cursor.getDay() === 0) {
        cursor.setDate(cursor.getDate() + 1);
      }
      const chunk = sorted.slice(i, i + perDay);
      const areaCluster = normalizeArea(chunk[0].name, chunk[0].area, chunk[0].city);
      days.push({
        dayNumber: days.length + 1,
        date: cursor.toISOString().slice(0, 10),
        areaCluster,
        visits: chunk.map((s, idx) => ({
          slot: slots[idx % slots.length],
          schoolId: s.id,
          schoolName: s.name,
          area: normalizeArea(s.name, s.area, s.city),
          priorityLevel: s.priorityLevel,
          computerLab: s.computerLab || 'Unverified',
          contactPhone: s.contactPhone || 'Needs Google Lookup',
        })),
      });
      cursor = new Date(cursor.getTime() + 86400000);
    }

    res.json({ success: true, totalSchools: sorted.length, totalDays: days.length, days });
  });

  // Vite dev middleware or static dist
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Campus Lab Finder server running at http://0.0.0.0:${PORT}`);
    // Automatically start verifying any unverified schools & missing phone numbers in the background
    setTimeout(() => {
      triggerAutomaticSchoolVerification('LAB_AND_PHONE', false);
      const queuedBizIds = store.schools
        .filter((s) => s.recordType === 'BUSINESS' && (s.analysisStatus === 'QUEUED' || s.analysisStatus === 'CHECKING'))
        .map((s) => s.id);
      if (queuedBizIds.length > 0) {
        enqueueAnalysis(queuedBizIds);
      }
    }, 1500);
  });
}

void startServer();

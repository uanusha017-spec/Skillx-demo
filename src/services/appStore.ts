import type {
  DPRReport,
  FieldReview,
  SchoolRecord,
  UploadedFileRecord,
  UserSession,
} from '../types';
import { apiFetch, getAccessToken, readJsonSafe, setAccessToken, setUnauthorizedHandler } from './apiClient';
import { computePriority, ensureUniqueRecordIds, formatLocation, isEducationRecord } from '../utils/schoolHelpers';

const STORAGE_KEYS = {
  SCHOOLS: 'natton_skillx_schools_v2',
  REPORTS: 'natton_skillx_reports_v2',
  REVIEWS: 'natton_skillx_reviews_v2',
  UPLOADS: 'natton_skillx_uploads_v2',
  ACTIVE_UPLOAD_ID: 'natton_skillx_active_upload_v2',
  DIRTY: 'natton_skillx_dirty_v2',
  SESSION: 'natton_skillx_session_v1',
};

type Listener = () => void;

class AppStore {
  private session: UserSession | null = null;
  private schools: SchoolRecord[] = [];
  private reports: DPRReport[] = [];
  private reviews: FieldReview[] = [];
  private uploads: UploadedFileRecord[] = [];
  private activeUploadId: string | null = null;
  private storageStatus = 'Connected to server';
  private listeners = new Set<Listener>();
  private syncTimeout: ReturnType<typeof setTimeout> | null = null;
  private saving = false;
  private revision = 0;
  private sessionGeneration = 0;

  constructor() {
    this.hydrateFromLocalStorage();
    setUnauthorizedHandler(() => {
      if (this.session) {
        this.setSession(null, false);
      }
    });
    if (this.session) {
      void this.fetchFromBackend();
    }
  }

  private hydrateFromLocalStorage() {
    if (typeof window === 'undefined') return;
    try {
      const s = localStorage.getItem(STORAGE_KEYS.SCHOOLS);
      if (s) this.schools = ensureUniqueRecordIds(JSON.parse(s) as SchoolRecord[]).items;
      const r = localStorage.getItem(STORAGE_KEYS.REPORTS);
      if (r) this.reports = JSON.parse(r);
      const rev = localStorage.getItem(STORAGE_KEYS.REVIEWS);
      if (rev) this.reviews = JSON.parse(rev);
      const u = localStorage.getItem(STORAGE_KEYS.UPLOADS);
      if (u) this.uploads = JSON.parse(u);
      this.activeUploadId = localStorage.getItem(STORAGE_KEYS.ACTIVE_UPLOAD_ID);
      const savedSession = sessionStorage.getItem(STORAGE_KEYS.SESSION);
      if (savedSession && getAccessToken()) {
        this.session = JSON.parse(savedSession) as UserSession;
      }
    } catch {
      // Ignore corrupt cache
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify() {
    this.listeners.forEach((fn) => fn());
  }

  getStorageStatus(): string {
    return this.storageStatus;
  }

  getSession(): UserSession | null {
    return this.session;
  }

  setSession(user: UserSession | null, notifyLogout = true) {
    this.sessionGeneration++;
    this.session = user;
    if (typeof window !== 'undefined') {
      try {
        if (user) {
          sessionStorage.setItem(STORAGE_KEYS.SESSION, JSON.stringify(user));
        } else {
          sessionStorage.removeItem(STORAGE_KEYS.SESSION);
        }
      } catch {
        // ignore storage errors
      }
    }
    if (user) {
      void this.fetchFromBackend();
    } else {
      if (notifyLogout) {
        void apiFetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
      }
      setAccessToken(null);
    }
    this.notify();
  }

  async fetchFromBackend() {
    if (!this.session || this.syncTimeout || this.saving) return;
    if (typeof window !== 'undefined' && localStorage.getItem(STORAGE_KEYS.DIRTY)) {
      this.syncToBackend();
      return;
    }
    try {
      const rev = this.revision;
      const gen = this.sessionGeneration;
      const resp = await apiFetch('/api/store');
      if (gen !== this.sessionGeneration) return;
      if (resp.status === 401) {
        this.setSession(null, false);
        return;
      }
      if (!resp.ok) return;
      const json = await readJsonSafe<{
        success?: boolean;
        data?: {
          schools?: SchoolRecord[];
          reports?: DPRReport[];
          reviews?: FieldReview[];
          uploads?: UploadedFileRecord[];
          activeUploadId?: string | null;
        };
      }>(resp);

      if (gen !== this.sessionGeneration || rev !== this.revision || this.syncTimeout || this.saving) return;

      if (json.success && json.data) {
        const { schools, reports, reviews, uploads, activeUploadId } = json.data;
        if (Array.isArray(schools)) {
          this.schools = ensureUniqueRecordIds(schools).items;
          if (Array.isArray(reports)) this.reports = reports;
          if (Array.isArray(reviews)) this.reviews = reviews;
          if (Array.isArray(uploads)) this.uploads = uploads;
          if (activeUploadId !== undefined) this.activeUploadId = activeUploadId;
          this.saveToLocalStorage();
          this.storageStatus =
            this.schools.length > 0
              ? 'Synced with server'
              : 'Ready · Upload an Excel sheet or discover businesses';
          this.notify();
        }
      }
    } catch {
      this.storageStatus = 'Local cache active';
      this.notify();
    }
  }

  syncToBackend(immediate = false) {
    if (typeof window === 'undefined') return;
    localStorage.setItem(STORAGE_KEYS.DIRTY, 'true');
    if (this.syncTimeout) clearTimeout(this.syncTimeout);
    this.revision++;
    this.storageStatus = 'Saving to server...';
    this.notify();

    const execute = async () => {
      if (!this.session) {
        this.syncTimeout = null;
        return;
      }
      if (this.saving) {
        this.syncToBackend();
        return;
      }
      this.syncTimeout = null;
      this.saving = true;
      try {
        const rev = this.revision;
        const gen = this.sessionGeneration;
        const resp = await apiFetch('/api/store', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            schools: this.schools,
            reports: this.reports,
            reviews: this.reviews,
            uploads: this.uploads,
            activeUploadId: this.activeUploadId,
          }),
        });
        if (gen !== this.sessionGeneration) return;
        if (resp.status === 401) {
          this.setSession(null, false);
          return;
        }
        if (!resp.ok) throw new Error('Save failed');
        if (rev === this.revision) {
          localStorage.removeItem(STORAGE_KEYS.DIRTY);
          this.storageStatus = 'Saved to server';
        }
      } catch {
        this.storageStatus = 'Saved locally · server sync pending';
      } finally {
        this.saving = false;
        this.notify();
      }
    };

    if (immediate) {
      void execute();
    } else {
      this.syncTimeout = setTimeout(() => {
        void execute();
      }, 250);
    }
  }

  private saveToLocalStorage() {
    if (typeof window === 'undefined') return;
    try {
      localStorage.setItem(STORAGE_KEYS.SCHOOLS, JSON.stringify(this.schools));
      localStorage.setItem(STORAGE_KEYS.REPORTS, JSON.stringify(this.reports));
      localStorage.setItem(STORAGE_KEYS.REVIEWS, JSON.stringify(this.reviews));
      localStorage.setItem(STORAGE_KEYS.UPLOADS, JSON.stringify(this.uploads));
      if (this.activeUploadId) {
        localStorage.setItem(STORAGE_KEYS.ACTIVE_UPLOAD_ID, this.activeUploadId);
      } else {
        localStorage.removeItem(STORAGE_KEYS.ACTIVE_UPLOAD_ID);
      }
    } catch {
      // localStorage quota exceeded; server remains primary store
    }
  }

  getSchools(): SchoolRecord[] {
    return this.schools;
  }

  acceptDiscoveredRecords(records: SchoolRecord[]) {
    this.revision++;
    const map = new Map<string, SchoolRecord>();
    for (const s of [...records, ...this.schools]) {
      map.set(s.id, s);
    }
    this.schools = Array.from(map.values());
    this.saveToLocalStorage();
    this.notify();
  }

  updateSchool(updated: SchoolRecord, skipSync = false) {
    const exists = this.schools.some((s) => s.id === updated.id);
    if (!exists) return;
    this.schools = this.schools.map((s) => (s.id === updated.id ? updated : s));
    this.uploads = this.uploads.map((u) => ({
      ...u,
      records: u.records.map((r) => (r.id === updated.id ? updated : r)),
    }));
    this.saveToLocalStorage();
    if (!skipSync) {
      this.syncToBackend();
    } else if (!this.syncTimeout && typeof window !== 'undefined') {
      localStorage.removeItem(STORAGE_KEYS.DIRTY);
      this.storageStatus = 'Saved to server';
    }
    this.notify();
  }

  deleteRecord(id: string) {
    if (!id) return;
    this.revision++;
    this.schools = this.schools.filter((s) => s.id !== id);
    this.uploads = this.uploads
      .map((u) => {
        const nextRecords = u.records.filter((r) => r.id !== id);
        return { ...u, records: nextRecords, recordsCount: nextRecords.length };
      })
      .filter((u) => u.records.length > 0);
    if (this.activeUploadId && !this.uploads.some((u) => u.id === this.activeUploadId)) {
      this.activeUploadId = this.uploads[0]?.id ?? null;
    }
    this.saveToLocalStorage();
    if (!this.syncTimeout && typeof window !== 'undefined') {
      localStorage.removeItem(STORAGE_KEYS.DIRTY);
    }
    this.storageStatus = 'Record deleted';
    this.notify();
    void apiFetch(`/api/records/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {
      this.syncToBackend(true);
    });
  }

  deleteRecords(ids: string[]) {
    const idSet = new Set(ids.filter(Boolean));
    if (idSet.size === 0) return;
    this.revision++;
    this.schools = this.schools.filter((s) => !idSet.has(s.id));
    this.uploads = this.uploads
      .map((u) => {
        const nextRecords = u.records.filter((r) => !idSet.has(r.id));
        return { ...u, records: nextRecords, recordsCount: nextRecords.length };
      })
      .filter((u) => u.records.length > 0);
    if (this.activeUploadId && !this.uploads.some((u) => u.id === this.activeUploadId)) {
      this.activeUploadId = this.uploads[0]?.id ?? null;
    }
    this.saveToLocalStorage();
    if (!this.syncTimeout && typeof window !== 'undefined') {
      localStorage.removeItem(STORAGE_KEYS.DIRTY);
    }
    this.storageStatus = `Deleted ${idSet.size} record(s)`;
    this.notify();
    void apiFetch('/api/records', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: Array.from(idSet) }),
    }).catch(() => {
      this.syncToBackend(true);
    });
  }

  deleteUpload(uploadId: string) {
    const target = this.uploads.find((u) => u.id === uploadId);
    if (!target) return;
    this.revision++;
    const remainingUploads = this.uploads.filter((u) => u.id !== uploadId);
    const keptIds = new Set(remainingUploads.flatMap((u) => u.records.map((r) => r.id)));
    const removeIds = new Set(target.records.map((r) => r.id).filter((id) => !keptIds.has(id)));
    this.schools = this.schools.filter((s) => !removeIds.has(s.id));
    this.uploads = remainingUploads;
    if (this.activeUploadId === uploadId) {
      this.activeUploadId = remainingUploads[0]?.id ?? null;
    }
    this.saveToLocalStorage();
    if (!this.syncTimeout && typeof window !== 'undefined') {
      localStorage.removeItem(STORAGE_KEYS.DIRTY);
    }
    this.storageStatus = 'Upload batch deleted';
    this.notify();
    void apiFetch(`/api/uploads/${encodeURIComponent(uploadId)}`, { method: 'DELETE' }).catch(() => {
      this.syncToBackend(true);
    });
  }

  clearAllSchools() {
    if (this.syncTimeout) clearTimeout(this.syncTimeout);
    this.syncTimeout = null;
    this.revision++;
    if (typeof window !== 'undefined') {
      localStorage.removeItem(STORAGE_KEYS.DIRTY);
      localStorage.setItem(STORAGE_KEYS.SCHOOLS, '[]');
      localStorage.setItem(STORAGE_KEYS.UPLOADS, '[]');
      localStorage.removeItem(STORAGE_KEYS.ACTIVE_UPLOAD_ID);
    }
    this.schools = [];
    this.uploads = [];
    this.activeUploadId = null;
    this.storageStatus = 'Register cleared';
    void apiFetch('/api/store/clear', { method: 'POST' }).catch(() => {});
    this.notify();
  }

  addUploadedFile(
    filename: string,
    records: SchoolRecord[],
    csvText?: string,
    sheetNames?: string[],
    recordType?: 'SCHOOL' | 'BUSINESS'
  ): UploadedFileRecord {
    const uniqueRecords = ensureUniqueRecordIds(records).items;
    const upload: UploadedFileRecord = {
      id: `upload-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      filename,
      recordType,
      uploadedAt: new Date().toISOString(),
      recordsCount: uniqueRecords.length,
      records: uniqueRecords,
      csvText,
      sheetNames: sheetNames || [],
      ownerId: this.session?.id || 'usr-super-01',
      ownerName: this.session?.name || 'Administrator',
      canVisit: true,
      canShare: true,
    };
    this.uploads = [upload, ...this.uploads];
    this.activeUploadId = upload.id;
    this.schools = ensureUniqueRecordIds([...uniqueRecords, ...this.schools]).items;
    this.saveToLocalStorage();
    this.syncToBackend(true);
    this.notify();
    return upload;
  }

  getUploadHistory(): UploadedFileRecord[] {
    return this.uploads;
  }

  getReports(): DPRReport[] {
    return this.reports;
  }

  addReport(input: Omit<DPRReport, 'id' | 'createdAt'>): DPRReport {
    const report: DPRReport = {
      ...input,
      id: `dpr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      createdAt: new Date().toISOString(),
    };
    this.reports = [report, ...this.reports];

    const target = this.schools.find((s) => s.id === input.schoolId);
    if (target) {
      const next: SchoolRecord = {
        ...target,
        lastVisitedDate: input.visitDate,
        totalVisitsCount: (target.totalVisitsCount || 0) + 1,
        daysSinceLastVisit: 0,
        contactPerson: input.keyPersonMet || target.contactPerson,
      };
      if (isEducationRecord(target)) {
        if (input.computerLabObserved === 'Yes') {
          next.computerLab = 'Yes';
          next.computerLabSource = 'VISIT';
          next.computerLabCheckedAt = new Date().toISOString();
          if (input.computersCountObserved) next.labComputersCount = input.computersCountObserved;
          next.labInternetAvailable = input.internetWorking ? 'Yes (Verified in Field Visit)' : 'No';
          next.labVerificationNote = `Verified in field visit by ${input.officerName} on ${input.visitDate}.`;
        } else if (input.computerLabObserved === 'No') {
          next.computerLab = 'No';
          next.computerLabSource = 'VISIT';
          next.computerLabCheckedAt = new Date().toISOString();
          next.labComputersCount = 0;
          next.labVerificationNote = `Field officer confirmed absence of computer lab during visit on ${input.visitDate}.`;
        }
      }
      const priority = computePriority(next);
      this.updateSchool({ ...next, ...priority });
    } else {
      this.saveToLocalStorage();
      this.syncToBackend();
      this.notify();
    }
    return report;
  }

  updateReportStatus(id: string, status: DPRReport['approvalStatus'], adminRemarks?: string) {
    this.reports = this.reports.map((r) =>
      r.id === id ? { ...r, approvalStatus: status, adminRemarks: adminRemarks ?? r.adminRemarks } : r
    );
    this.saveToLocalStorage();
    this.syncToBackend();
    this.notify();
  }

  getReviews(): FieldReview[] {
    return this.reviews;
  }

  addReview(input: Omit<FieldReview, 'id' | 'reviewedAt'>): FieldReview {
    const review: FieldReview = {
      ...input,
      id: `rev-${Date.now()}`,
      reviewedAt: new Date().toISOString(),
    };
    this.reviews = [review, ...this.reviews];

    const target = this.schools.find((s) => s.id === input.schoolId);
    const today = new Date().toISOString().slice(0, 10);
    const personMet = input.personMet || 'Principal / School In-Charge';

    if (target) {
      const next: SchoolRecord = {
        ...target,
        contactPerson: personMet,
        lastVisitedDate: today,
        totalVisitsCount: (target.totalVisitsCount || 0) + 1,
        daysSinceLastVisit: 0,
      };
      if (isEducationRecord(target) && input.computerLabVerified) {
        next.computerLab = 'Yes';
        next.computerLabSource = 'VISIT';
        next.computerLabCheckedAt = new Date().toISOString();
      }
      this.updateSchool({ ...next, ...computePriority(next) });
    }

    const existingDpr = this.reports.find((r) => r.schoolId === input.schoolId && r.visitDate === today);
    const targetIsSchool = target ? isEducationRecord(target) : true;
    if (existingDpr) {
      this.reports = this.reports.map((r) =>
        r.id === existingDpr.id
          ? {
              ...r,
              keyPersonMet: personMet,
              discussionNotes: `${r.discussionNotes} | [Review]: ${input.comment}`,
              computerLabObserved: targetIsSchool && input.computerLabVerified ? 'Yes' : r.computerLabObserved,
            }
          : r
      );
    } else {
      const syncedDpr: DPRReport = {
        id: `dpr-rev-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        schoolId: input.schoolId,
        schoolName: input.schoolName,
        schoolArea: target ? formatLocation(target.name, target.area, target.city, target.state) : 'Unassigned',
        officerId: this.session?.id || 'usr-field-01',
        officerName: input.reviewerName || this.session?.name || 'Field Officer',
        visitDate: today,
        visitDurationMinutes: 45,
        keyPersonMet: personMet,
        discussionNotes: `Field Visit Audit: ${input.comment || 'Met representative and reviewed organization.'}`,
        computerLabObserved: targetIsSchool && input.computerLabVerified ? 'Yes' : 'Partial',
        computersCountObserved: targetIsSchool && input.computerLabVerified ? target?.labComputersCount || 20 : 0,
        internetWorking: targetIsSchool ? input.computerLabVerified : false,
        actionItems: targetIsSchool
          ? 'Follow up on technical education program and field review findings.'
          : 'Follow up on industry digital growth proposal and review findings.',
        approvalStatus: 'SUBMITTED',
        createdAt: new Date().toISOString(),
      };
      this.reports = [syncedDpr, ...this.reports];
    }

    this.saveToLocalStorage();
    this.syncToBackend();
    this.notify();
    return review;
  }
}

export const appStore = new AppStore();

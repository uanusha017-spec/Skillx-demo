import React, { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  ExternalLink,
  FileSpreadsheet,
  FileText,
  Globe,
  Loader2,
  Monitor,
  Pause,
  Phone,
  Play,
  RefreshCw,
  Square,
  Trash2,
  Upload,
  Wifi,
  X,
  XCircle,
} from 'lucide-react';
import type { SchoolAutoVerifyStatus, SchoolRecord } from '../types';
import { apiFetch, readJsonSafe } from '../services/apiClient';
import { appStore } from '../services/appStore';
import { exportSchoolLabsExcel, exportSchoolLabsWord } from '../utils/exportSuite';
import { computePriority, formatIST, formatLocation, hasValidPhone, normalizeArea, safeExternalUrl } from '../utils/schoolHelpers';

interface SchoolLabsViewProps {
  schools: SchoolRecord[];
  onSelectSchoolForDPR: (school: SchoolRecord) => void;
  onSelectSchoolForReview: (school: SchoolRecord) => void;
  onOpenUpload: () => void;
  autoVerifyTrigger?: number;
}

export const SchoolLabsView: React.FC<SchoolLabsViewProps> = ({
  schools,
  onSelectSchoolForDPR,
  onSelectSchoolForReview,
  onOpenUpload,
  autoVerifyTrigger = 0,
}) => {
  const [areaFilter, setAreaFilter] = useState('ALL');
  const [boardFilter, setBoardFilter] = useState('ALL');
  const [sheetFilter, setSheetFilter] = useState('ALL');
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'Yes' | 'No' | 'Unverified' | 'MISSING_PHONE'>('ALL');
  const [selectedEvidence, setSelectedEvidence] = useState<SchoolRecord | null>(null);
  const [recheckingId, setRecheckingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [confirmDeleteFiltered, setConfirmDeleteFiltered] = useState(false);
  const [showCompleteBanner, setShowCompleteBanner] = useState(false);
  const [errorBanner, setErrorBanner] = useState('');

  const [runner, setRunner] = useState<SchoolAutoVerifyStatus>({
    status: 'IDLE',
    mode: 'LAB_AND_PHONE',
    total: schools.length,
    checked: schools.filter((s) => s.computerLab !== 'Unverified').length,
    confirmedYes: schools.filter((s) => s.computerLab === 'Yes').length,
    confirmedNo: schools.filter((s) => s.computerLab === 'No').length,
    unverifiedCount: schools.filter((s) => s.computerLab === 'Unverified').length,
    missingPhoneCount: schools.filter((s) => !hasValidPhone(s.contactPhone)).length,
    phonesFetched: 0,
    message: '',
  });

  const lastTriggerRef = useRef(0);
  const prevStatusRef = useRef<SchoolAutoVerifyStatus['status']>('IDLE');

  const uniqueAreas = Array.from(new Set(schools.map((s) => normalizeArea(s.name, s.area, s.city)))).sort();
  const uniqueBoards = Array.from(new Set(schools.map((s) => s.board).filter(Boolean) as string[])).sort();
  const uniqueSheets = Array.from(new Set(schools.map((s) => s.sheetName).filter(Boolean) as string[]));

  const filtered = schools.filter((s) => {
    if (areaFilter !== 'ALL' && normalizeArea(s.name, s.area, s.city) !== areaFilter) return false;
    if (boardFilter !== 'ALL' && s.board !== boardFilter) return false;
    if (sheetFilter !== 'ALL' && s.sheetName !== sheetFilter) return false;
    if (statusFilter === 'Yes' && s.computerLab !== 'Yes') return false;
    if (statusFilter === 'No' && s.computerLab !== 'No') return false;
    if (statusFilter === 'Unverified' && s.computerLab !== 'Unverified') return false;
    if (statusFilter === 'MISSING_PHONE' && hasValidPhone(s.contactPhone)) return false;
    return true;
  });

  const totalCount = schools.length;
  const yesCount = schools.filter((s) => s.computerLab === 'Yes').length;
  const noCount = schools.filter((s) => s.computerLab === 'No').length;
  const unverifiedCount = schools.filter((s) => s.computerLab === 'Unverified').length;
  const missingPhoneCount = schools.filter((s) => !hasValidPhone(s.contactPhone)).length;

  function formatUiError(raw: unknown): string {
    const str = raw instanceof Error ? raw.message : String(raw || 'Verification request failed.');
    if (/SerpForge returned/i.test(str)) {
      return str.slice(0, 260);
    }
    if (/RESOURCE_EXHAUSTED|\b429\b|quota|rate[\s-]?limit/i.test(str)) {
      return 'Search rate limit reached. Verification has been paused safely — wait a few seconds and click Resume Verification.';
    }
    if (str.trim().startsWith('{')) {
      try {
        const parsed = JSON.parse(str) as { error?: { message?: string }; message?: string };
        const clean = parsed?.error?.message || parsed?.message;
        if (clean) return clean.split('\n')[0].slice(0, 220);
      } catch {
        // fall through
      }
    }
    return str.slice(0, 220);
  }

  type LabResultPayload = {
    computerLab: SchoolRecord['computerLab'];
    computerLabSource: SchoolRecord['computerLabSource'];
    computerLabSourceUrl?: string;
    computerLabCheckedAt: string;
    labComputersCount: number | null;
    labInternetAvailable: string;
    labConfidence: number;
    labVerificationNote: string;
    website?: string;
    contactPhone?: string;
    contactPhoneSource?: SchoolRecord['contactPhoneSource'];
    contactPhoneSourceUrl?: string;
    contactEmail?: string;
    contactEmailSource?: SchoolRecord['contactEmailSource'];
    contactPerson?: string;
    address?: string;
  };

  function mergeLabResult(school: SchoolRecord, r: LabResultPayload): SchoolRecord {
    const next: SchoolRecord = {
      ...school,
      computerLab: r.computerLab,
      computerLabSource: r.computerLabSource,
      computerLabSourceUrl: r.computerLabSourceUrl || school.computerLabSourceUrl,
      computerLabCheckedAt: r.computerLabCheckedAt,
      labComputersCount: r.labComputersCount,
      labInternetAvailable: r.labInternetAvailable,
      labConfidence: r.labConfidence,
      labVerificationNote: r.labVerificationNote,
      website: school.website || r.website,
      address: school.address || r.address,
      contactPerson: school.contactPerson || r.contactPerson,
      contactPhone: hasValidPhone(school.contactPhone) ? school.contactPhone : r.contactPhone,
      contactPhoneSource: hasValidPhone(school.contactPhone)
        ? school.contactPhoneSource || 'Uploaded Excel'
        : r.contactPhoneSource,
      contactPhoneSourceUrl: hasValidPhone(school.contactPhone)
        ? school.contactPhoneSourceUrl
        : r.contactPhoneSourceUrl,
      contactEmail: school.contactEmail || r.contactEmail,
      contactEmailSource: school.contactEmail ? school.contactEmailSource || 'Uploaded Excel' : r.contactEmailSource,
    };
    const merged = { ...next, ...computePriority(next) };
    appStore.updateSchool(merged, true);
    return merged;
  }

  async function verifySingleSchool(school: SchoolRecord): Promise<SchoolRecord | null> {
    const resp = await apiFetch('/api/verify-lab', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        schoolId: school.id,
        schoolName: school.name,
        websiteUrl: school.website || '',
        city: school.city || '',
        area: school.area || '',
        state: school.state || '',
        board: school.board || '',
        existingPhone: school.contactPhone || '',
        existingEmail: school.contactEmail || '',
      }),
    });
    const data = await readJsonSafe<{
      result?: LabResultPayload;
      error?: string;
      code?: string;
      retryAfterSeconds?: number;
    }>(resp);

    if (!resp.ok || !data.result) {
      const err = new Error(formatUiError(data.error || 'Lab verification request failed.')) as Error & {
        rateLimited?: boolean;
        retryAfterSeconds?: number;
      };
      if (resp.status === 429 || data.code === 'RATE_LIMITED') {
        err.rateLimited = true;
        err.retryAfterSeconds = data.retryAfterSeconds || 25;
      }
      throw err;
    }

    return mergeLabResult(school, data.result);
  }

  async function controlAutoVerify(action: 'start' | 'pause' | 'resume' | 'stop' | 'fetch-missing-phones') {
    setErrorBanner('');
    if (action === 'start' || action === 'resume' || action === 'fetch-missing-phones') {
      setShowCompleteBanner(false);
    }
    try {
      const resp = await apiFetch('/api/school-verify/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const data = await readJsonSafe<{ status?: SchoolAutoVerifyStatus; error?: string }>(resp);
      if (resp.ok && data.status) {
        setRunner(data.status);
      } else if (data.error) {
        setErrorBanner(formatUiError(data.error));
      }
    } catch (err) {
      setErrorBanner(formatUiError(err));
    }
  }

  // Automatically sync with server-side background Computer Lab & Missing Phone verifier (no button press needed!)
  useEffect(() => {
    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;

    const pollOnce = async () => {
      try {
        const resp = await apiFetch('/api/school-verify/status');
        if (cancelled || !resp.ok) return;
        const data = await readJsonSafe<{ status?: SchoolAutoVerifyStatus }>(resp);
        if (cancelled || !data.status) return;
        const st = data.status;
        setRunner(st);
        if (st.lastError) {
          setErrorBanner(formatUiError(st.lastError));
        } else {
          setErrorBanner('');
        }
        if (st.status === 'RUNNING') {
          await appStore.fetchFromBackend();
        } else if (prevStatusRef.current === 'RUNNING' && st.status === 'COMPLETE') {
          await appStore.fetchFromBackend();
          setShowCompleteBanner(true);
        }
        prevStatusRef.current = st.status;
        if (!cancelled && (st.status === 'RUNNING' || st.unverifiedCount > 0)) {
          pollTimer = setTimeout(() => {
            void pollOnce();
          }, st.status === 'RUNNING' ? 2200 : 6000);
        }
      } catch {
        if (!cancelled) {
          pollTimer = setTimeout(() => {
            void pollOnce();
          }, 5000);
        }
      }
    };

    void pollOnce();
    return () => {
      cancelled = true;
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, [schools.length]);

  // Immediately kick automatic verification when user uploads a new school spreadsheet
  useEffect(() => {
    if (autoVerifyTrigger > 0 && autoVerifyTrigger !== lastTriggerRef.current && schools.length > 0) {
      lastTriggerRef.current = autoVerifyTrigger;
      void controlAutoVerify('start');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoVerifyTrigger]);

  const denominator = runner.total || totalCount;
  const completedCount = Math.max(runner.checked, yesCount + noCount);
  const progressPct = denominator > 0 ? Math.min(100, Math.round((completedCount / denominator) * 100)) : 0;

  return (
    <section className="space-y-5">
      {/* Header & Filters */}
      <div className="bg-white border border-slate-200 rounded-2xl p-5 space-y-3 shadow-2xs">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <h1 className="text-2xl font-bold text-slate-900 tracking-tight">School Labs &amp; Route Plan</h1>
            <p className="text-sm text-slate-600">
              Verifies whether each uploaded school has a Computer Lab / ICT Lab via live Google Search and automatically fetches missing contact numbers from Google.
            </p>
          </div>
          <button
            type="button"
            onClick={onOpenUpload}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs rounded-xl flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
          >
            <Upload className="w-3.5 h-3.5" />
            <span>Upload School Excel</span>
          </button>
        </div>

        <div className="flex flex-col sm:flex-row flex-wrap gap-2 text-sm pt-1 sm:items-center">
          <select
            aria-label="School area"
            className="border border-slate-300 rounded-xl p-2 text-xs font-medium bg-white w-full sm:w-auto"
            value={areaFilter}
            onChange={(e) => setAreaFilter(e.target.value)}
          >
            <option value="ALL">All areas ({schools.length})</option>
            {uniqueAreas.map((area) => (
              <option key={area} value={area}>
                {area} ({schools.filter((s) => normalizeArea(s.name, s.area, s.city) === area).length})
              </option>
            ))}
          </select>

          <select
            aria-label="School board"
            className="border border-slate-300 rounded-xl p-2 text-xs font-medium bg-white w-full sm:w-auto"
            value={boardFilter}
            onChange={(e) => setBoardFilter(e.target.value)}
          >
            <option value="ALL">All boards / categories</option>
            {uniqueBoards.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>

          {uniqueSheets.length > 1 && (
            <select
              aria-label="Sheet tab"
              className="border border-indigo-300 rounded-xl p-2 text-xs font-bold bg-indigo-50/80 text-indigo-900 w-full sm:w-auto"
              value={sheetFilter}
              onChange={(e) => setSheetFilter(e.target.value)}
            >
              <option value="ALL">All Sheet Tabs ({schools.length})</option>
              {uniqueSheets.map((sn) => (
                <option key={sn} value={sn}>
                  Tab: {sn} ({schools.filter((s) => s.sheetName === sn).length})
                </option>
              ))}
            </select>
          )}

          <span className="text-xs text-slate-600 font-semibold py-1 tabular-nums">
            {filtered.length} school(s) shown
          </span>

          {filtered.length > 0 && (
            <div className="sm:ml-auto flex items-center gap-1.5">
              {confirmDeleteFiltered ? (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      appStore.deleteRecords(filtered.map((s) => s.id));
                      setConfirmDeleteFiltered(false);
                      setSheetFilter('ALL');
                      setAreaFilter('ALL');
                      setBoardFilter('ALL');
                    }}
                    className="px-2.5 py-1.5 bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold rounded-xl cursor-pointer"
                  >
                    Confirm Delete ({filtered.length})
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmDeleteFiltered(false)}
                    className="px-2.5 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold rounded-xl cursor-pointer"
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  disabled={runner.status === 'RUNNING'}
                  onClick={() => setConfirmDeleteFiltered(true)}
                  className="px-2.5 py-1.5 bg-white border border-rose-200 hover:bg-rose-50 disabled:opacity-40 text-rose-700 text-xs font-bold rounded-xl flex items-center gap-1 cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>{sheetFilter !== 'ALL' ? `Delete Tab (${filtered.length})` : `Delete Shown (${filtered.length})`}</span>
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {showCompleteBanner && (
        <div className="p-3.5 bg-emerald-50 border border-emerald-300 rounded-2xl text-emerald-950 flex items-center justify-between text-xs font-bold">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
            <span>
              Verification finished! Processed all rows cleanly · Confirmed {yesCount} Yes / {noCount} No · Fetched {runner.phonesFetched} missing phone(s) from Google. Runner stopped automatically.
            </span>
          </div>
          <button
            type="button"
            onClick={() => setShowCompleteBanner(false)}
            className="text-emerald-800 hover:underline cursor-pointer shrink-0 ml-2"
          >
            Dismiss
          </button>
        </div>
      )}

      {errorBanner && (
        <div className="p-3.5 bg-amber-50 border border-amber-300 rounded-2xl text-amber-950 text-xs font-semibold flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
            <span>{errorBanner}</span>
          </div>
          <button
            type="button"
            onClick={() => setErrorBanner('')}
            className="text-amber-800 hover:underline shrink-0 cursor-pointer"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Automatic Computer Lab & Missing Contact Verification Control Panel */}
      <div className="bg-blue-50 border border-blue-200 rounded-2xl p-4 text-sm space-y-3 shadow-2xs">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h2 className="font-bold text-blue-950 text-base">
              Automatic Computer Lab &amp; Google Contact Verification
            </h2>
            <p className="text-xs text-slate-700 mt-0.5 tabular-nums">
              {runner.status === 'RUNNING'
                ? runner.message
                : runner.status === 'COMPLETE'
                ? `Automatic verification complete for ${totalCount} school(s) · ${yesCount} Lab Yes · ${noCount} Lab No · ${missingPhoneCount} missing phone(s)`
                : runner.status === 'PAUSED'
                ? `Paused (${completedCount} of ${totalCount} schools checked)`
                : 'Runs automatically in the background for all uploaded schools — checks Computer Labs and fetches missing phone numbers without clicking any button.'}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            {runner.status === 'RUNNING' ? (
              <>
                <button
                  type="button"
                  onClick={() => void controlAutoVerify('pause')}
                  className="px-3.5 py-2 bg-amber-500 hover:bg-amber-600 text-white font-bold text-xs rounded-xl flex items-center gap-1.5 cursor-pointer"
                >
                  <Pause className="w-3.5 h-3.5 fill-current" />
                  <span>Pause</span>
                </button>
                <button
                  type="button"
                  onClick={() => void controlAutoVerify('stop')}
                  className="px-3.5 py-2 bg-rose-600 hover:bg-rose-700 text-white font-bold text-xs rounded-xl flex items-center gap-1.5 cursor-pointer"
                >
                  <Square className="w-3 h-3 fill-current" />
                  <span>Stop</span>
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  disabled={schools.length === 0}
                  onClick={() => void controlAutoVerify(runner.status === 'PAUSED' ? 'resume' : 'start')}
                  className="px-3.5 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white font-bold text-xs rounded-xl flex items-center gap-1.5 cursor-pointer"
                >
                  <Play className="w-3.5 h-3.5 fill-current" />
                  <span>{runner.status === 'PAUSED' ? 'Resume Auto-Verify' : 'Re-run Labs + Phones'}</span>
                </button>
                <button
                  type="button"
                  disabled={missingPhoneCount === 0}
                  onClick={() => void controlAutoVerify('fetch-missing-phones')}
                  className="px-3.5 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40 text-white font-bold text-xs rounded-xl flex items-center gap-1.5 cursor-pointer"
                >
                  <Phone className="w-3.5 h-3.5" />
                  <span>Fetch Missing Phones ({missingPhoneCount})</span>
                </button>
              </>
            )}

            <button
              type="button"
              disabled={schools.length === 0}
              onClick={() => exportSchoolLabsExcel(filtered)}
              className="px-3 py-2 bg-white border border-slate-300 hover:bg-slate-50 disabled:opacity-40 text-slate-800 font-bold text-xs rounded-xl flex items-center gap-1 cursor-pointer"
            >
              <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-600" />
              <span>Excel</span>
            </button>

            <button
              type="button"
              disabled={schools.length === 0}
              onClick={() =>
                void exportSchoolLabsWord(filtered, {
                  title: 'School Labs Verification & Field Route Roadmap',
                  period: new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
                })
              }
              className="px-3 py-2 bg-white border border-slate-300 hover:bg-slate-50 disabled:opacity-40 text-slate-800 font-bold text-xs rounded-xl flex items-center gap-1 cursor-pointer"
            >
              <FileText className="w-3.5 h-3.5 text-blue-600" />
              <span>Word</span>
            </button>
          </div>
        </div>

        {runner.status === 'RUNNING' && (
          <div className="space-y-1 pt-1">
            <div className="flex items-center justify-between text-[11px] text-blue-900 font-mono tabular-nums">
              <span className="truncate mr-2">{runner.message}</span>
              <span className="shrink-0">{progressPct}%</span>
            </div>
            <div className="w-full h-2 bg-blue-200 rounded-full overflow-hidden">
              <div className="h-full bg-blue-600 transition-all duration-300" style={{ width: `${progressPct}%` }} />
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-1.5 text-xs pt-1">
          {[
            { label: 'All', value: 'ALL' as const, count: totalCount },
            { label: 'Lab: Yes', value: 'Yes' as const, count: yesCount },
            { label: 'Lab: No', value: 'No' as const, count: noCount },
            { label: 'Unverified', value: 'Unverified' as const, count: unverifiedCount },
            { label: 'Missing Phone', value: 'MISSING_PHONE' as const, count: missingPhoneCount },
          ].map((btn) => (
            <button
              key={btn.value}
              type="button"
              onClick={() => setStatusFilter(btn.value)}
              className={`border rounded-lg px-2.5 py-1 font-semibold transition-colors cursor-pointer tabular-nums ${
                statusFilter === btn.value
                  ? 'bg-blue-600 text-white border-blue-600'
                  : 'bg-white text-slate-800 border-slate-300 hover:bg-slate-50'
              }`}
            >
              {btn.label}: {btn.count}
            </button>
          ))}
        </div>
      </div>

      {/* Schools Data Table */}
      <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-2xs">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 border-b border-slate-200 text-slate-600 font-bold text-[11px]">
              <tr>
                <th className="p-3.5 pl-5">School &amp; Location</th>
                <th className="p-3.5">Computer Lab Status</th>
                <th className="p-3.5">Contact Number (Excel / Google)</th>
                <th className="p-3.5">Website &amp; Source</th>
                <th className="p-3.5 pr-5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={5} className="p-10 text-center text-slate-500">
                    No schools loaded yet. Upload an Excel/CSV school list to automatically check computer labs and fetch missing phone numbers from Google.
                  </td>
                </tr>
              ) : (
                filtered.map((s) => {
                  const isBusy = recheckingId === s.id;
                  const phoneOk = hasValidPhone(s.contactPhone);
                  const safeWeb = safeExternalUrl(s.website);
                  return (
                    <tr key={s.id} className="hover:bg-slate-50/70 transition-colors align-top">
                      <td className="p-3.5 pl-5 min-w-[220px]">
                        <div className="font-bold text-slate-900 text-sm">{s.name}</div>
                        <div className="text-[11px] text-slate-500 mt-0.5">
                          {formatLocation(s.name, s.area, s.city, s.state)}
                          {s.board ? ` · ${s.board}` : ''}
                        </div>
                        {s.sheetName && (
                          <div className="text-[10px] text-indigo-700 font-semibold mt-0.5">
                            Tab: {s.sheetName}
                          </div>
                        )}
                      </td>

                      <td className="p-3.5 min-w-[190px]">
                        <div className="flex items-center gap-1.5 font-bold">
                          {s.computerLab === 'Yes' && (
                            <>
                              <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                              <span className="text-emerald-800">
                                Yes{s.labComputersCount ? ` (${s.labComputersCount} PCs)` : ''}
                              </span>
                            </>
                          )}
                          {s.computerLab === 'No' && (
                            <>
                              <XCircle className="w-4 h-4 text-rose-600 shrink-0" />
                              <span className="text-rose-800">No Lab</span>
                            </>
                          )}
                          {s.computerLab === 'Unverified' && (
                            <>
                              <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
                              <span className="text-amber-800">Unverified</span>
                            </>
                          )}
                        </div>
                        {s.labVerificationNote && (
                          <p className="text-[11px] text-slate-600 mt-1 line-clamp-2 max-w-xs">
                            {s.labVerificationNote}
                          </p>
                        )}
                        <button
                          type="button"
                          onClick={() => setSelectedEvidence(s)}
                          className="text-[11px] font-bold text-blue-700 hover:underline mt-1 cursor-pointer"
                        >
                          Inspect Evidence
                        </button>
                      </td>

                      <td className="p-3.5 min-w-[190px]">
                        {phoneOk ? (
                          <div className="space-y-0.5">
                            <div className="font-mono font-bold text-slate-900">{s.contactPhone}</div>
                            <div className="text-[11px] font-semibold text-emerald-700">
                              Source: {s.contactPhoneSource || 'Uploaded Excel'}
                            </div>
                            {safeExternalUrl(s.contactPhoneSourceUrl) && (
                              <a
                                href={safeExternalUrl(s.contactPhoneSourceUrl)}
                                target="_blank"
                                rel="noreferrer"
                                className="text-[10px] text-blue-700 hover:underline inline-flex items-center gap-0.5"
                              >
                                <span>Google source</span>
                                <ExternalLink className="w-2.5 h-2.5" />
                              </a>
                            )}
                          </div>
                        ) : (
                          <div className="space-y-1">
                            <div className="text-amber-800 font-semibold">Missing in Excel</div>
                            <button
                              type="button"
                              disabled={isBusy || runner.status === 'RUNNING'}
                              onClick={async () => {
                                setRecheckingId(s.id);
                                try {
                                  await verifySingleSchool(s);
                                } catch (err) {
                                  setErrorBanner(err instanceof Error ? err.message : 'Lookup failed');
                                } finally {
                                  setRecheckingId(null);
                                }
                              }}
                              className="text-[11px] font-bold text-blue-700 hover:underline cursor-pointer"
                            >
                              {isBusy ? 'Searching Google...' : 'Fetch from Google'}
                            </button>
                          </div>
                        )}
                      </td>

                      <td className="p-3.5 min-w-[160px]">
                        {safeWeb ? (
                          <a
                            href={safeWeb}
                            target="_blank"
                            rel="noreferrer"
                            className="text-blue-700 hover:underline break-all inline-flex items-center gap-1 font-medium"
                          >
                            <Globe className="w-3.5 h-3.5 shrink-0" />
                            <span className="truncate max-w-[180px]">{safeWeb.replace(/^https?:\/\//, '')}</span>
                          </a>
                        ) : (
                          <span className="text-slate-400">No website listed</span>
                        )}
                        {s.contactEmail && (
                          <div className="text-[11px] text-slate-600 font-mono truncate max-w-[180px] mt-1">
                            {s.contactEmail}
                          </div>
                        )}
                      </td>

                      <td className="p-3.5 pr-5 text-right whitespace-nowrap">
                        <div className="flex items-center justify-end gap-1.5">
                          <button
                            type="button"
                            disabled={isBusy || runner.status === 'RUNNING'}
                            onClick={async () => {
                              setRecheckingId(s.id);
                              try {
                                await verifySingleSchool(s);
                              } catch (err) {
                                setErrorBanner(err instanceof Error ? err.message : 'Verification failed');
                              } finally {
                                setRecheckingId(null);
                              }
                            }}
                            className="px-2.5 py-1.5 bg-slate-100 hover:bg-slate-200 disabled:opacity-50 text-slate-800 font-bold rounded-lg inline-flex items-center gap-1 cursor-pointer"
                          >
                            {isBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                            <span>Verify</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => onSelectSchoolForDPR(s)}
                            className="px-2.5 py-1.5 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-lg cursor-pointer"
                          >
                            Log DPR
                          </button>
                          <button
                            type="button"
                            onClick={() => onSelectSchoolForReview(s)}
                            className="px-2.5 py-1.5 bg-white border border-slate-300 hover:bg-slate-50 text-slate-700 font-bold rounded-lg cursor-pointer"
                          >
                            Review
                          </button>
                          {confirmDeleteId === s.id ? (
                            <>
                              <button
                                type="button"
                                onClick={() => {
                                  appStore.deleteRecord(s.id);
                                  setConfirmDeleteId(null);
                                  if (selectedEvidence?.id === s.id) setSelectedEvidence(null);
                                }}
                                className="px-2 py-1.5 bg-rose-600 hover:bg-rose-700 text-white font-bold rounded-lg cursor-pointer"
                              >
                                Delete
                              </button>
                              <button
                                type="button"
                                onClick={() => setConfirmDeleteId(null)}
                                className="px-2 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold rounded-lg cursor-pointer"
                              >
                                Cancel
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              aria-label={`Delete ${s.name}`}
                              disabled={runner.status === 'RUNNING'}
                              onClick={() => setConfirmDeleteId(s.id)}
                              className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 disabled:opacity-40 rounded-lg cursor-pointer"
                              title="Delete school"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Computer Lab Evidence Inspection Modal */}
      {selectedEvidence && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white w-full max-w-2xl rounded-3xl shadow-2xl border border-slate-200 overflow-hidden flex flex-col max-h-[90vh]">
            <div className="p-6 bg-slate-950 text-white flex items-start justify-between">
              <div className="space-y-1 pr-4">
                <span className="text-[11px] font-bold uppercase tracking-wider text-cyan-400">
                  Computer Lab Evidence Inspection
                </span>
                <h2 className="text-xl font-bold tracking-tight">{selectedEvidence.name}</h2>
                <p className="text-xs text-slate-300">
                  {[selectedEvidence.area, selectedEvidence.city, selectedEvidence.state, selectedEvidence.board]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSelectedEvidence(null)}
                className="p-1.5 text-slate-400 hover:text-white hover:bg-white/10 rounded-xl cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-6 space-y-5 overflow-y-auto">
              <div
                className={`p-4 rounded-2xl border flex items-center justify-between gap-4 ${
                  selectedEvidence.computerLab === 'Yes'
                    ? 'bg-emerald-50 border-emerald-200 text-emerald-950'
                    : selectedEvidence.computerLab === 'No'
                    ? 'bg-rose-50 border-rose-200 text-rose-950'
                    : 'bg-amber-50 border-amber-200 text-amber-950'
                }`}
              >
                <div className="flex items-center gap-3">
                  {selectedEvidence.computerLab === 'Yes' ? (
                    <CheckCircle2 className="w-8 h-8 text-emerald-600 shrink-0" />
                  ) : selectedEvidence.computerLab === 'No' ? (
                    <XCircle className="w-8 h-8 text-rose-600 shrink-0" />
                  ) : (
                    <AlertTriangle className="w-8 h-8 text-amber-600 shrink-0" />
                  )}
                  <div>
                    <div className="text-lg font-extrabold tracking-tight">
                      {selectedEvidence.computerLab === 'Yes'
                        ? 'Computer Lab Verified: YES'
                        : selectedEvidence.computerLab === 'No'
                        ? 'Computer Lab Status: NO'
                        : 'Status: Unverified / Inconclusive'}
                    </div>
                    <p className="text-xs text-slate-600 mt-0.5">
                      Source: {selectedEvidence.computerLabSource?.replace(/_/g, ' ') || 'Google Search'}
                      {selectedEvidence.labConfidence
                        ? ` · ${Math.round(selectedEvidence.labConfidence * 100)}% Confidence`
                        : ''}
                    </p>
                  </div>
                </div>

                <button
                  type="button"
                  disabled={recheckingId === selectedEvidence.id}
                  onClick={async () => {
                    setRecheckingId(selectedEvidence.id);
                    try {
                      const updated = await verifySingleSchool(selectedEvidence);
                      if (updated) setSelectedEvidence(updated);
                    } finally {
                      setRecheckingId(null);
                    }
                  }}
                  className="px-3 py-1.5 bg-white border border-slate-300 hover:bg-slate-50 text-slate-800 text-xs font-bold rounded-xl flex items-center gap-1.5 cursor-pointer"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${recheckingId === selectedEvidence.id ? 'animate-spin text-blue-600' : ''}`} />
                  <span>{recheckingId === selectedEvidence.id ? 'Checking...' : 'Re-verify'}</span>
                </button>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="p-4 bg-slate-50 border border-slate-200 rounded-2xl space-y-1">
                  <div className="flex items-center gap-1.5 text-xs font-bold text-slate-500">
                    <Monitor className="w-4 h-4 text-blue-600" />
                    <span>Workstations</span>
                  </div>
                  <p className="text-sm font-extrabold text-slate-900 tabular-nums">
                    {selectedEvidence.labComputersCount
                      ? `${selectedEvidence.labComputersCount} Computers`
                      : selectedEvidence.computerLab === 'Yes'
                      ? 'Available (Count unstated)'
                      : 'None confirmed'}
                  </p>
                </div>

                <div className="p-4 bg-slate-50 border border-slate-200 rounded-2xl space-y-1">
                  <div className="flex items-center gap-1.5 text-xs font-bold text-slate-500">
                    <Wifi className="w-4 h-4 text-emerald-600" />
                    <span>Network &amp; Broadband</span>
                  </div>
                  <p className="text-sm font-extrabold text-slate-900">
                    {selectedEvidence.labInternetAvailable || 'Unconfirmed'}
                  </p>
                </div>

                <div className="p-4 bg-slate-50 border border-slate-200 rounded-2xl space-y-1">
                  <div className="flex items-center gap-1.5 text-xs font-bold text-slate-500">
                    <Phone className="w-4 h-4 text-indigo-600" />
                    <span>Contact Phone</span>
                  </div>
                  <p className="text-sm font-extrabold font-mono text-slate-900">
                    {selectedEvidence.contactPhone || 'Not found'}
                  </p>
                  <p className="text-[10px] text-slate-500">
                    {selectedEvidence.contactPhoneSource || 'Pending'}
                  </p>
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-bold text-slate-500">Verified Evidence Snippet</label>
                <div className="p-4 bg-slate-900 text-slate-100 rounded-2xl font-mono text-xs leading-relaxed border border-slate-800">
                  &ldquo;{selectedEvidence.labVerificationNote || 'Click Re-verify to fetch live Google Search evidence.'}&rdquo;
                </div>
              </div>

              <div className="p-4 bg-blue-50/60 border border-blue-100 rounded-2xl space-y-2 text-xs">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-blue-950 flex items-center gap-1.5">
                    <Globe className="w-4 h-4 text-blue-600" />
                    <span>Source Verification URL</span>
                  </span>
                  <span className="text-slate-500 flex items-center gap-1">
                    <Clock className="w-3.5 h-3.5" />
                    <span>{formatIST(selectedEvidence.computerLabCheckedAt)}</span>
                  </span>
                </div>
                {safeExternalUrl(selectedEvidence.computerLabSourceUrl || selectedEvidence.website) ? (
                  <a
                    href={safeExternalUrl(selectedEvidence.computerLabSourceUrl || selectedEvidence.website)}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1.5 font-bold text-blue-700 hover:underline break-all"
                  >
                    <span>{selectedEvidence.computerLabSourceUrl || selectedEvidence.website}</span>
                    <ExternalLink className="w-3.5 h-3.5 shrink-0" />
                  </a>
                ) : (
                  <p className="text-slate-500">No source URL captured yet.</p>
                )}
              </div>
            </div>

            <div className="p-4 bg-slate-50 border-t border-slate-200 flex justify-end">
              <button
                type="button"
                onClick={() => setSelectedEvidence(null)}
                className="px-5 py-2.5 bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs rounded-xl cursor-pointer"
              >
                Close Evidence Window
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
};

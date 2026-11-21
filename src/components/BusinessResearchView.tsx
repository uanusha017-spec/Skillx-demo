import React, { useEffect, useRef, useState } from 'react';
import {
  Building2,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Copy,
  Download,
  ExternalLink,
  FileSpreadsheet,
  FileText,
  Globe,
  Loader2,
  Phone,
  RefreshCw,
  Search,
  Square,
  Trash2,
  Upload,
} from 'lucide-react';
import type { SchoolRecord, SearchEngineStatus } from '../types';
import {
  BUSINESS_INDUSTRIES_LIST,
  DOCUMENTS_CHECKLIST,
  GENERAL_DISCOVERY_QUESTIONS,
  getServiceAssessment,
  NATTON_SERVICE_GROUPS,
  NATTON_SERVICES,
  summarizeServiceAssessment,
} from '../data/nattonCatalog';
import { apiFetch, readJsonSafe } from '../services/apiClient';
import { appStore } from '../services/appStore';
import {
  exportBusinessResearchExcel,
  exportBusinessResearchPdf,
  exportCustomerDiscussionGuidePdf,
} from '../utils/exportSuite';
import { formatIST, formatLocation, hasValidPhone, isBusinessRecord, safeExternalUrl } from '../utils/schoolHelpers';

interface BusinessResearchViewProps {
  schools: SchoolRecord[];
  onUpload: () => void;
  autoRunQueueTrigger?: number;
}

export const BusinessResearchView: React.FC<BusinessResearchViewProps> = ({
  schools,
  onUpload,
  autoRunQueueTrigger = 0,
}) => {
  const [engineStatus, setEngineStatus] = useState<SearchEngineStatus | null>(null);
  const [exportingPdf, setExportingPdf] = useState(false);
  const [contactFilter, setContactFilter] = useState<'ALL' | 'HAS_CONTACT' | 'MISSING_PHONE' | 'ANALYZED'>('ALL');
  const [industryFilter, setIndustryFilter] = useState('ALL');
  const [serviceFilter, setServiceFilter] = useState('ALL');
  const [serviceStateFilter, setServiceStateFilter] = useState<'ALL' | 'MISSING_OR_SEEKING' | 'ACTIVELY_SEEKING' | 'HAS_SERVICE' | 'NEEDS_UPGRADE'>('ALL');
  const [matrixTab, setMatrixTab] = useState<'ALL' | 'MISSING_OR_SEEKING' | 'HAS_SERVICE' | 'NEEDS_UPGRADE' | 'INTERNAL'>('ALL');
  const [uploadFilter, setUploadFilter] = useState('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [overrideWebsite, setOverrideWebsite] = useState('');
  const [copiedPitchId, setCopiedPitchId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [confirmDeleteFiltered, setConfirmDeleteFiltered] = useState(false);

  // Discovery form state
  const [discoverIndustry, setDiscoverIndustry] = useState('Healthcare');
  const [customIndustry, setCustomIndustry] = useState('');
  const [discoverServiceId, setDiscoverServiceId] = useState('ALL');
  const [discoverLocation, setDiscoverLocation] = useState('');
  const [discovering, setDiscovering] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [latestDiscovery, setLatestDiscovery] = useState<{
    records: SchoolRecord[];
    industry: string;
    location: string;
    serviceId: string;
  } | null>(null);

  // Bounded batch runner for industry analysis / missing phone lookup
  const [busyRecordId, setBusyRecordId] = useState<string | null>(null);
  const [batchRunner, setBatchRunner] = useState<{
    active: boolean;
    mode: 'INDUSTRY' | 'PHONES' | null;
    done: number;
    total: number;
    currentName: string;
  }>({ active: false, mode: null, done: 0, total: 0, currentName: '' });
  const stopBatchRef = useRef(false);

  useEffect(() => {
    apiFetch('/api/research/status')
      .then((r) => readJsonSafe<SearchEngineStatus>(r))
      .then((s) => {
        if (s && typeof s.ready === 'boolean') setEngineStatus(s);
      })
      .catch(() => {});
  }, []);

  // Poll backend while server background queue is analyzing discovered businesses
  const serverActiveCount = schools.filter((s) => s.analysisStatus === 'CHECKING' || s.analysisStatus === 'QUEUED').length;
  useEffect(() => {
    if (serverActiveCount === 0) return;
    const timer = setInterval(() => {
      void appStore.fetchFromBackend();
    }, 2500);
    return () => clearInterval(timer);
  }, [serverActiveCount]);

  // Auto-trigger enrichment when user imports Excel with autoAnalyzeIndustry / autoFetchMissingPhones
  const lastTriggerRef = useRef(0);
  useEffect(() => {
    if (autoRunQueueTrigger > 0 && autoRunQueueTrigger !== lastTriggerRef.current) {
      lastTriggerRef.current = autoRunQueueTrigger;
      const pending = schools.filter((s) => !s.industryAnalysis && s.analysisStatus === 'QUEUED');
      if (pending.length > 0 && !batchRunner.active) {
        void runBatchIndustryAnalysis(pending);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRunQueueTrigger]);

  const uploads = appStore
    .getUploadHistory()
    .filter((u) => u.recordType === 'BUSINESS' || u.records.some(isBusinessRecord));
  const activeUploadIds =
    uploadFilter === 'ALL'
      ? null
      : new Set(uploads.find((u) => u.id === uploadFilter)?.records.map((r) => r.id));

  const uniqueIndustries = Array.from(new Set(schools.map((s) => s.industry || 'General Business'))).sort();

  const filtered = schools.filter((s) => {
    if (activeUploadIds && !activeUploadIds.has(s.id)) return false;
    if (industryFilter !== 'ALL' && (s.industry || 'General Business') !== industryFilter) return false;
    if (contactFilter === 'HAS_CONTACT' && !hasValidPhone(s.contactPhone) && !s.contactEmail) return false;
    if (contactFilter === 'MISSING_PHONE' && hasValidPhone(s.contactPhone)) return false;
    if (contactFilter === 'ANALYZED' && !s.industryAnalysis) return false;
    if (serviceFilter !== 'ALL' || serviceStateFilter !== 'ALL') {
      const assess = getServiceAssessment(s);
      const targetItems =
        serviceFilter === 'ALL'
          ? assess.services
          : assess.services.filter((srv) => srv.id === serviceFilter);
      if (serviceStateFilter === 'MISSING_OR_SEEKING') {
        if (!targetItems.some((srv) => srv.demandState === 'MISSING_NEEDED' || srv.demandState === 'ACTIVELY_SEEKING')) return false;
      } else if (serviceStateFilter === 'ACTIVELY_SEEKING') {
        if (!targetItems.some((srv) => srv.demandState === 'ACTIVELY_SEEKING')) return false;
      } else if (serviceStateFilter === 'HAS_SERVICE') {
        if (!targetItems.some((srv) => srv.demandState === 'HAS_SERVICE')) return false;
      } else if (serviceStateFilter === 'NEEDS_UPGRADE') {
        if (!targetItems.some((srv) => srv.demandState === 'NEEDS_UPGRADE')) return false;
      }
    }
    if (searchQuery.trim()) {
      const hay = `${s.name} ${s.industry || ''} ${s.area} ${s.city} ${s.contactPhone || ''}`.toLowerCase();
      if (!hay.includes(searchQuery.trim().toLowerCase())) return false;
    }
    return true;
  });

  const missingPhoneRecords = filtered.filter((s) => !hasValidPhone(s.contactPhone));
  const unanalyzedRecords = filtered.filter((s) => !s.industryAnalysis);
  const analyzedCount = schools.filter((s) => Boolean(s.industryAnalysis)).length;
  const queuedCount = schools.filter((s) => s.analysisStatus === 'QUEUED' || s.analysisStatus === 'CHECKING').length;

  async function handleDiscover(e: React.FormEvent) {
    e.preventDefault();
    const chosenIndustry =
      discoverIndustry === 'Other / Custom Industry' ? customIndustry.trim() : discoverIndustry;
    if (!chosenIndustry || !discoverLocation.trim()) return;

    setDiscovering(true);
    setStatusMessage('');
    try {
      const resp = await apiFetch('/api/discover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          industry: chosenIndustry,
          location: discoverLocation.trim(),
          serviceId: discoverServiceId,
        }),
      });
      const data = await readJsonSafe<{ added?: number; records?: SchoolRecord[]; error?: string }>(resp);
      if (!resp.ok) throw new Error(data.error || 'Google discovery failed.');
      const recs = Array.isArray(data.records) ? data.records : [];
      appStore.acceptDiscoveredRecords(recs);
      setLatestDiscovery({
        records: recs,
        industry: chosenIndustry,
        location: discoverLocation.trim(),
        serviceId: discoverServiceId,
      });
      setSearchQuery('');
      setIndustryFilter('ALL');
      setUploadFilter('ALL');
      setContactFilter('ALL');
      setServiceFilter(discoverServiceId);
      setServiceStateFilter('ALL');
      await appStore.fetchFromBackend();
      setStatusMessage(
        data.added
          ? `${data.added} real ${chosenIndustry} businesses discovered on Google and saved. Industry-specific analysis & contact verification are running automatically.`
          : recs.length
          ? `${recs.length} matching businesses found (already in register).`
          : 'No matching businesses returned. Try a broader locality or industry.'
      );
    } catch (err) {
      setStatusMessage(err instanceof Error ? err.message : 'Discovery failed.');
    } finally {
      setDiscovering(false);
    }
  }

  async function analyzeSingleRecord(record: SchoolRecord, customWebsite?: string) {
    setBusyRecordId(record.id);
    setStatusMessage('');
    try {
      // Ensure record exists on server first
      appStore.syncToBackend(true);
      await new Promise((r) => setTimeout(r, 150));
      const resp = await apiFetch(`/api/analyze/${encodeURIComponent(record.id)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ website: customWebsite || undefined, immediate: true, businessOnly: true }),
      });
      const data = await readJsonSafe<{ record?: SchoolRecord; error?: string }>(resp);
      if (!resp.ok) throw new Error(data.error || 'Industry analysis failed.');
      if (data.record) {
        appStore.updateSchool(data.record, true);
      } else {
        await appStore.fetchFromBackend();
      }
      setOverrideWebsite('');
    } catch (err) {
      setStatusMessage(err instanceof Error ? err.message : 'Could not analyze business.');
    } finally {
      setBusyRecordId(null);
    }
  }

  async function fetchPhoneForSingleRecord(record: SchoolRecord) {
    setBusyRecordId(record.id);
    setStatusMessage('');
    try {
      const resp = await apiFetch('/api/enrich-contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recordId: record.id,
          name: record.name,
          industry: record.industry,
          area: record.area,
          city: record.city,
          state: record.state,
          website: record.website,
          existingPhone: record.contactPhone,
          existingEmail: record.contactEmail,
        }),
      });
      const data = await readJsonSafe<{
        result?: {
          contactPhone?: string;
          contactPhoneSource?: SchoolRecord['contactPhoneSource'];
          contactPhoneSourceUrl?: string;
          contactEmail?: string;
          contactEmailSource?: SchoolRecord['contactEmailSource'];
          website?: string;
          address?: string;
          contactPerson?: string;
        };
        error?: string;
      }>(resp);
      if (!resp.ok) throw new Error(data.error || 'Google contact lookup failed.');
      if (data.result) {
        appStore.updateSchool(
          {
            ...record,
            contactPhone: data.result.contactPhone || record.contactPhone,
            contactPhoneSource: data.result.contactPhoneSource || record.contactPhoneSource,
            contactPhoneSourceUrl: data.result.contactPhoneSourceUrl || record.contactPhoneSourceUrl,
            contactEmail: data.result.contactEmail || record.contactEmail,
            contactEmailSource: data.result.contactEmailSource || record.contactEmailSource,
            website: record.website || data.result.website,
            address: record.address || data.result.address,
            contactPerson: record.contactPerson || data.result.contactPerson,
          },
          true
        );
        setStatusMessage(
          data.result.contactPhone
            ? `Fetched contact number ${data.result.contactPhone} for ${record.name} from Google.`
            : `Google search completed for ${record.name}; no public phone number listed.`
        );
      }
    } catch (err) {
      setStatusMessage(err instanceof Error ? err.message : 'Contact lookup failed.');
    } finally {
      setBusyRecordId(null);
    }
  }

  async function runBatchMissingPhones(targets: SchoolRecord[]) {
    if (!targets.length) return;
    stopBatchRef.current = false;
    setBatchRunner({ active: true, mode: 'PHONES', done: 0, total: targets.length, currentName: targets[0].name });
    let foundCount = 0;
    let rateLimitedMsg = '';

    for (let i = 0; i < targets.length; i++) {
      if (stopBatchRef.current) break;
      const rec = targets[i];
      setBatchRunner({ active: true, mode: 'PHONES', done: i, total: targets.length, currentName: rec.name });
      try {
        const resp = await apiFetch('/api/enrich-contact', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            recordId: rec.id,
            name: rec.name,
            industry: rec.industry,
            area: rec.area,
            city: rec.city,
            state: rec.state,
            website: rec.website,
            existingPhone: rec.contactPhone,
            existingEmail: rec.contactEmail,
          }),
        });
        const data = await readJsonSafe<{
          result?: {
            contactPhone?: string;
            contactPhoneSource?: SchoolRecord['contactPhoneSource'];
            contactPhoneSourceUrl?: string;
            contactEmail?: string;
            contactEmailSource?: SchoolRecord['contactEmailSource'];
            website?: string;
            address?: string;
            contactPerson?: string;
          };
          error?: string;
          code?: string;
        }>(resp);
        if (resp.status === 429 || data.code === 'RATE_LIMITED') {
          rateLimitedMsg = data.error || 'Rate limit reached — paused safely. Please retry in a few seconds.';
          break;
        }
        if (resp.ok && data.result) {
          if (data.result.contactPhone) foundCount++;
          appStore.updateSchool(
            {
              ...rec,
              contactPhone: data.result.contactPhone || rec.contactPhone,
              contactPhoneSource: data.result.contactPhoneSource || rec.contactPhoneSource,
              contactPhoneSourceUrl: data.result.contactPhoneSourceUrl || rec.contactPhoneSourceUrl,
              contactEmail: data.result.contactEmail || rec.contactEmail,
              contactEmailSource: data.result.contactEmailSource || rec.contactEmailSource,
              website: rec.website || data.result.website,
              address: rec.address || data.result.address,
              contactPerson: rec.contactPerson || data.result.contactPerson,
            },
            true
          );
        }
      } catch {
        // continue bounded loop
      }
      await new Promise((r) => setTimeout(r, 280));
    }

    setBatchRunner({ active: false, mode: null, done: targets.length, total: targets.length, currentName: '' });
    setStatusMessage(
      rateLimitedMsg ||
        `Contact enrichment complete: checked ${targets.length} record(s) missing phone numbers and fetched ${foundCount} phone number(s) from Google.`
    );
  }

  async function runBatchIndustryAnalysis(targets: SchoolRecord[]) {
    if (!targets.length) return;
    stopBatchRef.current = false;
    appStore.syncToBackend(true);
    await new Promise((r) => setTimeout(r, 250));
    setBatchRunner({ active: true, mode: 'INDUSTRY', done: 0, total: targets.length, currentName: targets[0].name });
    let completed = 0;
    let rateLimitedMsg = '';

    for (let i = 0; i < targets.length; i++) {
      if (stopBatchRef.current) break;
      const rec = targets[i];
      setBatchRunner({ active: true, mode: 'INDUSTRY', done: i, total: targets.length, currentName: rec.name });
      try {
        const resp = await apiFetch(`/api/analyze/${encodeURIComponent(rec.id)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ immediate: true, businessOnly: true }),
        });
        const data = await readJsonSafe<{ record?: SchoolRecord; error?: string; code?: string }>(resp);
        if (resp.status === 429 || data.code === 'RATE_LIMITED') {
          rateLimitedMsg = data.error || 'Rate limit reached — paused safely. Please retry in a few seconds.';
          break;
        }
        if (resp.ok && data.record) {
          appStore.updateSchool(data.record, true);
          completed++;
        }
      } catch {
        // continue bounded loop
      }
      await new Promise((r) => setTimeout(r, 350));
    }

    setBatchRunner({ active: false, mode: null, done: targets.length, total: targets.length, currentName: '' });
    setStatusMessage(
      rateLimitedMsg ||
        `Industry analysis finished: analyzed ${completed} of ${targets.length} organization(s) with industry benchmarks and Google contact lookup.`
    );
  }

  const handleCopyPitch = (id: string, pitch: string) => {
    void navigator.clipboard?.writeText(pitch);
    setCopiedPitchId(id);
    setTimeout(() => setCopiedPitchId(null), 2000);
  };

  return (
    <div className="space-y-6">
      {/* Hero Summary Section */}
      <section className="rounded-3xl bg-slate-950 text-white p-6 sm:p-8 space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-2 max-w-2xl">
            <p className="text-xs font-semibold tracking-wider text-blue-300">
              Business intelligence &amp; industry analysis
            </p>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-balance">
              Find the next opportunity.
            </h1>
            <p className="text-sm text-slate-300 leading-relaxed">
              Import a business Excel list or discover commercial businesses by industry and location. Missing contact numbers are fetched automatically from Google and every business is analyzed specifically for its industry (schools stay separated in School Labs &amp; Route).
            </p>
          </div>
          <button
            type="button"
            onClick={onUpload}
            className="bg-blue-600 hover:bg-blue-500 text-white rounded-xl px-4 py-3 text-xs sm:text-sm font-bold flex gap-2 items-center whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Upload className="w-4 h-4" />
            <span>Import Business Excel</span>
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs sm:text-sm text-slate-300 pt-1 border-t border-slate-800/80 tabular-nums">
          <span>
            <strong className="text-white">{schools.length}</strong> saved businesses
          </span>
          <span aria-hidden="true" className="text-slate-600">·</span>
          <span>
            <strong className="text-emerald-300">{analyzedCount}</strong> industry-analyzed
          </span>
          <span aria-hidden="true" className="text-slate-600">·</span>
          <span>
            <strong className="text-amber-300">{schools.filter((s) => !hasValidPhone(s.contactPhone)).length}</strong> missing phone
          </span>
          <span aria-hidden="true" className="text-slate-600">·</span>
          <span>
            <strong className="text-blue-300">{queuedCount}</strong> pending
          </span>
        </div>

        {/* Read-only server search engine status strip (no API key inputs) */}
        <div className="rounded-2xl bg-slate-900/90 border border-slate-800 px-4 py-3 flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-2 text-slate-200">
            <CheckCircle2 className={`w-4 h-4 shrink-0 ${engineStatus?.ready ? 'text-emerald-400' : 'text-amber-400'}`} />
            <span className="font-semibold">
              {engineStatus?.label || 'Checking server-side Google Search engine...'}
            </span>
          </div>
          <span className="text-slate-400 text-[11px]">
            Server-managed search access · Business register isolated from schools
          </span>
        </div>
      </section>

      {/* Discover Businesses on Google Form */}
      <form
        onSubmit={handleDiscover}
        className="bg-white p-5 sm:p-6 rounded-2xl border border-slate-200 space-y-4 shadow-2xs"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-bold text-slate-900 flex items-center gap-2 text-base">
            <Search className="w-4 h-4 text-blue-600" />
            <span>Discover businesses on Google by Industry</span>
          </h2>
          <button
            type="button"
            onClick={() => exportCustomerDiscussionGuidePdf()}
            className="border border-slate-300 bg-white hover:bg-slate-50 text-slate-800 rounded-xl px-3.5 py-2 text-xs font-bold flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
          >
            <FileText className="w-3.5 h-3.5 text-blue-600" />
            <span>Customer Discussion Guide (PDF)</span>
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <label className="text-xs font-bold text-slate-700 block">
            Industry (tailors the entire business analysis)
            <select
              aria-label="Discovery industry"
              value={discoverIndustry}
              onChange={(e) => setDiscoverIndustry(e.target.value)}
              className="mt-1.5 w-full border border-slate-300 rounded-xl p-2.5 text-sm font-medium bg-white"
            >
              {BUSINESS_INDUSTRIES_LIST.map((ind) => (
                <option key={ind} value={ind}>
                  {ind}
                </option>
              ))}
            </select>
          </label>

          <label className="text-xs font-bold text-slate-700 block">
            Natton service / product focus
            <select
              aria-label="Discovery service"
              value={discoverServiceId}
              onChange={(e) => setDiscoverServiceId(e.target.value)}
              className="mt-1.5 w-full border border-slate-300 rounded-xl p-2.5 text-sm font-medium bg-white"
            >
              <option value="ALL">All services &amp; products</option>
              {NATTON_SERVICE_GROUPS.map((group) => (
                <optgroup key={group} label={group}>
                  {NATTON_SERVICES.filter((s) => s.group === group).map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
        </div>

        {discoverIndustry === 'Other / Custom Industry' && (
          <label className="block text-xs font-bold text-slate-700">
            Custom industry
            <input
              aria-label="Custom discovery industry"
              required
              value={customIndustry}
              onChange={(e) => setCustomIndustry(e.target.value)}
              placeholder="e.g. Solar EPC Contractors, Montessori Schools, Diagnostic Labs"
              className="mt-1.5 w-full border border-slate-300 rounded-xl p-2.5 text-sm"
            />
          </label>
        )}

        <div className="flex flex-col sm:flex-row gap-3">
          <label className="flex-1 text-xs font-bold text-slate-700">
            City or locality
            <input
              required
              aria-label="City or locality"
              placeholder="e.g. Hubli, Karnataka or Indiranagar, Bengaluru"
              value={discoverLocation}
              onChange={(e) => setDiscoverLocation(e.target.value)}
              className="mt-1.5 w-full border border-slate-300 rounded-xl p-2.5 text-sm font-medium"
            />
          </label>
          <button
            type="submit"
            disabled={discovering}
            className="sm:self-end bg-slate-900 hover:bg-slate-800 disabled:opacity-50 text-white rounded-xl px-5 py-2.5 text-sm font-bold whitespace-nowrap cursor-pointer flex items-center justify-center gap-2"
          >
            {discovering && <Loader2 className="w-4 h-4 animate-spin" />}
            <span>{discovering ? 'Searching Google...' : 'Find & Save Businesses'}</span>
          </button>
        </div>
      </form>

      {/* Active Batch Enrichment Progress Bar */}
      {batchRunner.active && (
        <div className="p-4 bg-blue-50 border border-blue-200 rounded-2xl space-y-2">
          <div className="flex items-center justify-between gap-3 text-xs">
            <div className="font-bold text-blue-950 flex items-center gap-2 min-w-0">
              <Loader2 className="w-4 h-4 text-blue-600 animate-spin shrink-0" />
              <span className="truncate">
                {batchRunner.mode === 'PHONES'
                  ? `Fetching missing phone from Google (${batchRunner.done + 1}/${batchRunner.total}): ${batchRunner.currentName}`
                  : `Running Industry-Specific Analysis (${batchRunner.done + 1}/${batchRunner.total}): ${batchRunner.currentName}`}
              </span>
            </div>
            <button
              type="button"
              onClick={() => {
                stopBatchRef.current = true;
              }}
              className="px-3 py-1 bg-rose-600 hover:bg-rose-700 text-white rounded-lg font-bold flex items-center gap-1 shrink-0 cursor-pointer"
            >
              <Square className="w-3 h-3 fill-current" />
              <span>Stop</span>
            </button>
          </div>
          <div className="w-full h-2 bg-blue-200 rounded-full overflow-hidden">
            <div
              className="h-full bg-blue-600 transition-all duration-300"
              style={{
                width: `${batchRunner.total > 0 ? Math.round(((batchRunner.done + 1) / batchRunner.total) * 100) : 0}%`,
              }}
            />
          </div>
        </div>
      )}

      {statusMessage && (
        <div role="status" className="p-3.5 bg-blue-50 text-blue-950 border border-blue-200 rounded-2xl text-xs font-semibold">
          {statusMessage}
        </div>
      )}

      {/* Latest Discovery Preview */}
      {latestDiscovery && latestDiscovery.records.length > 0 && (
        <section className="bg-white border border-blue-200 rounded-2xl p-5 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h2 className="font-bold text-slate-900 text-base">
                Latest Google discovery · {latestDiscovery.records.length} businesses
              </h2>
              <p className="text-xs text-slate-500">
                {latestDiscovery.industry} · {latestDiscovery.location}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setLatestDiscovery(null)}
              className="text-xs font-semibold text-slate-500 hover:text-slate-900 cursor-pointer"
            >
              Hide preview
            </button>
          </div>
          <div className="grid md:grid-cols-2 gap-3">
            {latestDiscovery.records.slice(0, 6).map((item) => {
              const live = schools.find((s) => s.id === item.id) || item;
              return (
                <div key={live.id} className="border border-slate-200 rounded-xl p-3.5 space-y-1.5 text-xs">
                  <div className="flex items-start justify-between gap-2">
                    <span className="font-bold text-slate-900">{live.name}</span>
                    <span className="text-[11px] font-semibold text-blue-700 shrink-0">
                      {live.industryAnalysis ? `Analyzed (${live.industryAnalysis.maturityScore}/100)` : live.analysisStatus || 'Saved'}
                    </span>
                  </div>
                  <p className="text-slate-600">{live.address || `${live.area}, ${live.city}`}</p>
                  <p className="text-slate-700 font-mono">
                    Phone: {live.contactPhone || 'Looking up...'}
                  </p>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Filter & Bulk Action Toolbar */}
      <div className="bg-white border border-slate-200 rounded-2xl p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="relative flex-1 min-w-[220px]">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by business name, industry, city, or phone..."
              className="w-full pl-9 pr-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs focus:outline-none focus:border-blue-500"
            />
          </div>

          <select
            aria-label="Filter by industry"
            value={industryFilter}
            onChange={(e) => setIndustryFilter(e.target.value)}
            className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold text-slate-700"
          >
            <option value="ALL">All Industries ({schools.length})</option>
            {uniqueIndustries.map((ind) => (
              <option key={ind} value={ind}>
                {ind} ({schools.filter((s) => (s.industry || 'General Business') === ind).length})
              </option>
            ))}
          </select>

          <select
            aria-label="Filter by status"
            value={contactFilter}
            onChange={(e) => setContactFilter(e.target.value as typeof contactFilter)}
            className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold text-slate-700"
          >
            <option value="ALL">All Records</option>
            <option value="MISSING_PHONE">Missing Phone ({schools.filter((s) => !hasValidPhone(s.contactPhone)).length})</option>
            <option value="HAS_CONTACT">Has Contact Info</option>
            <option value="ANALYZED">Industry-Analyzed ({analyzedCount})</option>
          </select>

          <select
            aria-label="Filter by Natton service"
            value={serviceFilter}
            onChange={(e) => setServiceFilter(e.target.value)}
            className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold text-slate-700 max-w-[240px]"
          >
            <option value="ALL">Check All 27 Services</option>
            {NATTON_SERVICE_GROUPS.map((group) => (
              <optgroup key={group} label={group}>
                {NATTON_SERVICES.filter((s) => s.group === group).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>

          <select
            aria-label="Filter by service availability"
            value={serviceStateFilter}
            onChange={(e) => setServiceStateFilter(e.target.value as typeof serviceStateFilter)}
            className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold text-slate-700"
          >
            <option value="ALL">All Service Findings</option>
            <option value="MISSING_OR_SEEKING">Missing / Needs Service</option>
            <option value="ACTIVELY_SEEKING">High Need / Seeking</option>
            <option value="HAS_SERVICE">Already Has Service</option>
            <option value="NEEDS_UPGRADE">Needs Upgrade</option>
          </select>

          {uploads.length > 0 && (
            <select
              aria-label="Filter by upload batch"
              value={uploadFilter}
              onChange={(e) => setUploadFilter(e.target.value)}
              className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold text-slate-700 max-w-[200px]"
            >
              <option value="ALL">All Upload Batches</option>
              {uploads.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.filename} ({u.recordsCount})
                </option>
              ))}
            </select>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-100">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={batchRunner.active || missingPhoneRecords.length === 0}
              onClick={() => void runBatchMissingPhones(missingPhoneRecords)}
              className="px-3.5 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40 text-white font-bold text-xs rounded-xl flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
            >
              <Phone className="w-3.5 h-3.5" />
              <span>Fetch Missing Phones from Google ({missingPhoneRecords.length})</span>
            </button>

            <button
              type="button"
              disabled={batchRunner.active || unanalyzedRecords.length === 0}
              onClick={() => void runBatchIndustryAnalysis(unanalyzedRecords)}
              className="px-3.5 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white font-bold text-xs rounded-xl flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
            >
              <Building2 className="w-3.5 h-3.5" />
              <span>Analyze by Industry ({unanalyzedRecords.length})</span>
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={filtered.length === 0}
              onClick={() => exportBusinessResearchExcel(filtered)}
              className="px-3 py-2 bg-white border border-slate-300 hover:bg-slate-50 disabled:opacity-40 text-slate-800 font-bold text-xs rounded-xl flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
            >
              <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-600" />
              <span>Export Excel ({filtered.length})</span>
            </button>
            <button
              type="button"
              disabled={filtered.length === 0 || exportingPdf}
              onClick={() => {
                setExportingPdf(true);
                try {
                  exportBusinessResearchPdf(filtered);
                } finally {
                  setExportingPdf(false);
                }
              }}
              className="px-3 py-2 bg-white border border-slate-300 hover:bg-slate-50 disabled:opacity-40 text-slate-800 font-bold text-xs rounded-xl flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
            >
              <Download className="w-3.5 h-3.5 text-blue-600" />
              <span>{exportingPdf ? 'Generating...' : 'Export PDF'}</span>
            </button>

            {filtered.length > 0 && (
              confirmDeleteFiltered ? (
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      const ids = filtered.map((r) => r.id);
                      appStore.deleteRecords(ids);
                      setLatestDiscovery((prev) =>
                        prev ? { ...prev, records: prev.records.filter((r) => !ids.includes(r.id)) } : null
                      );
                      setConfirmDeleteFiltered(false);
                      setUploadFilter('ALL');
                    }}
                    className="px-3 py-2 bg-rose-600 hover:bg-rose-700 text-white font-bold text-xs rounded-xl whitespace-nowrap cursor-pointer"
                  >
                    Confirm Delete ({filtered.length})
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmDeleteFiltered(false)}
                    className="px-2.5 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-xs rounded-xl cursor-pointer"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  disabled={batchRunner.active}
                  onClick={() => setConfirmDeleteFiltered(true)}
                  className="px-3 py-2 bg-white border border-rose-200 hover:bg-rose-50 disabled:opacity-40 text-rose-700 font-bold text-xs rounded-xl flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>Delete Shown ({filtered.length})</span>
                </button>
              )
            )}
          </div>
        </div>
      </div>

      {/* Business Records List */}
      {filtered.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-3xl p-10 text-center space-y-3">
          <Building2 className="w-10 h-10 text-slate-300 mx-auto" />
          <h3 className="font-bold text-slate-900 text-base">No commercial businesses in this register yet</h3>
          <p className="text-xs text-slate-500 max-w-md mx-auto">
            Discover real businesses by industry above or import a business Excel sheet. Uploaded schools are managed separately in the School Labs &amp; Route tab.
          </p>
          <button
            type="button"
            onClick={onUpload}
            className="px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs rounded-xl cursor-pointer"
          >
            Upload Business Excel
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((record) => {
            const isExpanded = expandedId === record.id;
            const isBusy = busyRecordId === record.id;
            const phoneOk = hasValidPhone(record.contactPhone);
            const assessment = getServiceAssessment(record);
            const svcSummary = summarizeServiceAssessment(assessment);
            const focusedServiceId = serviceFilter !== 'ALL' ? serviceFilter : record.targetServiceId || 'ALL';
            const focusedService =
              focusedServiceId !== 'ALL'
                ? assessment.services.find((srv) => srv.id === focusedServiceId) || null
                : null;
            const ia = record.industryAnalysis;
            const safeWeb = safeExternalUrl(record.website || record.digitalAudit?.websiteUrl);

            const demandBadge = (d?: string) => {
              if (d === 'HAS_SERVICE') return { label: 'Already Has', cls: 'bg-emerald-50 text-emerald-800 border-emerald-200' };
              if (d === 'ACTIVELY_SEEKING') return { label: 'High Need / Seeking', cls: 'bg-rose-50 text-rose-800 border-rose-200' };
              if (d === 'MISSING_NEEDED') return { label: 'Missing (Opportunity)', cls: 'bg-amber-50 text-amber-900 border-amber-200' };
              if (d === 'NEEDS_UPGRADE') return { label: 'Needs Upgrade', cls: 'bg-blue-50 text-blue-800 border-blue-200' };
              return { label: 'Verify in Call', cls: 'bg-slate-100 text-slate-700 border-slate-200' };
            };

            return (
              <article
                key={record.id}
                className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-2xs"
              >
                <div className="p-4 sm:p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                  <div className="space-y-1.5 min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <h3 className="font-bold text-slate-900 text-base">{record.name}</h3>
                      <span className="text-xs font-semibold text-blue-700">
                        · {record.industry || 'General Business'}
                        {ia?.subCategory && ia.subCategory !== record.industry ? ` (${ia.subCategory})` : ''}
                      </span>
                    </div>

                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-600">
                      <span>{formatLocation(record.name, record.area, record.city, record.state)}</span>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono">
                        {phoneOk ? (
                          <>
                            <strong className="text-slate-900">{record.contactPhone}</strong>{' '}
                            <span className="text-[11px] font-sans text-emerald-700 font-semibold">
                              ({record.contactPhoneSource || 'Uploaded Excel'})
                            </span>
                          </>
                        ) : (
                          <span className="text-amber-700 font-sans font-semibold">
                            Phone missing
                          </span>
                        )}
                      </span>
                      {record.contactEmail && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="font-mono text-slate-700">{record.contactEmail}</span>
                        </>
                      )}
                    </div>

                    {ia && (
                      <p className="text-xs text-slate-600 line-clamp-2 pt-0.5">{ia.executiveSummary}</p>
                    )}

                    {/* Accurate 27-Service Audit Summary Strip (All Services or Selected Service Focus) */}
                    <div className="pt-1.5 flex flex-wrap items-center gap-2 text-[11px]">
                      {focusedService && (
                        <div className={`px-2.5 py-1 rounded-lg border font-bold inline-flex items-center gap-1.5 ${demandBadge(focusedService.demandState).cls}`}>
                          <span>{focusedService.name}:</span>
                          <span>{demandBadge(focusedService.demandState).label}</span>
                        </div>
                      )}
                      {record.digitalAudit ? (
                        <div className="flex flex-wrap items-center gap-2 text-slate-600 font-medium tabular-nums">
                          <span className="text-emerald-700 font-bold">Has: {svcSummary.hasService}</span>
                          <span>·</span>
                          <span className="text-rose-700 font-bold">High Need/Seeking: {svcSummary.activelySeeking}</span>
                          <span>·</span>
                          <span className="text-amber-800 font-bold">Missing: {svcSummary.missingNeeded}</span>
                          <span>·</span>
                          <span className="text-blue-700 font-bold">Upgrade: {svcSummary.needsUpgrade}</span>
                          <span>·</span>
                          <span className="text-slate-500">Verify: {svcSummary.internalCheck}</span>
                        </div>
                      ) : (
                        <span className="text-slate-500 font-medium">
                          {record.analysisStatus === 'CHECKING' || record.analysisStatus === 'QUEUED'
                            ? 'Scanning website & directory across all 27 Natton services...'
                            : 'Click Analyze Industry to scan all 27 services against live website & search data.'}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    {ia && (
                      <div className="px-3 py-1.5 bg-slate-50 border border-slate-200 rounded-xl text-xs font-mono tabular-nums">
                        <span className="font-bold text-slate-900">{ia.maturityScore}/100</span>{' '}
                        <span className="text-slate-500 font-sans">· {ia.maturityLabel}</span>
                      </div>
                    )}

                    {!phoneOk && (
                      <button
                        type="button"
                        disabled={isBusy || batchRunner.active}
                        onClick={() => void fetchPhoneForSingleRecord(record)}
                        className="px-3 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-xs font-bold rounded-xl flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
                      >
                        {isBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Phone className="w-3.5 h-3.5" />}
                        <span>Fetch Phone</span>
                      </button>
                    )}

                    <button
                      type="button"
                      disabled={isBusy || batchRunner.active}
                      onClick={() => void analyzeSingleRecord(record)}
                      className="px-3 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-xs font-bold rounded-xl flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${isBusy ? 'animate-spin' : ''}`} />
                      <span>{ia ? 'Re-Analyze' : 'Analyze Industry'}</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => setExpandedId(isExpanded ? null : record.id)}
                      className="px-3 py-2 bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs font-bold rounded-xl flex items-center gap-1 whitespace-nowrap cursor-pointer"
                    >
                      <span>{isExpanded ? 'Hide Details' : 'Inspect Report'}</span>
                      {isExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                    </button>

                    {confirmDeleteId === record.id ? (
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => {
                            appStore.deleteRecord(record.id);
                            setConfirmDeleteId(null);
                            if (expandedId === record.id) setExpandedId(null);
                            setLatestDiscovery((prev) =>
                              prev ? { ...prev, records: prev.records.filter((r) => r.id !== record.id) } : null
                            );
                          }}
                          className="px-2.5 py-2 bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold rounded-xl cursor-pointer"
                        >
                          Delete
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(null)}
                          className="px-2.5 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold rounded-xl cursor-pointer"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        aria-label={`Delete ${record.name}`}
                        disabled={isBusy || batchRunner.active}
                        onClick={() => setConfirmDeleteId(record.id)}
                        className="p-2 text-slate-400 hover:text-rose-600 hover:bg-rose-50 disabled:opacity-40 rounded-xl cursor-pointer"
                        title="Delete business"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                </div>

                {/* Expanded Full Industry Analysis + Contacts + 27 Services Matrix */}
                {isExpanded && (
                  <div className="border-t border-slate-200 bg-slate-50/70 p-4 sm:p-6 space-y-6">
                    {/* Quick Industry Override + Website Recheck Bar */}
                    <div className="flex flex-wrap items-end gap-3 bg-white p-4 rounded-2xl border border-slate-200">
                      <label className="text-xs font-bold text-slate-700">
                        Change Industry for Tailored Analysis
                        <select
                          value={BUSINESS_INDUSTRIES_LIST.includes(record.industry) ? record.industry : 'Other / Custom Industry'}
                          onChange={(e) => {
                            const nextInd = e.target.value;
                            if (nextInd !== 'Other / Custom Industry') {
                              appStore.updateSchool({ ...record, industry: nextInd });
                            }
                          }}
                          className="mt-1 block border border-slate-300 rounded-xl px-3 py-2 text-xs font-semibold bg-white"
                        >
                          {BUSINESS_INDUSTRIES_LIST.map((ind) => (
                            <option key={ind} value={ind}>
                              {ind}
                            </option>
                          ))}
                        </select>
                      </label>

                      <label className="flex-1 min-w-[200px] text-xs font-bold text-slate-700">
                        Override Website URL (optional)
                        <input
                          type="url"
                          value={overrideWebsite}
                          onChange={(e) => setOverrideWebsite(e.target.value)}
                          placeholder={safeWeb || 'https://example.com'}
                          className="mt-1 w-full border border-slate-300 rounded-xl px-3 py-2 text-xs"
                        />
                      </label>

                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => void analyzeSingleRecord(record, overrideWebsite || undefined)}
                        className="px-4 py-2 bg-slate-900 hover:bg-slate-800 disabled:opacity-50 text-white text-xs font-bold rounded-xl whitespace-nowrap cursor-pointer"
                      >
                        {isBusy ? 'Analyzing...' : `Run ${record.industry || 'Industry'} Analysis`}
                      </button>
                    </div>

                    {/* Industry-Specific Analysis Section */}
                    {ia ? (
                      <section className="bg-white border border-slate-200 rounded-2xl p-5 space-y-5">
                        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-100 pb-4">
                          <div className="space-y-1">
                            <p className="text-xs font-bold text-blue-700">
                              Industry-Specific Analysis · {ia.industry}
                              {ia.subCategory ? ` / ${ia.subCategory}` : ''}
                            </p>
                            <h4 className="text-lg font-bold text-slate-900">{record.name}</h4>
                            <p className="text-xs text-slate-500">Analyzed {formatIST(ia.analyzedAt)}</p>
                          </div>
                          <div className="text-right font-mono tabular-nums">
                            <div className="text-2xl font-extrabold text-slate-900">{ia.maturityScore}/100</div>
                            <div className="text-xs font-sans font-semibold text-slate-600">{ia.maturityLabel}</div>
                          </div>
                        </div>

                        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 text-xs">
                          <div className="p-4 bg-slate-50 rounded-xl border border-slate-200 space-y-1.5">
                            <h5 className="font-bold text-slate-900">Executive Summary</h5>
                            <p className="text-slate-700 leading-relaxed">{ia.executiveSummary}</p>
                          </div>
                          <div className="p-4 bg-slate-50 rounded-xl border border-slate-200 space-y-1.5">
                            <h5 className="font-bold text-slate-900">{ia.industry} Market Benchmark Context</h5>
                            <p className="text-slate-700 leading-relaxed">{ia.industryContext}</p>
                          </div>
                        </div>

                        {/* Industry Benchmarks Table */}
                        <div className="space-y-2">
                          <h5 className="font-bold text-sm text-slate-900">
                            {ia.industry} Evaluation Criteria &amp; Findings
                          </h5>
                          <div className="overflow-x-auto border border-slate-200 rounded-xl">
                            <table className="w-full text-left text-xs">
                              <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
                                <tr>
                                  <th className="p-3 font-bold">Industry Criterion</th>
                                  <th className="p-3 font-bold">Status</th>
                                  <th className="p-3 font-bold">Observed Finding</th>
                                  <th className="p-3 font-bold">Business Impact</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-slate-100">
                                {ia.benchmarks.map((b, i) => (
                                  <tr key={i}>
                                    <td className="p-3 font-bold text-slate-900">{b.criterion}</td>
                                    <td className="p-3 whitespace-nowrap">
                                      <span
                                        className={`font-bold ${
                                          b.status === 'Strong'
                                            ? 'text-emerald-700'
                                            : b.status === 'Partial'
                                            ? 'text-blue-700'
                                            : b.status === 'Gap'
                                            ? 'text-rose-700'
                                            : 'text-amber-700'
                                        }`}
                                      >
                                        {b.status}
                                      </span>
                                    </td>
                                    <td className="p-3 text-slate-700">{b.finding}</td>
                                    <td className="p-3 text-slate-600">{b.impact}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </div>

                        {/* Strengths & Gaps */}
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
                          <div className="p-4 bg-emerald-50/60 border border-emerald-200 rounded-xl space-y-2">
                            <h5 className="font-bold text-emerald-950">Observed Strengths</h5>
                            <ul className="space-y-1 text-emerald-900">
                              {ia.strengths.length ? (
                                ia.strengths.map((s, idx) => <li key={idx}>• {s}</li>)
                              ) : (
                                <li>• Confirm strengths during discovery call.</li>
                              )}
                            </ul>
                          </div>
                          <div className="p-4 bg-amber-50/60 border border-amber-200 rounded-xl space-y-2">
                            <h5 className="font-bold text-amber-950">{ia.industry}-Specific Gaps</h5>
                            <ul className="space-y-1 text-amber-900">
                              {ia.gaps.length ? (
                                ia.gaps.map((g, idx) => <li key={idx}>• {g}</li>)
                              ) : (
                                <li>• No major public gaps identified.</li>
                              )}
                            </ul>
                          </div>
                        </div>

                        {/* Recommended Natton Services for this Industry */}
                        <div className="space-y-2">
                          <h5 className="font-bold text-sm text-slate-900">
                            Recommended Natton Services for {record.name} ({ia.industry})
                          </h5>
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                            {ia.recommendedServices.map((rec, idx) => (
                              <div key={idx} className="p-3.5 border border-slate-200 rounded-xl bg-slate-50/50 space-y-1 text-xs">
                                <div className="flex items-center justify-between gap-2">
                                  <span className="font-bold text-slate-900">{rec.serviceName}</span>
                                  <span
                                    className={`text-[11px] font-bold ${
                                      rec.priority === 'High'
                                        ? 'text-rose-700'
                                        : rec.priority === 'Medium'
                                        ? 'text-amber-700'
                                        : 'text-slate-600'
                                    }`}
                                  >
                                    {rec.priority} Priority
                                  </span>
                                </div>
                                <p className="text-slate-700">{rec.rationale}</p>
                                <p className="text-blue-800 font-medium">Expected outcome: {rec.expectedOutcome}</p>
                              </div>
                            ))}
                          </div>
                        </div>

                        {/* Tailored Outreach Pitch */}
                        <div className="p-4 bg-slate-900 text-slate-100 rounded-xl space-y-2 text-xs">
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-bold text-cyan-300">
                              Tailored {ia.industry} Outreach Pitch
                            </span>
                            <button
                              type="button"
                              onClick={() => handleCopyPitch(record.id, ia.outreachPitch)}
                              className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-white rounded-lg text-[11px] font-semibold flex items-center gap-1 cursor-pointer"
                            >
                              {copiedPitchId === record.id ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                              <span>{copiedPitchId === record.id ? 'Copied' : 'Copy Pitch'}</span>
                            </button>
                          </div>
                          <p className="leading-relaxed text-slate-200">{ia.outreachPitch}</p>
                        </div>
                      </section>
                    ) : (
                      <div className="p-5 bg-white border border-slate-200 rounded-2xl text-xs text-slate-600 flex flex-wrap items-center justify-between gap-3">
                        <span>
                          Industry-specific analysis has not been run for <strong>{record.name}</strong> ({record.industry || 'General Business'}) yet.
                        </span>
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => void analyzeSingleRecord(record)}
                          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-xl cursor-pointer"
                        >
                          Run Industry Analysis Now
                        </button>
                      </div>
                    )}

                    {/* Contact Details & Source Attribution */}
                    <section className="bg-white border border-slate-200 rounded-2xl p-5 space-y-3 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <h4 className="font-bold text-sm text-slate-900">Contact Details &amp; Provenance</h4>
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => void fetchPhoneForSingleRecord(record)}
                          className="text-blue-700 hover:underline font-bold cursor-pointer"
                        >
                          Re-check contact on Google
                        </button>
                      </div>
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                        <div className="p-3 bg-slate-50 rounded-xl border border-slate-200 space-y-1">
                          <span className="text-[11px] font-bold text-slate-500">Phone Number</span>
                          <p className="font-mono font-bold text-slate-900">
                            {record.contactPhone || 'Not found yet'}
                          </p>
                          <p className="text-[11px] text-slate-600">
                            Source: {record.contactPhoneSource || (record.contactPhone ? 'Uploaded Excel' : 'Pending Google lookup')}
                          </p>
                          {safeExternalUrl(record.contactPhoneSourceUrl) && (
                            <a
                              href={safeExternalUrl(record.contactPhoneSourceUrl)}
                              target="_blank"
                              rel="noreferrer"
                              className="text-blue-700 hover:underline inline-flex items-center gap-1"
                            >
                              <span>Verify source</span>
                              <ExternalLink className="w-3 h-3" />
                            </a>
                          )}
                        </div>
                        <div className="p-3 bg-slate-50 rounded-xl border border-slate-200 space-y-1">
                          <span className="text-[11px] font-bold text-slate-500">Email &amp; Key Person</span>
                          <p className="font-mono font-bold text-slate-900 break-all">
                            {record.contactEmail || 'Not publicly listed'}
                          </p>
                          <p className="text-[11px] text-slate-600">
                            Contact person: {record.contactPerson || 'Unconfirmed'}
                          </p>
                        </div>
                        <div className="p-3 bg-slate-50 rounded-xl border border-slate-200 space-y-1">
                          <span className="text-[11px] font-bold text-slate-500">Official Website &amp; Address</span>
                          {safeWeb ? (
                            <a
                              href={safeWeb}
                              target="_blank"
                              rel="noreferrer"
                              className="font-bold text-blue-700 hover:underline break-all inline-flex items-center gap-1"
                            >
                              <Globe className="w-3 h-3 shrink-0" />
                              <span>{safeWeb}</span>
                            </a>
                          ) : (
                            <p className="font-semibold text-slate-500">No official website verified</p>
                          )}
                          <p className="text-[11px] text-slate-600">{record.address || `${record.area}, ${record.city}`}</p>
                        </div>
                      </div>
                    </section>

                    {/* All 27 Natton Services Matrix — Open by Default with Accurate Availability Filters */}
                    <section className="bg-white border border-slate-200 rounded-2xl p-5 space-y-4">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <h4 className="font-bold text-sm text-slate-900">
                            All {assessment.services.length} Natton Services — Have vs. Missing / Seeking Audit
                          </h4>
                          <p className="text-[11px] text-slate-500">
                            Verified from live website HTML, public directory signals, and {record.industry || 'industry'} requirements.
                          </p>
                        </div>
                        <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                          {[
                            { id: 'ALL' as const, label: `All (${svcSummary.total})` },
                            { id: 'MISSING_OR_SEEKING' as const, label: `Missing / Seeking (${svcSummary.missingOrSeeking})` },
                            { id: 'HAS_SERVICE' as const, label: `Already Has (${svcSummary.hasService})` },
                            { id: 'NEEDS_UPGRADE' as const, label: `Needs Upgrade (${svcSummary.needsUpgrade})` },
                            { id: 'INTERNAL' as const, label: `Verify in Call (${svcSummary.internalCheck})` },
                          ].map((tab) => (
                            <button
                              key={tab.id}
                              type="button"
                              onClick={() => setMatrixTab(tab.id)}
                              className={`px-2.5 py-1 rounded-lg border font-bold cursor-pointer tabular-nums ${
                                matrixTab === tab.id
                                  ? 'bg-slate-900 text-white border-slate-900'
                                  : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
                              }`}
                            >
                              {tab.label}
                            </button>
                          ))}
                        </div>
                      </div>

                      <div className="overflow-auto max-h-[460px] border border-slate-200 rounded-xl">
                        <table className="w-full min-w-[900px] text-xs text-left">
                          <thead className="sticky top-0 bg-slate-100 text-slate-700">
                            <tr>
                              <th className="p-3 font-bold">Natton Service</th>
                              <th className="p-3 font-bold">Availability / Finding</th>
                              <th className="p-3 font-bold">Live Evidence</th>
                              <th className="p-3 font-bold">Actionable Pitch / Opportunity</th>
                              <th className="p-3 font-bold">Ask the Customer</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100">
                            {assessment.services
                              .filter((srv) => {
                                if (matrixTab === 'MISSING_OR_SEEKING') {
                                  return srv.demandState === 'MISSING_NEEDED' || srv.demandState === 'ACTIVELY_SEEKING';
                                }
                                if (matrixTab === 'HAS_SERVICE') return srv.demandState === 'HAS_SERVICE';
                                if (matrixTab === 'NEEDS_UPGRADE') return srv.demandState === 'NEEDS_UPGRADE';
                                if (matrixTab === 'INTERNAL') return srv.demandState === 'INTERNAL_UNCONFIRMED' || !srv.demandState;
                                return true;
                              })
                              .map((srv) => {
                                const badge = demandBadge(srv.demandState);
                                const isFocused = focusedService?.id === srv.id;
                                return (
                                  <tr key={srv.id} className={`align-top ${isFocused ? 'bg-blue-50/60' : ''}`}>
                                    <td className="p-3 font-bold text-slate-900 w-48">
                                      {srv.name}
                                      <div className="text-[10px] font-normal text-slate-500 mt-0.5">{srv.group}</div>
                                    </td>
                                    <td className="p-3 w-40">
                                      <span className={`inline-block px-2 py-0.5 rounded-md border text-[11px] font-bold ${badge.cls}`}>
                                        {badge.label}
                                      </span>
                                      <div className="text-[10px] text-slate-500 mt-1">{srv.status}</div>
                                    </td>
                                    <td className="p-3 w-60 text-slate-600 space-y-1">
                                      {srv.evidence.length
                                        ? srv.evidence.map((e, i) => <p key={i}>{e.text}</p>)
                                        : 'Confirm during discovery call.'}
                                    </td>
                                    <td className="p-3 w-56 text-slate-700">{srv.recommendation}</td>
                                    <td className="p-3 w-64 text-slate-600 space-y-1">
                                      {srv.customerQuestions.map((q, i) => (
                                        <p key={i}>
                                          {i + 1}. {q}
                                        </p>
                                      ))}
                                    </td>
                                  </tr>
                                );
                              })}
                          </tbody>
                        </table>
                      </div>

                      <details className="pt-1">
                        <summary className="text-xs font-bold text-slate-700 cursor-pointer hover:text-slate-950">
                          Discovery Call Questions &amp; Documents Checklist
                        </summary>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs pt-3">
                          <div>
                            <h5 className="font-bold text-slate-900 mb-1.5">General Discovery Questions</h5>
                            {GENERAL_DISCOVERY_QUESTIONS.map((q, i) => (
                              <p key={i} className="text-slate-600 mb-1">
                                {i + 1}. {q}
                              </p>
                            ))}
                          </div>
                          <div>
                            <h5 className="font-bold text-slate-900 mb-1.5">Documents &amp; Access Checklist</h5>
                            {DOCUMENTS_CHECKLIST.map((d, i) => (
                              <p key={i} className="text-slate-600 mb-1">
                                • {d}
                              </p>
                            ))}
                          </div>
                        </div>
                      </details>
                    </section>

                    {/* Grounding Sources */}
                    {record.digitalAudit?.sources && record.digitalAudit.sources.length > 0 && (
                      <div className="bg-white border border-slate-200 rounded-2xl p-4 space-y-2 text-xs">
                        <h5 className="font-bold text-slate-900">Verified Google Search Sources</h5>
                        <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                          {record.digitalAudit.sources.map((src, i) =>
                            safeExternalUrl(src.url) ? (
                              <a
                                key={i}
                                href={safeExternalUrl(src.url)}
                                target="_blank"
                                rel="noreferrer"
                                className="text-blue-700 hover:underline inline-flex items-center gap-1"
                              >
                                <span>{src.title || src.url}</span>
                                <ExternalLink className="w-3 h-3" />
                              </a>
                            ) : null
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
};

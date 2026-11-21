import React, { useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import {
  AlertCircle,
  Check,
  FileSpreadsheet,
  Layers,
  Phone,
  RefreshCw,
  Upload,
  X,
} from 'lucide-react';
import type { RecordEntityType, SchoolRecord } from '../types';
import { BUSINESS_INDUSTRIES_LIST, INDUSTRIES_LIST } from '../data/nattonCatalog';
import {
  computePriority,
  createMapsUrl,
  hasValidPhone,
  normalizeArea,
  normalizeLabStatus,
  safeExternalUrl,
} from '../utils/schoolHelpers';

interface ParsedSheet {
  sheetName: string;
  allRawRows: string[][];
  headerRowIdx: number;
  headers: string[];
  parsedRows: string[][];
  detectedColumns: Record<string, string>;
}

interface ExcelUploaderModalProps {
  defaultEntityType?: RecordEntityType;
  onClose: () => void;
  onSuccess: (
    filename: string,
    records: SchoolRecord[],
    csvText: string,
    sheetNames: string[],
    autoEnrichOptions: {
      entityType: RecordEntityType;
      autoVerifyLabs: boolean;
      autoFetchMissingPhones: boolean;
      autoAnalyzeIndustry: boolean;
    }
  ) => void;
}

function detectHeaderRow(rows: string[][]): number {
  const keywords = /school|business|company|institution|name|city|area|phone|mobile|contact|email|website|lab|board|industry|address/i;
  let bestIdx = 0;
  let bestScore = -1;
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const cells = rows[i] || [];
    const nonEmpty = cells.filter((c) => String(c || '').trim() !== '').length;
    const kwHits = cells.filter((c) => keywords.test(String(c || ''))).length;
    const score = kwHits * 3 + nonEmpty;
    if (score > bestScore && nonEmpty >= 2) {
      bestScore = score;
      bestIdx = i;
    }
  }
  return bestIdx;
}

function autoDetectColumns(headers: string[]): Record<string, string> {
  const find = (re: RegExp) => headers.find((h) => re.test(h)) || '';
  const nameCol =
    find(/^(school|business|company|institution|organization|org)\s*name$/i) ||
    find(/school|business|company|institution|name/i) ||
    headers[0] ||
    '';
  return {
    name: nameCol,
    industry: find(/industry|sector|category|vertical|business\s*type/i),
    area: find(/area|locality|route|zone|ward|block|taluk|neighborhood/i),
    city: find(/city|district|town|location|place/i),
    state: find(/state|region/i),
    address: find(/address|street|pin\s*code/i),
    board: find(/board|affiliation|curriculum|medium/i),
    code: find(/udise|code|affiliation\s*no|reg/i),
    phone: find(/phone|mobile|contact\s*(no|num|number)?|tel|whatsapp|helpline/i),
    email: find(/email|e-mail|mail/i),
    website: find(/website|url|web|domain|link/i),
    contactPerson: find(/principal|headmaster|owner|contact\s*person|director|manager/i),
    computerLab: find(/computer\s*lab|ict\s*lab|lab\s*status|has\s*lab|computer|lab/i),
    enrollment: find(/enrollment|students|strength|headcount/i),
  };
}

function buildParsedSheet(sheetName: string, rawRows: string[][], headerRowIdx?: number): ParsedSheet {
  const cleanRows = rawRows
    .map((r) => (Array.isArray(r) ? r.map((c) => (c === undefined || c === null ? '' : String(c).trim())) : []))
    .filter((r) => r.some((c) => c !== ''));
  const hIdx = headerRowIdx !== undefined ? headerRowIdx : detectHeaderRow(cleanRows);
  const rawHeaders = cleanRows[hIdx] || [];
  const headers = rawHeaders.map((h, i) => (h ? h : `Column ${i + 1}`));
  const parsedRows = cleanRows.slice(hIdx + 1).filter((r) => r.some((c) => c !== ''));
  return {
    sheetName,
    allRawRows: cleanRows,
    headerRowIdx: hIdx,
    headers,
    parsedRows,
    detectedColumns: autoDetectColumns(headers),
  };
}

export const ExcelUploaderModal: React.FC<ExcelUploaderModalProps> = ({
  defaultEntityType = 'SCHOOL',
  onClose,
  onSuccess,
}) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [entityType, setEntityType] = useState<RecordEntityType>(defaultEntityType);
  const [filename, setFilename] = useState('');
  const [sheets, setSheets] = useState<ParsedSheet[]>([]);
  const [activeSheetIdx, setActiveSheetIdx] = useState(0);
  const [importMode, setImportMode] = useState<'ALL_SHEETS' | 'ACTIVE_SHEET'>('ALL_SHEETS');
  const [defaultIndustry, setDefaultIndustry] = useState(defaultEntityType === 'BUSINESS' ? 'Healthcare' : 'Education');
  const [customIndustry, setCustomIndustry] = useState('');
  const [autoVerifyLabs, setAutoVerifyLabs] = useState(defaultEntityType === 'SCHOOL');
  const [autoFetchMissingPhones, setAutoFetchMissingPhones] = useState(true);
  const [autoAnalyzeIndustry, setAutoAnalyzeIndustry] = useState(defaultEntityType === 'BUSINESS');
  const [error, setError] = useState('');

  const handleEntityTypeSwitch = (nextType: RecordEntityType) => {
    setEntityType(nextType);
    if (nextType === 'BUSINESS') {
      if (defaultIndustry === 'Education' || defaultIndustry === 'Schools') {
        setDefaultIndustry('Healthcare');
      }
      setAutoVerifyLabs(false);
      setAutoAnalyzeIndustry(true);
    } else {
      setDefaultIndustry('Education');
      setAutoVerifyLabs(true);
    }
  };

  const activeSheet = sheets[activeSheetIdx];
  const totalMergedRows = sheets.reduce((sum, s) => sum + s.parsedRows.length, 0);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    setError('');
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      setError('Spreadsheet exceeds the 10 MB limit. Please split it into smaller files.');
      return;
    }
    try {
      const buffer = await file.arrayBuffer();
      const wb = XLSX.read(buffer, { type: 'array' });
      const parsed: ParsedSheet[] = wb.SheetNames.map((sn) => {
        const ws = wb.Sheets[sn];
        const rows = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, defval: '' }) as string[][];
        return buildParsedSheet(sn, rows);
      }).filter((s) => s.parsedRows.length > 0);

      if (parsed.length === 0) {
        setError('No data rows found in the uploaded spreadsheet. Please check the file format.');
        return;
      }

      setFilename(file.name);
      setSheets(parsed);
      setActiveSheetIdx(0);
    } catch {
      setError('Could not parse this file. Please upload a valid .xlsx, .xls, or .csv spreadsheet.');
    }
  };

  const updateHeaderRow = (sheetIndex: number, nextRowIdx: number) => {
    setSheets((prev) =>
      prev.map((s, idx) =>
        idx === sheetIndex ? buildParsedSheet(s.sheetName, s.allRawRows, nextRowIdx) : s
      )
    );
  };

  const updateColumnMap = (sheetIndex: number, field: string, value: string) => {
    setSheets((prev) =>
      prev.map((s, idx) =>
        idx === sheetIndex
          ? { ...s, detectedColumns: { ...s.detectedColumns, [field]: value } }
          : s
      )
    );
  };

  const selectedSheets = importMode === 'ALL_SHEETS' ? sheets : activeSheet ? [activeSheet] : [];

  // Count missing phones in preview
  const missingPhonesCount = selectedSheets.reduce((acc, sheet) => {
    const phoneIdx = sheet.headers.indexOf(sheet.detectedColumns.phone || '');
    return (
      acc +
      sheet.parsedRows.filter((row) => !hasValidPhone(phoneIdx >= 0 ? row[phoneIdx] : '')).length
    );
  }, 0);

  const handleImport = () => {
    setError('');
    if (!selectedSheets.length) {
      setError('Please upload a file first.');
      return;
    }

    const fallbackIndustry =
      defaultIndustry === 'Other / Custom Industry'
        ? customIndustry.trim() || (entityType === 'BUSINESS' ? 'General Business' : 'Education')
        : defaultIndustry;

    const records: SchoolRecord[] = [];
    const csvLines: string[] = [];

    selectedSheets.forEach((sheet, sheetIdx) => {
      const col = (key: string) => {
        const headerName = sheet.detectedColumns[key];
        return headerName ? sheet.headers.indexOf(headerName) : -1;
      };

      const nameIdx = col('name');
      if (nameIdx < 0) {
        setError(`Select a Name column for sheet "${sheet.sheetName}".`);
        return;
      }

      const indIdx = col('industry');
      const areaIdx = col('area');
      const cityIdx = col('city');
      const stateIdx = col('state');
      const addrIdx = col('address');
      const boardIdx = col('board');
      const codeIdx = col('code');
      const phoneIdx = col('phone');
      const emailIdx = col('email');
      const webIdx = col('website');
      const personIdx = col('contactPerson');
      const labIdx = col('computerLab');
      const enrollIdx = col('enrollment');

      sheet.parsedRows.forEach((row, rIdx) => {
        const rawName = (row[nameIdx] || '').trim();
        if (!rawName || rawName.length < 2) return;
        // Skip pre-primary-only rows when importing Schools
        if (entityType === 'SCHOOL' && /^(nursery|play\s*school|playschool|kindergarten|pre-?primary)\b/i.test(rawName)) {
          return;
        }

        const rawIndustry = (indIdx >= 0 ? row[indIdx] : '').trim() || fallbackIndustry;
        const rawArea = (areaIdx >= 0 ? row[areaIdx] : '').trim();
        const rawCity = (cityIdx >= 0 ? row[cityIdx] : '').trim();
        const rawState = (stateIdx >= 0 ? row[stateIdx] : '').trim();
        const rawAddress = (addrIdx >= 0 ? row[addrIdx] : '').trim();
        const rawBoard = entityType === 'SCHOOL' ? (boardIdx >= 0 ? row[boardIdx] : '').trim() : '';
        const rawCode = (codeIdx >= 0 ? row[codeIdx] : '').trim();
        const rawPhone = (phoneIdx >= 0 ? row[phoneIdx] : '').trim();
        const rawEmail = (emailIdx >= 0 ? row[emailIdx] : '').trim();
        const rawWeb = safeExternalUrl(webIdx >= 0 ? row[webIdx] : '');
        const rawPerson = (personIdx >= 0 ? row[personIdx] : '').trim();
        const rawLab = entityType === 'SCHOOL' && labIdx >= 0 ? normalizeLabStatus(row[labIdx]) : 'Unverified';
        const rawEnroll = enrollIdx >= 0 ? parseInt(String(row[enrollIdx] || '').replace(/[^\d]/g, ''), 10) : NaN;

        const uploadedData: Record<string, string> = Object.create(null) as Record<string, string>;
        sheet.headers.forEach((h, i) => {
          if (h && h !== '__proto__' && h !== 'constructor' && h !== 'prototype' && row[i]) {
            uploadedData[h] = row[i];
          }
        });

        const phonePresent = hasValidPhone(rawPhone);
        const area = normalizeArea(rawName, rawArea, rawCity);
        const slug = rawName.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 28);

        const baseRecord: Partial<SchoolRecord> = {
          id: `imp-${slug}-${Date.now().toString(36)}-${sheetIdx}-${rIdx}`,
          name: rawName,
          recordType: entityType,
          industry: rawIndustry,
          area,
          city: rawCity || area,
          state: rawState || undefined,
          address: rawAddress || undefined,
          board: rawBoard || undefined,
          code: rawCode || undefined,
          website: rawWeb,
          contactPerson: rawPerson || undefined,
          contactPhone: phonePresent ? rawPhone : undefined,
          contactPhoneSource: phonePresent ? 'Uploaded Excel' : undefined,
          contactEmail: rawEmail || undefined,
          contactEmailSource: rawEmail ? 'Uploaded Excel' : undefined,
          studentEnrollment: Number.isNaN(rawEnroll) ? undefined : rawEnroll,
          sheetName: sheet.sheetName,
          mapsUrl: createMapsUrl(rawName, area, rawCity),
          computerLab: rawLab,
          computerLabSource: entityType === 'SCHOOL' && rawLab !== 'Unverified' ? 'EXCEL' : undefined,
          daysSinceLastVisit: 65,
          analysisStatus: 'QUEUED',
          uploadedData,
        };

        const priority = computePriority(baseRecord);
        records.push({
          ...(baseRecord as SchoolRecord),
          ...priority,
        });
        csvLines.push(row.join(','));
      });
    });

    if (records.length === 0) {
      setError('No valid rows remained after parsing. Please verify your Name column selection.');
      return;
    }

    onSuccess(
      filename,
      records,
      csvLines.slice(0, 200).join('\n'),
      selectedSheets.map((s) => s.sheetName),
      {
        entityType,
        autoVerifyLabs: entityType === 'SCHOOL' ? autoVerifyLabs : false,
        autoFetchMissingPhones,
        autoAnalyzeIndustry: entityType === 'BUSINESS' ? autoAnalyzeIndustry : false,
      }
    );
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex items-center justify-center p-3 sm:p-6">
      <div className="bg-white w-full max-w-3xl rounded-3xl shadow-2xl border border-slate-200 overflow-hidden flex flex-col max-h-[92vh]">
        <div className="p-5 sm:p-6 bg-slate-950 text-white flex items-start justify-between gap-4">
          <div className="space-y-1">
            <p className="text-[11px] font-bold uppercase tracking-wider text-cyan-400">
              Multi-Sheet Excel &amp; CSV Importer
            </p>
            <h2 className="text-lg sm:text-xl font-bold tracking-tight">
              Import Schools or Businesses &amp; Auto-Enrich from Google
            </h2>
            <p className="text-xs text-slate-300">
              Missing contact numbers, computer lab status, and industry analysis are fetched automatically via live Google Search.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-white hover:bg-white/10 rounded-xl transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 sm:p-6 space-y-4 overflow-y-auto">
          <div className="flex flex-wrap items-center justify-between gap-2 p-3 bg-slate-50 border border-slate-200 rounded-2xl text-xs">
            <span className="font-bold text-slate-700">Import Target Register:</span>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => handleEntityTypeSwitch('SCHOOL')}
                className={`px-3 py-1.5 rounded-xl font-bold border cursor-pointer ${
                  entityType === 'SCHOOL'
                    ? 'bg-blue-600 text-white border-blue-600'
                    : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-100'
                }`}
              >
                Schools Register (Lab Verification)
              </button>
              <button
                type="button"
                onClick={() => handleEntityTypeSwitch('BUSINESS')}
                className={`px-3 py-1.5 rounded-xl font-bold border cursor-pointer ${
                  entityType === 'BUSINESS'
                    ? 'bg-slate-900 text-white border-slate-900'
                    : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-100'
                }`}
              >
                Businesses Register (Industry Audit)
              </button>
            </div>
          </div>

          {error && (
            <div className="p-3 bg-rose-50 border border-rose-200 text-rose-900 rounded-2xl text-xs font-bold flex items-center gap-2">
              <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {filename ? (
            <div className="bg-blue-50/80 border border-blue-200 rounded-2xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-blue-600 text-white flex items-center justify-center shrink-0">
                  <FileSpreadsheet className="w-5 h-5" />
                </div>
                <div>
                  <div className="font-bold text-slate-900 text-xs sm:text-sm break-all">{filename}</div>
                  <div className="text-[11px] text-blue-800 font-semibold mt-0.5">
                    {importMode === 'ALL_SHEETS'
                      ? `${totalMergedRows} records across ${sheets.length} sheet tab(s)`
                      : `${activeSheet?.parsedRows.length || 0} records in "${activeSheet?.sheetName}"`}
                    {' · '}
                    <span className="text-amber-700">
                      {missingPhonesCount} row(s) missing phone (will fetch from Google)
                    </span>
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  setFilename('');
                  setSheets([]);
                  if (fileInputRef.current) fileInputRef.current.value = '';
                }}
                className="self-end sm:self-center px-3 py-1.5 bg-white border border-slate-300 hover:bg-slate-50 text-slate-700 font-bold text-xs rounded-xl flex items-center gap-1 cursor-pointer"
              >
                <RefreshCw className="w-3.5 h-3.5 text-slate-500" />
                <span>Change File</span>
              </button>
            </div>
          ) : (
            <div
              onClick={() => fileInputRef.current?.click()}
              className="border-2 border-dashed border-slate-300 hover:border-blue-500 rounded-3xl p-8 text-center cursor-pointer bg-slate-50 hover:bg-blue-50/40 transition-all group"
            >
              <input
                type="file"
                ref={fileInputRef}
                onChange={handleFileChange}
                accept=".xlsx,.xls,.csv"
                className="hidden"
              />
              <div className="w-12 h-12 mx-auto rounded-2xl bg-blue-100 group-hover:bg-blue-600 text-blue-600 group-hover:text-white flex items-center justify-center transition-colors mb-3">
                <Upload className="w-6 h-6" />
              </div>
              <p className="font-bold text-slate-800 text-sm">
                Click to upload Excel (.xlsx, .xls) or CSV file
              </p>
              <p className="text-xs text-slate-500 mt-1">
                Automatically detects all sheet tabs, headers, phone columns, lab columns &amp; industry
              </p>
            </div>
          )}

          {sheets.length > 1 && (
            <div className="bg-white border border-indigo-200 rounded-2xl p-3.5 space-y-3">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Layers className="w-4 h-4 text-indigo-600" />
                  <span className="font-bold text-slate-900 text-xs sm:text-sm">
                    Multiple Sheet Tabs Detected ({sheets.length} Sheets)
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-3 text-xs">
                  <label className="flex items-center gap-1.5 font-bold text-slate-800 cursor-pointer">
                    <input
                      type="radio"
                      name="sheetMode"
                      checked={importMode === 'ALL_SHEETS'}
                      onChange={() => setImportMode('ALL_SHEETS')}
                    />
                    <span>Merge All Sheets ({totalMergedRows})</span>
                  </label>
                  <label className="flex items-center gap-1.5 font-medium text-slate-600 cursor-pointer">
                    <input
                      type="radio"
                      name="sheetMode"
                      checked={importMode === 'ACTIVE_SHEET'}
                      onChange={() => setImportMode('ACTIVE_SHEET')}
                    />
                    <span>Active Sheet Only</span>
                  </label>
                </div>
              </div>
              <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar pb-1">
                {sheets.map((s, idx) => (
                  <button
                    key={s.sheetName}
                    type="button"
                    onClick={() => setActiveSheetIdx(idx)}
                    className={`px-3 py-1.5 rounded-xl text-xs font-bold shrink-0 cursor-pointer border ${
                      activeSheetIdx === idx
                        ? 'bg-indigo-600 text-white border-indigo-600'
                        : 'bg-slate-100 text-slate-700 border-slate-200 hover:bg-slate-200'
                    }`}
                  >
                    {s.sheetName} ({s.parsedRows.length})
                  </button>
                ))}
              </div>
            </div>
          )}

          {activeSheet && (
            <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4 space-y-4 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 pb-2.5">
                <span className="font-bold text-slate-900">
                  Column Mapping for Tab: <span className="text-blue-700">{activeSheet.sheetName}</span>
                </span>
                <span className="text-[11px] font-bold text-emerald-700 inline-flex items-center gap-1">
                  <Check className="w-3.5 h-3.5" /> Auto-Configured
                </span>
              </div>

              {activeSheet.allRawRows.length > 1 && (
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 bg-white p-2.5 rounded-xl border border-slate-200">
                  <div>
                    <span className="font-bold text-slate-800 block">Header Row in File</span>
                    <span className="text-[11px] text-slate-500">
                      Row {activeSheet.headerRowIdx + 1} contains column names
                    </span>
                  </div>
                  <select
                    value={activeSheet.headerRowIdx}
                    onChange={(e) => updateHeaderRow(activeSheetIdx, parseInt(e.target.value, 10))}
                    className="p-2 bg-slate-50 border border-slate-300 rounded-lg font-bold text-slate-800 text-xs max-w-full sm:max-w-[280px]"
                  >
                    {activeSheet.allRawRows.slice(0, 10).map((row, idx) => (
                      <option key={idx} value={idx}>
                        Row {idx + 1}: {row.filter(Boolean).slice(0, 3).join(' | ') || '(Empty)'}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {[
                  { key: 'name', label: entityType === 'SCHOOL' ? 'School Name Column *' : 'Business Name Column *', required: true },
                  { key: 'phone', label: 'Contact Phone / Mobile Column (Auto-fetched from Google if blank)' },
                  { key: 'industry', label: 'Industry / Category Column (Optional)' },
                  ...(entityType === 'SCHOOL'
                    ? [{ key: 'computerLab', label: 'Computer Lab Column (Auto-verified on Google if blank)' }]
                    : []),
                  { key: 'area', label: 'Area / Locality / Route Column' },
                  { key: 'city', label: 'City / District Column' },
                  { key: 'website', label: 'Official Website Column' },
                  { key: 'email', label: 'Email Column' },
                  ...(entityType === 'SCHOOL'
                    ? [{ key: 'board', label: 'Board / Affiliation Column (Schools)' }]
                    : []),
                  { key: 'contactPerson', label: entityType === 'SCHOOL' ? 'Principal / Headmaster Column' : 'Owner / Contact Person Column' },
                ].map((field) => (
                  <div
                    key={field.key}
                    className={`p-3 bg-white rounded-xl border space-y-1 ${
                      field.required ? 'border-blue-500 ring-1 ring-blue-100' : 'border-slate-200'
                    }`}
                  >
                    <label className="font-bold text-slate-700 block text-[11px]">{field.label}</label>
                    <select
                      value={activeSheet.detectedColumns[field.key] || ''}
                      onChange={(e) => updateColumnMap(activeSheetIdx, field.key, e.target.value)}
                      className="w-full p-2 bg-slate-50 border border-slate-300 rounded-lg font-semibold text-slate-900 text-xs"
                    >
                      {!field.required && <option value="">— Not in file / Auto-fetch from Google —</option>}
                      {activeSheet.headers.map((h) => (
                        <option key={h} value={h}>
                          {h}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                <div className="p-3 bg-white rounded-xl border border-slate-200 space-y-1.5">
                  <label className="font-bold text-slate-800 block text-[11px]">
                    Default Industry (used when Industry column is blank)
                  </label>
                  <select
                    value={defaultIndustry}
                    onChange={(e) => setDefaultIndustry(e.target.value)}
                    className="w-full p-2 bg-slate-50 border border-slate-300 rounded-lg font-semibold text-slate-900 text-xs"
                  >
                    {(entityType === 'BUSINESS' ? BUSINESS_INDUSTRIES_LIST : INDUSTRIES_LIST).map((ind) => (
                      <option key={ind} value={ind}>
                        {ind}
                      </option>
                    ))}
                  </select>
                  {defaultIndustry === 'Other / Custom Industry' && (
                    <input
                      type="text"
                      value={customIndustry}
                      onChange={(e) => setCustomIndustry(e.target.value)}
                      placeholder="Enter custom industry (e.g. Dental Clinics)"
                      className="w-full p-2 border border-slate-300 rounded-lg text-xs"
                    />
                  )}
                </div>

                <div className="p-3 bg-blue-50/70 rounded-xl border border-blue-200 space-y-2">
                  <div className="font-bold text-blue-950 text-[11px] flex items-center gap-1.5">
                    <Phone className="w-3.5 h-3.5 text-blue-600" />
                    <span>Automatic Google Enrichment After Import</span>
                  </div>
                  <label className="flex items-center gap-2 text-[11px] text-slate-800 font-semibold cursor-pointer">
                    <input
                      type="checkbox"
                      checked={autoFetchMissingPhones}
                      onChange={(e) => setAutoFetchMissingPhones(e.target.checked)}
                    />
                    <span>Fetch missing contact numbers from Google ({missingPhonesCount} missing)</span>
                  </label>
                  {entityType === 'SCHOOL' ? (
                    <label className="flex items-center gap-2 text-[11px] text-slate-800 font-semibold cursor-pointer">
                      <input
                        type="checkbox"
                        checked={autoVerifyLabs}
                        onChange={(e) => setAutoVerifyLabs(e.target.checked)}
                      />
                      <span>Verify school Computer Lab presence (Yes/No)</span>
                    </label>
                  ) : (
                    <label className="flex items-center gap-2 text-[11px] text-slate-800 font-semibold cursor-pointer">
                      <input
                        type="checkbox"
                        checked={autoAnalyzeIndustry}
                        onChange={(e) => setAutoAnalyzeIndustry(e.target.checked)}
                      />
                      <span>Run Industry-Specific Business Analysis</span>
                    </label>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="p-4 bg-slate-50 border-t border-slate-200 flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2.5 text-xs font-bold text-slate-700 bg-white border border-slate-300 hover:bg-slate-100 rounded-xl cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleImport}
            disabled={!sheets.length}
            className="px-5 py-2.5 text-xs font-bold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded-xl shadow-xs cursor-pointer"
          >
            Import {importMode === 'ALL_SHEETS' ? totalMergedRows : activeSheet?.parsedRows.length || 0} Records &amp; Start Enrichment
          </button>
        </div>
      </div>
    </div>
  );
};

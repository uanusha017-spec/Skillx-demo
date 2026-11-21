import React, { useState } from 'react';
import {
  CheckCircle2,
  FileSpreadsheet,
  Search,
  Target,
  XCircle,
} from 'lucide-react';
import type { PriorityLevel, SchoolRecord, UserSession } from '../types';
import { exportPriorityTargetsExcel } from '../utils/exportSuite';
import { formatLocation, isBusinessRecord, isEducationRecord } from '../utils/schoolHelpers';

interface PriorityTargetingViewProps {
  schools: SchoolRecord[];
  session: UserSession;
  onSelectForDPR: (school: SchoolRecord) => void;
  onSelectForLabCheck: () => void;
}

const PRIORITY_META: Record<PriorityLevel, { text: string; textClass: string }> = {
  P1_CRITICAL: { text: 'P1 Critical', textClass: 'text-rose-700' },
  P2_HIGH: { text: 'P2 High', textClass: 'text-amber-700' },
  P3_MEDIUM: { text: 'P3 Medium', textClass: 'text-blue-700' },
  P4_LOW: { text: 'P4 Low', textClass: 'text-slate-600' },
};

export const PriorityTargetingView: React.FC<PriorityTargetingViewProps> = ({
  schools,
  onSelectForDPR,
  onSelectForLabCheck,
}) => {
  const [recordScope, setRecordScope] = useState<'ALL' | 'SCHOOLS' | 'BUSINESSES'>('ALL');
  const [priorityFilter, setPriorityFilter] = useState<'ALL' | PriorityLevel>('ALL');
  const [search, setSearch] = useState('');
  const [viewMode, setViewMode] = useState<'TABLE' | 'CARDS'>('TABLE');

  const scopedRecords = schools.filter((s) => {
    if (recordScope === 'SCHOOLS') return isEducationRecord(s);
    if (recordScope === 'BUSINESSES') return isBusinessRecord(s);
    return true;
  });

  const sorted = [...scopedRecords].sort((a, b) => (b.priorityScore || 0) - (a.priorityScore || 0));

  const p1 = sorted.filter((s) => s.priorityLevel === 'P1_CRITICAL').length;
  const p2 = sorted.filter((s) => s.priorityLevel === 'P2_HIGH').length;
  const p3 = sorted.filter((s) => s.priorityLevel === 'P3_MEDIUM').length;
  const p4 = sorted.filter((s) => s.priorityLevel === 'P4_LOW').length;

  const filtered = sorted.filter((s) => {
    if (priorityFilter !== 'ALL' && s.priorityLevel !== priorityFilter) return false;
    if (search.trim()) {
      const hay = `${s.name} ${s.area} ${s.city} ${s.industry || ''} ${s.targetPriorityReason}`.toLowerCase();
      if (!hay.includes(search.trim().toLowerCase())) return false;
    }
    return true;
  });

  return (
    <div className="space-y-5">
      <div className="bg-white rounded-3xl border border-slate-200 p-5 sm:p-6 shadow-2xs flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-xs font-bold text-rose-700">
            <Target className="w-4 h-4 text-rose-600" />
            <span>Intelligent Field Outreach Prioritization</span>
          </div>
          <h1 className="text-2xl font-extrabold text-slate-900 tracking-tight">
            Priority Targeting Queue
          </h1>
          <p className="text-xs text-slate-500 max-w-2xl">
            Ranked by visit recency, confirmed school lab readiness, enrollment scale, and contact availability.
          </p>
        </div>

        <button
          type="button"
          disabled={filtered.length === 0}
          onClick={() => exportPriorityTargetsExcel(filtered)}
          className="px-3.5 py-2.5 bg-slate-900 hover:bg-slate-800 disabled:opacity-40 text-white font-bold text-xs rounded-xl flex items-center gap-1.5 whitespace-nowrap cursor-pointer self-start md:self-center"
        >
          <FileSpreadsheet className="w-3.5 h-3.5" />
          <span>Export Targets (.xlsx)</span>
        </button>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { level: 'P1_CRITICAL' as const, title: 'Target First · P1', count: p1, desc: 'Critical overdue (>60d)', accent: 'text-rose-800', activeBg: 'bg-rose-50 border-rose-300 ring-1 ring-rose-300' },
          { level: 'P2_HIGH' as const, title: 'P2 High Priority', count: p2, desc: 'Active engagement pipeline', accent: 'text-amber-800', activeBg: 'bg-amber-50 border-amber-300 ring-1 ring-amber-300' },
          { level: 'P3_MEDIUM' as const, title: 'P3 Medium', count: p3, desc: 'Regular check-ins', accent: 'text-blue-800', activeBg: 'bg-blue-50 border-blue-300 ring-1 ring-blue-300' },
          { level: 'P4_LOW' as const, title: 'P4 Low / Recent', count: p4, desc: 'Recently visited (<14d)', accent: 'text-slate-700', activeBg: 'bg-slate-100 border-slate-400 ring-1 ring-slate-300' },
        ].map((card) => {
          const selected = priorityFilter === card.level;
          return (
            <button
              key={card.level}
              type="button"
              onClick={() => setPriorityFilter(selected ? 'ALL' : card.level)}
              className={`text-left p-4 rounded-2xl border transition-all cursor-pointer ${
                selected ? card.activeBg : 'bg-white border-slate-200 hover:border-slate-300'
              }`}
            >
              <div className={`text-xs font-bold ${card.accent}`}>{card.title}</div>
              <div className="text-2xl font-extrabold text-slate-950 mt-1 tabular-nums">{card.count}</div>
              <div className="text-[11px] text-slate-500 mt-0.5">{card.desc}</div>
            </button>
          );
        })}
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="relative flex-1 max-w-md">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search targets by name, area, industry, or rationale..."
            className="w-full pl-9 pr-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs">
          <select
            value={recordScope}
            onChange={(e) => setRecordScope(e.target.value as 'ALL' | 'SCHOOLS' | 'BUSINESSES')}
            className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl font-bold text-slate-700"
          >
            <option value="ALL">All Records ({schools.length})</option>
            <option value="SCHOOLS">Schools Only ({schools.filter(isEducationRecord).length})</option>
            <option value="BUSINESSES">Businesses Only ({schools.filter(isBusinessRecord).length})</option>
          </select>

          <select
            value={priorityFilter}
            onChange={(e) => setPriorityFilter(e.target.value as 'ALL' | PriorityLevel)}
            className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl font-bold text-slate-700"
          >
            <option value="ALL">All Priority Levels</option>
            <option value="P1_CRITICAL">P1 Critical Only</option>
            <option value="P2_HIGH">P2 High Only</option>
            <option value="P3_MEDIUM">P3 Medium Only</option>
            <option value="P4_LOW">P4 Low Only</option>
          </select>

          <div className="flex items-center bg-slate-100 p-0.5 rounded-xl border border-slate-200">
            <button
              type="button"
              onClick={() => setViewMode('TABLE')}
              className={`px-3 py-1.5 rounded-lg font-bold cursor-pointer ${
                viewMode === 'TABLE' ? 'bg-white text-slate-900 shadow-2xs' : 'text-slate-500'
              }`}
            >
              Table
            </button>
            <button
              type="button"
              onClick={() => setViewMode('CARDS')}
              className={`px-3 py-1.5 rounded-lg font-bold cursor-pointer ${
                viewMode === 'CARDS' ? 'bg-white text-slate-900 shadow-2xs' : 'text-slate-500'
              }`}
            >
              Cards
            </button>
          </div>
        </div>
      </div>

      {viewMode === 'TABLE' ? (
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-2xs">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 border-b border-slate-200 text-slate-600 font-bold text-[11px]">
                <tr>
                  <th className="p-3.5 pl-5">Priority &amp; Rank</th>
                  <th className="p-3.5">Organization Details</th>
                  <th className="p-3.5">Score &amp; Visit Age</th>
                  <th className="p-3.5">Targeting Rationale</th>
                  <th className="p-3.5">Computer Lab</th>
                  <th className="p-3.5 pr-5 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="p-8 text-center text-slate-500">
                      No targets match the current filter. Upload an Excel sheet or discover businesses to build your priority queue.
                    </td>
                  </tr>
                ) : (
                  filtered.map((s, idx) => {
                    const meta = PRIORITY_META[s.priorityLevel] || PRIORITY_META.P3_MEDIUM;
                    const isSchool = isEducationRecord(s);
                    return (
                      <tr key={s.id} className="hover:bg-slate-50 transition-colors">
                        <td className="p-3.5 pl-5 whitespace-nowrap">
                          <div className={`font-extrabold ${meta.textClass}`}>{meta.text}</div>
                          <div className="text-[10px] font-mono text-slate-400">Rank #{idx + 1}</div>
                        </td>
                        <td className="p-3.5 min-w-[200px]">
                          <div className="font-bold text-slate-900 text-sm">{s.name}</div>
                          <div className="text-[11px] text-slate-500">
                            {formatLocation(s.name, s.area, s.city, s.state)} · {s.industry || (isSchool ? 'Education' : 'Business')}
                          </div>
                          {s.contactPhone && (
                            <div className="text-[11px] font-mono text-slate-700 mt-0.5">{s.contactPhone}</div>
                          )}
                        </td>
                        <td className="p-3.5 font-mono tabular-nums whitespace-nowrap">
                          <div className="font-bold text-slate-900">{s.priorityScore} / 100</div>
                          <div className="text-[10px] text-slate-500">Last visit: {s.daysSinceLastVisit}d ago</div>
                        </td>
                        <td className="p-3.5 max-w-sm text-[11px] text-slate-600">{s.targetPriorityReason}</td>
                        <td className="p-3.5 whitespace-nowrap">
                          {!isSchool ? (
                            <span className="text-slate-400 font-semibold">— (Business)</span>
                          ) : s.computerLab === 'Yes' ? (
                            <span className="text-emerald-700 font-bold inline-flex items-center gap-1">
                              <CheckCircle2 className="w-3.5 h-3.5" /> Yes
                            </span>
                          ) : s.computerLab === 'No' ? (
                            <span className="text-rose-700 font-bold inline-flex items-center gap-1">
                              <XCircle className="w-3.5 h-3.5" /> No
                            </span>
                          ) : (
                            <button
                              type="button"
                              onClick={onSelectForLabCheck}
                              className="text-amber-700 font-bold hover:underline cursor-pointer"
                            >
                              Unverified
                            </button>
                          )}
                        </td>
                        <td className="p-3.5 pr-5 text-right whitespace-nowrap">
                          <button
                            type="button"
                            onClick={() => onSelectForDPR(s)}
                            className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-lg cursor-pointer"
                          >
                            Log DPR
                          </button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {filtered.map((s, idx) => {
            const meta = PRIORITY_META[s.priorityLevel] || PRIORITY_META.P3_MEDIUM;
            return (
              <div key={s.id} className="bg-white border border-slate-200 rounded-2xl p-4 space-y-2.5 text-xs">
                <div className="flex items-center justify-between">
                  <span className={`font-extrabold ${meta.textClass}`}>{meta.text}</span>
                  <span className="font-mono text-slate-500 tabular-nums">
                    Rank #{idx + 1} · {s.priorityScore}/100
                  </span>
                </div>
                <div>
                  <h3 className="font-bold text-slate-900 text-sm">{s.name}</h3>
                  <p className="text-slate-500">
                    {formatLocation(s.name, s.area, s.city, s.state)}
                  </p>
                </div>
                <p className="text-slate-600">{s.targetPriorityReason}</p>
                <div className="flex items-center justify-between pt-2 border-t border-slate-100">
                  <span className="font-mono text-slate-700">{s.contactPhone || 'No phone'}</span>
                  <button
                    type="button"
                    onClick={() => onSelectForDPR(s)}
                    className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-lg cursor-pointer"
                  >
                    Log DPR
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

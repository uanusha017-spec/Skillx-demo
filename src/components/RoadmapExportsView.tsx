import React, { useState } from 'react';
import { AlertCircle, Calendar, FileSpreadsheet, FileText, MapPin } from 'lucide-react';
import type { SchoolRecord, UserSession } from '../types';
import { apiFetch, readJsonSafe } from '../services/apiClient';
import { exportBusinessResearchPdf, exportSchoolLabsExcel, exportSchoolLabsWord } from '../utils/exportSuite';
import { isBusinessRecord } from '../utils/schoolHelpers';

interface RoadmapExportsViewProps {
  schools: SchoolRecord[];
  allRecords?: SchoolRecord[];
  session: UserSession;
}

interface DayPlan {
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
}

export const RoadmapExportsView: React.FC<RoadmapExportsViewProps> = ({ schools, allRecords, session }) => {
  const [scope, setScope] = useState<'SCHOOLS' | 'ALL'>('SCHOOLS');
  const [schoolsPerDay, setSchoolsPerDay] = useState(4);
  const [startDate, setStartDate] = useState(new Date().toISOString().slice(0, 10));
  const [schedule, setSchedule] = useState<DayPlan[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const fullList = allRecords && allRecords.length > 0 ? allRecords : schools;
  const activeRecords = scope === 'SCHOOLS' ? schools : fullList;
  const businessOnlyRecords = fullList.filter(isBusinessRecord);
  const totalScheduledVisits = schedule.reduce((sum, d) => sum + d.visits.length, 0);

  const generateSchedule = async () => {
    setLoading(true);
    setError('');
    try {
      const resp = await apiFetch('/api/roadmap-schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schoolsPerDay, startDate, scope }),
      });
      const data = await readJsonSafe<{ days?: DayPlan[]; error?: string }>(resp);
      if (!resp.ok) {
        setError(data.error || 'Unable to generate field schedule right now.');
        return;
      }
      if (Array.isArray(data.days)) {
        setSchedule(data.days);
        if (data.days.length === 0) {
          setError('No matching records available for the selected route scope.');
        }
      }
    } catch {
      setError('Could not connect to the schedule service. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-3xl border border-slate-200 p-6 shadow-2xs space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-xs font-bold text-emerald-700">
              <MapPin className="w-4 h-4 text-emerald-600" />
              <span>9:00 AM – 3:00 PM Territory Field Route Planner</span>
            </div>
            <h1 className="text-2xl font-extrabold text-slate-900 tracking-tight">
              Roadmap &amp; Monthly Quota Exports
            </h1>
            <p className="text-xs text-slate-500">
              Automatically clusters nearby campuses by area and priority into daily 9am–3pm field schedules and exports Word, Excel, and PDF packs.
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={schools.length === 0}
              onClick={() => exportSchoolLabsExcel(schools)}
              className="px-3.5 py-2 bg-white border border-slate-300 hover:bg-slate-50 disabled:opacity-40 text-slate-800 font-bold text-xs rounded-xl flex items-center gap-1.5 cursor-pointer"
            >
              <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-600" />
              <span>School Labs Excel</span>
            </button>
            <button
              type="button"
              disabled={schools.length === 0}
              onClick={() =>
                void exportSchoolLabsWord(schools, {
                  title: 'Monthly Field Visit Roadmap & Lab Verification Plan',
                  officerName: session.name,
                })
              }
              className="px-3.5 py-2 bg-white border border-slate-300 hover:bg-slate-50 disabled:opacity-40 text-slate-800 font-bold text-xs rounded-xl flex items-center gap-1.5 cursor-pointer"
            >
              <FileText className="w-3.5 h-3.5 text-blue-600" />
              <span>School Roadmap Word (.docx)</span>
            </button>
            <button
              type="button"
              disabled={businessOnlyRecords.length === 0}
              onClick={() => exportBusinessResearchPdf(businessOnlyRecords)}
              className="px-3.5 py-2 bg-slate-900 hover:bg-slate-800 disabled:opacity-40 text-white font-bold text-xs rounded-xl flex items-center gap-1.5 cursor-pointer"
            >
              <FileText className="w-3.5 h-3.5" />
              <span>Business Research PDF ({businessOnlyRecords.length})</span>
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-end gap-3 pt-3 border-t border-slate-100 text-xs">
          <div className="space-y-1">
            <span className="font-bold text-slate-700 block">Route Scope</span>
            <div className="inline-flex bg-slate-100 p-0.5 rounded-xl border border-slate-200">
              <button
                type="button"
                onClick={() => setScope('SCHOOLS')}
                className={`px-3 py-1.5 rounded-lg font-bold cursor-pointer ${
                  scope === 'SCHOOLS' ? 'bg-white text-slate-900 shadow-2xs' : 'text-slate-500'
                }`}
              >
                Schools Only ({schools.length})
              </button>
              <button
                type="button"
                onClick={() => setScope('ALL')}
                className={`px-3 py-1.5 rounded-lg font-bold cursor-pointer ${
                  scope === 'ALL' ? 'bg-white text-slate-900 shadow-2xs' : 'text-slate-500'
                }`}
              >
                All Records ({fullList.length})
              </button>
            </div>
          </div>

          <label className="font-bold text-slate-700">
            Start Date
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="mt-1 block border border-slate-300 rounded-xl px-3 py-2 font-mono"
            />
          </label>
          <label className="font-bold text-slate-700">
            Visits Per Day (9 AM – 3 PM)
            <input
              type="number"
              min={1}
              max={8}
              value={schoolsPerDay}
              onChange={(e) => setSchoolsPerDay(Math.max(1, Math.min(8, Number(e.target.value) || 4)))}
              className="mt-1 block border border-slate-300 rounded-xl px-3 py-2 font-mono w-28"
            />
          </label>
          <button
            type="button"
            disabled={loading || activeRecords.length === 0}
            onClick={() => void generateSchedule()}
            className="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white font-bold rounded-xl flex items-center gap-1.5 cursor-pointer"
          >
            <Calendar className="w-3.5 h-3.5" />
            <span>{loading ? 'Building Schedule...' : `Generate 9to3 Route Plan (${activeRecords.length})`}</span>
          </button>
        </div>

        {error && (
          <div className="p-3 bg-rose-50 border border-rose-200 rounded-xl text-rose-800 text-xs font-semibold flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}
      </div>

      {schedule.length > 0 && (
        <div className="space-y-3">
          <div className="text-xs font-bold text-slate-700 px-1">
            Generated {schedule.length}-day field schedule covering {totalScheduledVisits}{' '}
            {scope === 'SCHOOLS' ? 'schools' : 'organizations'}.
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {schedule.map((day) => (
              <div key={day.dayNumber} className="bg-white border border-slate-200 rounded-2xl p-5 space-y-3 text-xs">
                <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                  <div>
                    <span className="font-extrabold text-slate-900 text-sm">Day {day.dayNumber}</span>
                    <span className="text-slate-500 ml-2 font-mono">{day.date}</span>
                  </div>
                  <span className="font-bold text-blue-700">{day.areaCluster}</span>
                </div>
                <div className="space-y-2">
                  {day.visits.map((v) => (
                    <div key={v.schoolId} className="p-2.5 bg-slate-50 rounded-xl border border-slate-100 flex items-start justify-between gap-2">
                      <div>
                        <div className="font-bold text-slate-900">{v.schoolName}</div>
                        <div className="text-[11px] text-slate-500">
                          {v.area}
                          {v.computerLab && v.computerLab !== 'N/A' ? ` · Lab: ${v.computerLab}` : ''}
                          {' · '}
                          {v.contactPhone}
                        </div>
                      </div>
                      <span className="font-mono font-bold text-slate-700 shrink-0">{v.slot}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

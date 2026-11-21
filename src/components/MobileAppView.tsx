import React, { useEffect, useState } from 'react';
import { CheckCircle2, Send, Smartphone, XCircle } from 'lucide-react';
import type { SchoolRecord, UserSession } from '../types';
import { appStore } from '../services/appStore';
import { formatLocation, isEducationRecord } from '../utils/schoolHelpers';

interface MobileAppViewProps {
  schools: SchoolRecord[];
  session: UserSession;
}

export const MobileAppView: React.FC<MobileAppViewProps> = ({ schools, session }) => {
  const [schoolId, setSchoolId] = useState(schools[0]?.id || '');
  const [labStatus, setLabStatus] = useState<'Yes' | 'No'>('Yes');
  const [computers, setComputers] = useState(20);
  const [notes, setNotes] = useState('');
  const [savedNotice, setSavedNotice] = useState('');

  useEffect(() => {
    if (!schoolId && schools.length > 0) {
      setSchoolId(schools[0].id);
    }
  }, [schoolId, schools]);

  const selected = schools.find((s) => s.id === schoolId) || schools[0];
  const selectedIsSchool = selected ? isEducationRecord(selected) : true;

  const handleQuickLog = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected) return;
    const isSchool = isEducationRecord(selected);
    appStore.addReport({
      schoolId: selected.id,
      schoolName: selected.name,
      schoolArea: formatLocation(selected.name, selected.area, selected.city, selected.state),
      officerId: session.id,
      officerName: session.name,
      visitDate: new Date().toISOString().slice(0, 10),
      visitDurationMinutes: 30,
      keyPersonMet: selected.contactPerson || (isSchool ? 'Principal / In-Charge' : 'Owner / Manager'),
      discussionNotes: notes.trim() || 'Mobile field check-in completed.',
      computerLabObserved: isSchool ? labStatus : 'Partial',
      computersCountObserved: isSchool && labStatus === 'Yes' ? computers : 0,
      internetWorking: isSchool ? labStatus === 'Yes' : false,
      actionItems: 'Follow up from mobile field log.',
      approvalStatus: 'SUBMITTED',
    });
    setNotes('');
    setSavedNotice(`Mobile check-in saved for ${selected.name}!`);
    setTimeout(() => setSavedNotice(''), 3500);
  };

  return (
    <div className="flex flex-col items-center py-4">
      <div className="w-full max-w-md bg-white rounded-3xl border border-slate-200 shadow-xl overflow-hidden">
        <div className="p-5 bg-slate-950 text-white flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Smartphone className="w-5 h-5 text-cyan-400" />
            <div>
              <h1 className="font-bold text-sm">Field Executive Mobile Check-In</h1>
              <p className="text-[11px] text-slate-400">{session.name} · {session.state}</p>
            </div>
          </div>
        </div>

        <form onSubmit={handleQuickLog} className="p-5 space-y-4 text-xs">
          {savedNotice && (
            <div className="p-3 bg-emerald-50 border border-emerald-200 text-emerald-900 rounded-xl font-bold">
              {savedNotice}
            </div>
          )}

          <label className="block font-bold text-slate-700">
            Select Organization
            <select
              value={selected?.id || ''}
              onChange={(e) => setSchoolId(e.target.value)}
              className="mt-1 w-full p-2.5 bg-slate-50 border border-slate-200 rounded-xl font-semibold"
            >
              {schools.length === 0 ? (
                <option value="">No organizations loaded yet</option>
              ) : (
                schools.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({formatLocation(s.name, s.area, s.city, s.state)})
                  </option>
                ))
              )}
            </select>
          </label>

          {selectedIsSchool && (
            <>
              <div className="space-y-1.5">
                <span className="font-bold text-slate-700 block">Computer Lab Verified On-Site</span>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setLabStatus('Yes')}
                    className={`p-2.5 rounded-xl font-bold border flex items-center justify-center gap-1.5 cursor-pointer ${
                      labStatus === 'Yes'
                        ? 'bg-emerald-600 text-white border-emerald-600'
                        : 'bg-slate-50 text-slate-700 border-slate-200'
                    }`}
                  >
                    <CheckCircle2 className="w-4 h-4" />
                    <span>Lab Active (Yes)</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setLabStatus('No')}
                    className={`p-2.5 rounded-xl font-bold border flex items-center justify-center gap-1.5 cursor-pointer ${
                      labStatus === 'No'
                        ? 'bg-rose-600 text-white border-rose-600'
                        : 'bg-slate-50 text-slate-700 border-slate-200'
                    }`}
                  >
                    <XCircle className="w-4 h-4" />
                    <span>No Lab Present</span>
                  </button>
                </div>
              </div>

              {labStatus === 'Yes' && (
                <label className="block font-bold text-slate-700">
                  Observed Computers Count
                  <input
                    type="number"
                    value={computers}
                    onChange={(e) => setComputers(parseInt(e.target.value, 10) || 0)}
                    className="mt-1 w-full p-2.5 bg-slate-50 border border-slate-200 rounded-xl font-mono font-bold"
                  />
                </label>
              )}
            </>
          )}

          <label className="block font-bold text-slate-700">
            Visit Notes
            <textarea
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={
                selectedIsSchool
                  ? 'Met with IT head, confirmed broadband & SkillX lab readiness...'
                  : 'Met with business owner, noted digital growth requirements...'
              }
              className="mt-1 w-full p-2.5 bg-slate-50 border border-slate-200 rounded-xl"
            />
          </label>

          <button
            type="submit"
            disabled={!selected}
            className="w-full py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white font-bold rounded-xl flex items-center justify-center gap-1.5 cursor-pointer"
          >
            <Send className="w-3.5 h-3.5" />
            <span>Submit Instant Visit Log</span>
          </button>
        </form>

        <div className="p-3 bg-slate-50 border-t border-slate-200 text-center text-[11px] text-slate-500">
          Natton SkillX Junior Mobile Field Client
        </div>
      </div>
    </div>
  );
};

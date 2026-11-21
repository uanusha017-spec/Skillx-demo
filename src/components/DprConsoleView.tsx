import React, { useEffect, useState } from 'react';
import { CheckCircle2, FileText, Send, ThumbsUp, XCircle } from 'lucide-react';
import type { DPRReport, SchoolRecord, UserSession } from '../types';
import { appStore } from '../services/appStore';
import { formatLocation, isEducationRecord } from '../utils/schoolHelpers';

interface DprConsoleViewProps {
  schools: SchoolRecord[];
  reports: DPRReport[];
  session: UserSession;
  preselectedSchool: SchoolRecord | null;
  onClearPreselected: () => void;
}

export const DprConsoleView: React.FC<DprConsoleViewProps> = ({
  schools,
  reports,
  session,
  preselectedSchool,
  onClearPreselected,
}) => {
  const [schoolId, setSchoolId] = useState(preselectedSchool?.id || schools[0]?.id || '');
  const [visitDate, setVisitDate] = useState(new Date().toISOString().slice(0, 10));
  const [duration, setDuration] = useState(45);
  const [personMet, setPersonMet] = useState('');
  const [labObserved, setLabObserved] = useState<'Yes' | 'No' | 'Partial'>('Yes');
  const [computersCount, setComputersCount] = useState(20);
  const [internetWorking, setInternetWorking] = useState(true);
  const [notes, setNotes] = useState('');
  const [actionItems, setActionItems] = useState('');
  const [feedback, setFeedback] = useState('');

  useEffect(() => {
    if (preselectedSchool) {
      setSchoolId(preselectedSchool.id);
      if (preselectedSchool.contactPerson) setPersonMet(preselectedSchool.contactPerson);
      onClearPreselected();
    }
  }, [preselectedSchool, onClearPreselected]);

  useEffect(() => {
    if (!schoolId && schools.length > 0) {
      setSchoolId(schools[0].id);
    }
  }, [schoolId, schools]);

  const selectedSchool = schools.find((s) => s.id === schoolId) || schools[0];
  const selectedIsSchool = selectedSchool ? isEducationRecord(selectedSchool) : true;
  const canApprove = session.role === 'SUPER_ADMIN' || session.role === 'ADMIN';

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedSchool) return;
    const isSchool = isEducationRecord(selectedSchool);
    appStore.addReport({
      schoolId: selectedSchool.id,
      schoolName: selectedSchool.name,
      schoolArea: formatLocation(selectedSchool.name, selectedSchool.area, selectedSchool.city, selectedSchool.state),
      officerId: session.id,
      officerName: session.name,
      visitDate,
      visitDurationMinutes: duration,
      keyPersonMet: personMet.trim() || (isSchool ? 'Principal / In-Charge' : 'Owner / Manager'),
      discussionNotes: notes.trim() || (isSchool ? 'Campus visit completed.' : 'Business consultation visit completed.'),
      computerLabObserved: isSchool ? labObserved : 'Partial',
      computersCountObserved: isSchool && labObserved !== 'No' ? computersCount : 0,
      internetWorking: isSchool ? internetWorking : false,
      actionItems: actionItems.trim() || 'Follow up within 7 days.',
      approvalStatus: 'SUBMITTED',
    });
    setFeedback(
      isSchool
        ? `DPR submitted for ${selectedSchool.name} and synced to the computer lab register.`
        : `DPR submitted for ${selectedSchool.name} and synced to the client visit register.`
    );
    setNotes('');
    setActionItems('');
    setTimeout(() => setFeedback(''), 4500);
  };

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-3xl border border-slate-200 p-6 shadow-2xs flex flex-wrap items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-xs font-bold text-indigo-700">
            <FileText className="w-4 h-4 text-indigo-600" />
            <span>Daily Progress Report (DPR) Management</span>
          </div>
          <h1 className="text-2xl font-extrabold text-slate-900 tracking-tight">Field Visit DPR Console</h1>
          <p className="text-xs text-slate-500">
            Log physical campus and business visits. Observed Computer Lab status automatically updates school records.
          </p>
        </div>
        <div className="text-xs font-bold text-slate-700 tabular-nums">
          {reports.length} Total DPRs · {reports.filter((r) => r.approvalStatus === 'APPROVED').length} Approved
        </div>
      </div>

      {feedback && (
        <div className="p-4 bg-emerald-50 border border-emerald-300 rounded-2xl text-emerald-950 font-bold text-xs flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
          <span>{feedback}</span>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <form
          onSubmit={handleSubmit}
          className="lg:col-span-5 bg-white rounded-3xl border border-slate-200 p-6 space-y-4 text-xs shadow-2xs"
        >
          <h2 className="text-base font-bold text-slate-900 border-b border-slate-100 pb-2">
            Submit New Daily Progress Report
          </h2>

          <label className="block font-bold text-slate-700">
            Select School / Business *
            <select
              value={selectedSchool?.id || ''}
              onChange={(e) => setSchoolId(e.target.value)}
              required
              className="mt-1 w-full p-2.5 bg-slate-50 border border-slate-200 rounded-xl font-semibold text-slate-900"
            >
              {schools.length === 0 ? (
                <option value="">Upload or discover organizations first</option>
              ) : (
                schools.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({formatLocation(s.name, s.area, s.city, s.state)})
                  </option>
                ))
              )}
            </select>
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block font-bold text-slate-700">
              Visit Date
              <input
                type="date"
                value={visitDate}
                onChange={(e) => setVisitDate(e.target.value)}
                required
                className="mt-1 w-full p-2.5 bg-slate-50 border border-slate-200 rounded-xl font-mono"
              />
            </label>
            <label className="block font-bold text-slate-700">
              Duration (mins)
              <input
                type="number"
                min={5}
                max={300}
                value={duration}
                onChange={(e) => setDuration(Number(e.target.value) || 30)}
                className="mt-1 w-full p-2.5 bg-slate-50 border border-slate-200 rounded-xl font-mono"
              />
            </label>
          </div>

          <label className="block font-bold text-slate-700">
            {selectedIsSchool ? 'Key Person Met (Principal / IT Head) *' : 'Key Person Met (Owner / Manager) *'}
            <input
              type="text"
              required
              value={personMet}
              onChange={(e) => setPersonMet(e.target.value)}
              placeholder={selectedIsSchool ? 'e.g. Dr. S. R. Patil (Principal)' : 'e.g. Rajesh Kulkarni (Owner)'}
              className="mt-1 w-full p-2.5 bg-slate-50 border border-slate-200 rounded-xl"
            />
          </label>

          {selectedIsSchool && (
            <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-2xl space-y-3">
              <div className="font-bold text-slate-800">Computer Lab Physical Observation</div>
              <div className="grid grid-cols-3 gap-2">
                {(['Yes', 'Partial', 'No'] as const).map((opt) => (
                  <button
                    key={opt}
                    type="button"
                    onClick={() => setLabObserved(opt)}
                    className={`py-2 rounded-xl font-bold border cursor-pointer ${
                      labObserved === opt
                        ? 'bg-slate-900 text-white border-slate-900'
                        : 'bg-white text-slate-700 border-slate-200'
                    }`}
                  >
                    {opt}
                  </button>
                ))}
              </div>
              {labObserved !== 'No' && (
                <div className="grid grid-cols-2 gap-3 items-center">
                  <label className="font-bold text-slate-700">
                    Computers Count
                    <input
                      type="number"
                      min={0}
                      value={computersCount}
                      onChange={(e) => setComputersCount(Number(e.target.value) || 0)}
                      className="mt-1 w-full p-2 bg-white border border-slate-300 rounded-lg font-mono"
                    />
                  </label>
                  <label className="flex items-center gap-2 font-bold text-slate-700 pt-4 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={internetWorking}
                      onChange={(e) => setInternetWorking(e.target.checked)}
                    />
                    <span>Broadband Active</span>
                  </label>
                </div>
              )}
            </div>
          )}

          <label className="block font-bold text-slate-700">
            Discussion Notes *
            <textarea
              rows={3}
              required
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Summarize meeting highlights, curriculum interest, and lab readiness..."
              className="mt-1 w-full p-2.5 bg-slate-50 border border-slate-200 rounded-xl"
            />
          </label>

          <label className="block font-bold text-slate-700">
            Next Action Items
            <input
              type="text"
              value={actionItems}
              onChange={(e) => setActionItems(e.target.value)}
              placeholder="e.g. Send SkillX proposal PDF & schedule demo"
              className="mt-1 w-full p-2.5 bg-slate-50 border border-slate-200 rounded-xl"
            />
          </label>

          <button
            type="submit"
            disabled={!selectedSchool}
            className="w-full py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white font-bold rounded-xl flex items-center justify-center gap-2 cursor-pointer"
          >
            <Send className="w-3.5 h-3.5" />
            <span>Submit DPR Report</span>
          </button>
        </form>

        <div className="lg:col-span-7 bg-white rounded-3xl border border-slate-200 p-6 space-y-4 shadow-2xs">
          <h2 className="text-base font-bold text-slate-900 border-b border-slate-100 pb-2">
            Submitted Daily Progress Reports ({reports.length})
          </h2>

          {reports.length === 0 ? (
            <p className="text-xs text-slate-500 py-8 text-center">
              No DPR submissions yet. Submit your first field visit report using the form.
            </p>
          ) : (
            <div className="space-y-3">
              {reports.map((rep) => (
                <div key={rep.id} className="p-4 border border-slate-200 rounded-2xl space-y-2 text-xs">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <h3 className="font-bold text-slate-900 text-sm">{rep.schoolName}</h3>
                      <p className="text-slate-500">
                        {rep.schoolArea} · Officer: {rep.officerName} · {rep.visitDate} ({rep.visitDurationMinutes}m)
                      </p>
                    </div>
                    <span
                      className={`font-bold ${
                        rep.approvalStatus === 'APPROVED'
                          ? 'text-emerald-700'
                          : rep.approvalStatus === 'NEEDS_REVISION'
                          ? 'text-rose-700'
                          : 'text-amber-700'
                      }`}
                    >
                      {rep.approvalStatus.replace(/_/g, ' ')}
                    </span>
                  </div>

                  {(() => {
                    const linked = schools.find((s) => s.id === rep.schoolId);
                    const repIsSchool = linked ? isEducationRecord(linked) : true;
                    return (
                      <div className="text-slate-700">
                        <strong>Person Met:</strong> {rep.keyPersonMet}
                        {repIsSchool && (
                          <>
                            {' · '}
                            <strong>Lab Observed:</strong> {rep.computerLabObserved}
                            {rep.computersCountObserved ? ` (${rep.computersCountObserved} PCs)` : ''}
                          </>
                        )}
                      </div>
                    );
                  })()}
                  <p className="text-slate-600">{rep.discussionNotes}</p>
                  {rep.actionItems && (
                    <p className="text-blue-800 font-medium">Next action: {rep.actionItems}</p>
                  )}

                  {canApprove && rep.approvalStatus !== 'APPROVED' && (
                    <div className="flex items-center gap-2 pt-2 border-t border-slate-100">
                      <button
                        type="button"
                        onClick={() => appStore.updateReportStatus(rep.id, 'APPROVED', 'Verified by Ops Admin')}
                        className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-lg inline-flex items-center gap-1 cursor-pointer"
                      >
                        <ThumbsUp className="w-3 h-3" />
                        <span>Approve DPR</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => appStore.updateReportStatus(rep.id, 'NEEDS_REVISION', 'Add lab photo/count')}
                        className="px-3 py-1.5 bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 font-bold rounded-lg inline-flex items-center gap-1 cursor-pointer"
                      >
                        <XCircle className="w-3 h-3" />
                        <span>Request Revision</span>
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

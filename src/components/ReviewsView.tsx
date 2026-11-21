import React, { useEffect, useState } from 'react';
import { CheckCircle2, Star, UserCheck } from 'lucide-react';
import type { FieldReview, SchoolRecord, UserSession } from '../types';
import { appStore } from '../services/appStore';
import { formatIST, formatLocation, isEducationRecord } from '../utils/schoolHelpers';

interface ReviewsViewProps {
  schools: SchoolRecord[];
  reviews: FieldReview[];
  session: UserSession;
  preselectedSchool?: SchoolRecord | null;
  onClearPreselected?: () => void;
}

export const ReviewsView: React.FC<ReviewsViewProps> = ({
  schools,
  reviews,
  session,
  preselectedSchool,
  onClearPreselected,
}) => {
  const [schoolId, setSchoolId] = useState(preselectedSchool?.id || schools[0]?.id || '');
  const [personMet, setPersonMet] = useState('Principal');
  const [rating, setRating] = useState(5);
  const [comment, setComment] = useState('');
  const [labVerified, setLabVerified] = useState(true);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    if (preselectedSchool) {
      setSchoolId(preselectedSchool.id);
      if (preselectedSchool.contactPerson) {
        setPersonMet(preselectedSchool.contactPerson);
      } else if (!isEducationRecord(preselectedSchool)) {
        setPersonMet('Owner / Manager');
      }
      onClearPreselected?.();
    }
  }, [preselectedSchool, onClearPreselected]);

  useEffect(() => {
    if (!schoolId && schools.length > 0) {
      setSchoolId(schools[0].id);
    }
  }, [schoolId, schools]);

  const selected = schools.find((s) => s.id === schoolId) || schools[0];
  const selectedIsSchool = selected ? isEducationRecord(selected) : true;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected) return;
    const isSchool = isEducationRecord(selected);
    appStore.addReview({
      schoolId: selected.id,
      schoolName: selected.name,
      reviewerName: session.name,
      reviewerRole: session.designation,
      personMet: personMet.trim() || (isSchool ? 'Principal / In-Charge' : 'Owner / Manager'),
      rating,
      comment:
        comment.trim() ||
        (isSchool
          ? 'Verified campus facilities and computer laboratory.'
          : 'Completed on-site business consultation and discovery visit.'),
      computerLabVerified: isSchool ? labVerified : false,
    });
    setNotice(`Review & Person Met saved for ${selected.name} and synced to DPR Reports.`);
    setComment('');
    setTimeout(() => setNotice(''), 4500);
  };

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-3xl border border-slate-200 p-6 shadow-2xs flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-xs font-bold text-amber-700">
            <UserCheck className="w-4 h-4 text-amber-600" />
            <span>Field Observations &amp; Official Visit Audits</span>
          </div>
          <h1 className="text-2xl font-extrabold text-slate-900 tracking-tight">
            School Reviews &amp; Person Met Logs
          </h1>
          <p className="text-xs text-slate-500 max-w-2xl">
            Audit logs from field representatives evaluating on-site visits. Person Met entries automatically sync with Daily Progress Reports (DPR).
          </p>
        </div>
        <span className="text-xs font-bold text-slate-700 tabular-nums">{reviews.length} Verified Reviews</span>
      </div>

      {notice && (
        <div className="p-4 bg-emerald-50 border border-emerald-300 rounded-2xl text-emerald-950 font-bold text-xs flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
          <span>{notice}</span>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <form
          onSubmit={handleSubmit}
          className="lg:col-span-5 bg-white rounded-3xl border border-slate-200 p-6 space-y-4 text-xs shadow-2xs"
        >
          <div className="border-b border-slate-100 pb-2">
            <h2 className="text-base font-bold text-slate-900">Add Visit Review &amp; Person Met Log</h2>
            <p className="text-slate-500">Automatically saved into this organization&apos;s DPR Report</p>
          </div>

          <label className="block font-bold text-slate-700">
            Select Target Organization *
            <select
              value={selected?.id || ''}
              onChange={(e) => setSchoolId(e.target.value)}
              className="mt-1 w-full p-2.5 bg-slate-50 border border-slate-200 rounded-xl font-semibold"
            >
              {schools.length === 0 ? (
                <option value="">No records loaded yet</option>
              ) : (
                schools.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({formatLocation(s.name, s.area, s.city, s.state)})
                  </option>
                ))
              )}
            </select>
          </label>

          <div className="p-3.5 bg-blue-50/70 border border-blue-200 rounded-2xl space-y-2">
            <label className="font-bold text-blue-950 block">Person Met (Representative) *</label>
            <input
              type="text"
              required
              value={personMet}
              onChange={(e) => setPersonMet(e.target.value)}
              placeholder={selectedIsSchool ? 'e.g. Dr. S. R. Patil (Principal)' : 'e.g. Business Owner / Operations Manager'}
              className="w-full p-2.5 bg-white border border-blue-300 rounded-xl font-bold text-slate-900"
            />
            <div className="flex flex-wrap gap-1.5">
              {(selectedIsSchool
                ? ['Principal', 'Headmaster', 'Vice Principal', 'IT / Lab Teacher', 'Trustee / Owner']
                : ['Founder / Owner', 'Managing Director', 'Marketing Head', 'Store Manager', 'Operations Lead']
              ).map((preset) => (
                <button
                  key={preset}
                  type="button"
                  onClick={() => setPersonMet(preset)}
                  className="text-[10px] px-2 py-0.5 bg-white hover:bg-blue-100 text-blue-800 font-bold rounded-lg border border-blue-200 cursor-pointer"
                >
                  + {preset}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1">
            <span className="font-bold text-slate-700 block">Visit Experience Rating (1–5)</span>
            <div className="flex items-center gap-1.5">
              {[1, 2, 3, 4, 5].map((star) => (
                <button
                  key={star}
                  type="button"
                  onClick={() => setRating(star)}
                  className="p-1 cursor-pointer"
                >
                  <Star
                    className={`w-6 h-6 ${star <= rating ? 'text-amber-500 fill-amber-500' : 'text-slate-300'}`}
                  />
                </button>
              ))}
              <span className="font-bold text-slate-600 ml-2">{rating} / 5</span>
            </div>
          </div>

          {selectedIsSchool && (
            <label className="flex items-center gap-2 p-3 bg-slate-50 border border-slate-200 rounded-2xl font-bold text-slate-800 cursor-pointer">
              <input
                type="checkbox"
                checked={labVerified}
                onChange={(e) => setLabVerified(e.target.checked)}
              />
              <span>Computer Lab was physically inspected during this visit</span>
            </label>
          )}

          <label className="block font-bold text-slate-700">
            Review Feedback &amp; Meeting Minutes *
            <textarea
              rows={3}
              required
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder={
                selectedIsSchool
                  ? 'Discussed partnership, met IT teacher, confirmed functional computers...'
                  : 'Discussed industry growth goals, website/lead-gen priorities, and proposal next steps...'
              }
              className="mt-1 w-full p-2.5 bg-slate-50 border border-slate-200 rounded-xl"
            />
          </label>

          <button
            type="submit"
            disabled={!selected}
            className="w-full py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white font-bold rounded-xl cursor-pointer"
          >
            Post Field Review &amp; Sync to DPR
          </button>
        </form>

        <div className="lg:col-span-7 bg-white rounded-3xl border border-slate-200 p-6 space-y-4 shadow-2xs">
          <h2 className="text-base font-bold text-slate-900 border-b border-slate-100 pb-2">
            Recent Field Reviews ({reviews.length})
          </h2>
          {reviews.length === 0 ? (
            <p className="text-xs text-slate-500 py-8 text-center">No reviews logged yet.</p>
          ) : (
            <div className="space-y-3">
              {reviews.map((rev) => (
                <div key={rev.id} className="p-4 border border-slate-200 rounded-2xl space-y-1.5 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="font-bold text-slate-900 text-sm">{rev.schoolName}</h3>
                    <span className="font-bold text-amber-600">{rev.rating} / 5 Stars</span>
                  </div>
                  <p className="text-slate-500">
                    Person Met: <strong className="text-slate-800">{rev.personMet}</strong> · By {rev.reviewerName} ·{' '}
                    {formatIST(rev.reviewedAt)}
                  </p>
                  <p className="text-slate-700">{rev.comment}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

import React from 'react';
import { CheckCircle2, Globe, Phone, ShieldCheck, X } from 'lucide-react';

interface SystemGuideModalProps {
  onClose: () => void;
}

export const SystemGuideModal: React.FC<SystemGuideModalProps> = ({ onClose }) => {
  return (
    <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="bg-white w-full max-w-2xl rounded-3xl shadow-2xl border border-slate-200 overflow-hidden flex flex-col max-h-[90vh]">
        <div className="p-6 bg-slate-950 text-white flex items-start justify-between">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-wider text-cyan-400">
              Platform Architecture &amp; Resolution Guide
            </p>
            <h2 className="text-xl font-bold mt-1">Campus Lab Finder — Natton SkillX Junior</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-white hover:bg-white/10 rounded-xl cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-5 overflow-y-auto text-xs text-slate-700">
          <div className="p-4 bg-emerald-50 border border-emerald-200 rounded-2xl space-y-2">
            <div className="font-bold text-emerald-950 flex items-center gap-2 text-sm">
              <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
              <span>Always-On Lifetime Server Search &amp; Industry AI</span>
            </div>
            <p className="leading-relaxed text-emerald-900">
              Live Google Search Grounding runs directly on the backend server via the platform&apos;s server-side Gemini API key (with optional SerpForge search support if configured in Settings &gt; Secrets). No browser API keys or recurring Serper credits are required.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="p-3.5 bg-slate-50 rounded-2xl border border-slate-200 space-y-1.5">
              <div className="font-bold text-slate-900 flex items-center gap-1.5">
                <Globe className="w-4 h-4 text-blue-600" />
                <span>School Lab Verification</span>
              </div>
              <p className="text-[11px] text-slate-600 leading-relaxed">
                Searches Google for every uploaded school (even without a website URL) to confirm Computer Lab / ICT Lab presence (Yes / No), computer count, broadband, and source link. Stops automatically at end of file.
              </p>
            </div>

            <div className="p-3.5 bg-slate-50 rounded-2xl border border-slate-200 space-y-1.5">
              <div className="font-bold text-slate-900 flex items-center gap-1.5">
                <Phone className="w-4 h-4 text-emerald-600" />
                <span>Missing Contact Lookup</span>
              </div>
              <p className="text-[11px] text-slate-600 leading-relaxed">
                Preserves valid contact numbers from your uploaded Excel sheet and automatically searches Google for every row where the phone number is blank or missing.
              </p>
            </div>

            <div className="p-3.5 bg-slate-50 rounded-2xl border border-slate-200 space-y-1.5">
              <div className="font-bold text-slate-900 flex items-center gap-1.5">
                <ShieldCheck className="w-4 h-4 text-indigo-600" />
                <span>Industry Analysis</span>
              </div>
              <p className="text-[11px] text-slate-600 leading-relaxed">
                Evaluates every business against criteria specific to its selected industry (Healthcare, Education, Hospitality, Real Estate, Manufacturing, Retail, etc.) with tailored Natton service recommendations and outreach pitches.
              </p>
            </div>
          </div>

          <div className="space-y-2">
            <h3 className="font-bold text-sm text-slate-900">Built-in Role Portals</h3>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <div className="p-3 bg-slate-50 rounded-xl border border-slate-200">
                <span className="font-bold block text-slate-900">Super Admin</span>
                <span className="text-slate-500 text-[10px] font-mono">superadmin@nattonskillx.in</span>
                <span className="text-[10px] text-slate-700 font-semibold block mt-1">All State Access</span>
              </div>
              <div className="p-3 bg-slate-50 rounded-xl border border-slate-200">
                <span className="font-bold block text-slate-900">Admin (Ops)</span>
                <span className="text-slate-500 text-[10px] font-mono">nattonskillxjunior@gmail.com</span>
                <span className="text-[10px] text-blue-700 font-semibold block mt-1">State Lead / Approver</span>
              </div>
              <div className="p-3 bg-slate-50 rounded-xl border border-slate-200">
                <span className="font-bold block text-slate-900">Field Officer</span>
                <span className="text-slate-500 text-[10px] font-mono">rohan.field@nattonskillx.in</span>
                <span className="text-[10px] text-emerald-700 font-semibold block mt-1">Field Visit Logger</span>
              </div>
            </div>
          </div>
        </div>

        <div className="p-4 bg-slate-50 border-t border-slate-200 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-5 py-2.5 bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs rounded-xl cursor-pointer"
          >
            Dismiss Guide
          </button>
        </div>
      </div>
    </div>
  );
};

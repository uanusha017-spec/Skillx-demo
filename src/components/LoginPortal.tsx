import React, { useEffect, useState } from 'react';
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  Crown,
  KeyRound,
  Shield,
  ShieldCheck,
  User,
} from 'lucide-react';
import type { UserRole, UserSession } from '../types';
import { apiFetch, readJsonSafe, setAccessToken } from '../services/apiClient';
import { appStore } from '../services/appStore';

interface LoginPortalProps {
  onLoginSuccess: (user: UserSession) => void;
}

export const LoginPortal: React.FC<LoginPortalProps> = ({ onLoginSuccess }) => {
  const [role, setRole] = useState<UserRole>('USER');
  const [email, setEmail] = useState('rohan.field@nattonskillx.in');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [checkingSetup, setCheckingSetup] = useState(true);

  useEffect(() => {
    let active = true;
    fetch('/api/auth/status')
      .then((r) => readJsonSafe<{ configured?: boolean }>(r))
      .then((data) => {
        if (active) {
          setNeedsSetup(!data.configured);
          setCheckingSetup(false);
        }
      })
      .catch(() => {
        if (active) setCheckingSetup(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const selectRole = (nextRole: UserRole) => {
    setRole(nextRole);
    setError(null);
    if (nextRole === 'SUPER_ADMIN') {
      setEmail('superadmin@nattonskillx.in');
    } else if (nextRole === 'ADMIN') {
      setEmail('nattonskillxjunior@gmail.com');
    } else {
      setEmail('rohan.field@nattonskillx.in');
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const endpoint = needsSetup ? '/api/auth/setup' : '/api/auth/login';
      const resp = await apiFetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await readJsonSafe<{
        user?: UserSession;
        accessToken?: string;
        error?: string;
        needsSetup?: boolean;
      }>(resp);

      if (!resp.ok) {
        if (data.needsSetup) setNeedsSetup(true);
        throw new Error(data.error || 'Authentication failed.');
      }
      if (!data.user?.id || !data.user?.role || !data.accessToken) {
        throw new Error('Server returned an incomplete session response.');
      }

      setAccessToken(data.accessToken);
      appStore.setSession(data.user);
      onLoginSuccess(data.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to sign in.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="brand-login min-h-screen flex flex-col items-center justify-center p-4 sm:p-6 text-slate-100 selection:bg-blue-600 selection:text-white">
      <div className="w-full max-w-xl space-y-6">
        <div className="text-center space-y-2">
          <div className="inline-flex items-center gap-2 text-blue-200 text-xs font-semibold tracking-wide">
            <ShieldCheck className="w-4 h-4 text-emerald-400" />
            <span>Role-Based Institutional Access Gateway</span>
          </div>
          <div className="py-2">
            <img
              src="/skillx-junior.png"
              alt="Natton SkillX Junior"
              className="brand-logo w-64 mx-auto p-2.5 object-contain"
              referrerPolicy="no-referrer"
            />
          </div>
          <p className="text-xs sm:text-sm text-slate-300 max-w-md mx-auto">
            Daily Progress Report (DPR) System, School Computer Lab Verification, Google Contact Enrichment &amp; Industry Business Intelligence
          </p>
        </div>

        <div className="bg-white text-slate-900 rounded-3xl p-6 sm:p-8 shadow-2xl border border-slate-200/80 space-y-6">
          <div>
            <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2 text-center">
              Select Your Access Tier / Login Tab
            </label>
            <div className="grid grid-cols-3 gap-1.5 p-1 bg-slate-100 rounded-2xl border border-slate-200 text-xs font-bold">
              <button
                type="button"
                onClick={() => selectRole('SUPER_ADMIN')}
                className={`py-2.5 px-2 rounded-xl flex flex-col items-center justify-center gap-1 transition-all cursor-pointer ${
                  role === 'SUPER_ADMIN'
                    ? 'bg-slate-900 text-white shadow-md'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <Crown className="w-4 h-4 text-amber-400" />
                <span className="truncate whitespace-nowrap">Super Admin</span>
              </button>
              <button
                type="button"
                onClick={() => selectRole('ADMIN')}
                className={`py-2.5 px-2 rounded-xl flex flex-col items-center justify-center gap-1 transition-all cursor-pointer ${
                  role === 'ADMIN'
                    ? 'bg-blue-700 text-white shadow-md'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <Shield className="w-4 h-4 text-blue-300" />
                <span className="truncate whitespace-nowrap">Admin (Ops)</span>
              </button>
              <button
                type="button"
                onClick={() => selectRole('USER')}
                className={`py-2.5 px-2 rounded-xl flex flex-col items-center justify-center gap-1 transition-all cursor-pointer ${
                  role === 'USER'
                    ? 'bg-emerald-700 text-white shadow-md'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <User className="w-4 h-4 text-emerald-300" />
                <span className="truncate whitespace-nowrap">Field User</span>
              </button>
            </div>
          </div>

          <div className="p-3.5 bg-slate-50 rounded-2xl border border-slate-200 text-xs space-y-1">
            <span className="font-bold text-slate-900 flex items-center gap-1.5">
              <CheckCircle2 className="w-4 h-4 text-blue-600" />
              <span>
                {role === 'SUPER_ADMIN' && 'Super Admin Access Privileges'}
                {role === 'ADMIN' && 'Admin (Operations Lead) Access Privileges'}
                {role === 'USER' && 'Field Executive Access Privileges'}
              </span>
            </span>
            <p className="text-[11px] text-slate-600 leading-relaxed">
              {role === 'SUPER_ADMIN' &&
                'Master authority: View all DPRs, run industry intelligence audits, verify school computer labs, approve roadmaps, and audit system data.'}
              {role === 'ADMIN' &&
                'Territory authority: Review and approve team Daily Progress Reports, import Excel datasets with Google contact enrichment, and export roadmaps to PDF/Word/Excel.'}
              {role === 'USER' &&
                'Outreach authority: Submit Daily Progress Reports (DPR), inspect computer labs, view high-priority Target First schools, and log field reviews.'}
            </p>
          </div>

          {!checkingSetup && needsSetup && (
            <div className="p-3.5 bg-blue-50 border border-blue-200 text-blue-950 rounded-2xl text-xs space-y-1">
              <div className="font-bold flex items-center gap-1.5">
                <KeyRound className="w-4 h-4 text-blue-600 shrink-0" />
                <span>First-Run Workspace Setup</span>
              </div>
              <p className="text-[11px] text-blue-800 leading-relaxed">
                Choose a workspace passcode (minimum 4 characters) to activate all three role portals. It is hashed securely on the server.
              </p>
            </div>
          )}

          {error && (
            <div className="p-3 bg-rose-50 border border-rose-200 text-rose-800 text-xs rounded-xl font-bold flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 text-rose-600" />
              <span>{error}</span>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4 text-xs">
            <div>
              <label className="block font-bold text-slate-700 mb-1">Email Address</label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full px-3.5 py-2.5 text-xs rounded-xl border border-slate-300 focus:ring-2 focus:ring-blue-600 focus:outline-none font-mono"
              />
            </div>

            <div>
              <label className="block font-bold text-slate-700 mb-1">
                {needsSetup ? 'Create Workspace Passcode' : 'Workspace Passcode'}
              </label>
              <input
                type="password"
                required
                minLength={4}
                autoComplete={needsSetup ? 'new-password' : 'current-password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={needsSetup ? 'Set a passcode (min 4 characters)' : 'Enter workspace passcode'}
                className="w-full px-3.5 py-2.5 text-xs rounded-xl border border-slate-300 focus:ring-2 focus:ring-blue-600 focus:outline-none font-mono"
              />
            </div>

            <button
              type="submit"
              disabled={loading || checkingSetup}
              className="w-full py-3 bg-blue-600 hover:bg-blue-700 active:bg-blue-800 disabled:opacity-50 text-white font-bold text-xs rounded-xl shadow-md transition-all flex items-center justify-center gap-2 cursor-pointer"
            >
              <span>
                {loading
                  ? 'Authenticating...'
                  : needsSetup
                  ? `Activate & Enter ${role.replace(/_/g, ' ')} Portal`
                  : `Authenticate & Enter ${role.replace(/_/g, ' ')} Portal`}
              </span>
              <ArrowRight className="w-4 h-4" />
            </button>
          </form>
        </div>
      </div>
    </div>
  );
};

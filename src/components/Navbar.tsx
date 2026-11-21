import React, { useState } from 'react';
import {
  BookOpen,
  Building2,
  FileText,
  LogOut,
  MapPin,
  Menu,
  Monitor,
  Smartphone,
  Star,
  Target,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import type { AppTab, UserSession } from '../types';

interface NavbarProps {
  currentTab: AppTab;
  onTabChange: (tab: AppTab) => void;
  session: UserSession;
  hasSchools: boolean;
  onOpenUpload: () => void;
  onOpenGuide: () => void;
  onSignOut: () => void;
  onClearSchools: () => void;
}

const NAV_TABS: Array<{ id: AppTab; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { id: 'BUSINESS_AUDIT', label: 'Businesses', icon: Building2 },
  { id: 'SCHOOL_LABS', label: 'School Labs & Route', icon: Monitor },
  { id: 'PRIORITY_TARGETING', label: 'Targets', icon: Target },
  { id: 'DPR_CONSOLE', label: 'Reports', icon: FileText },
  { id: 'ROADMAP_EXPORTS', label: 'Roadmap & Quotas', icon: MapPin },
  { id: 'MOBILE_APP', label: 'Mobile App', icon: Smartphone },
  { id: 'REVIEWS', label: 'Reviews & Person Met', icon: Star },
];

export const Navbar: React.FC<NavbarProps> = ({
  currentTab,
  onTabChange,
  session,
  hasSchools,
  onOpenUpload,
  onOpenGuide,
  onSignOut,
  onClearSchools,
}) => {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  const selectTab = (tab: AppTab) => {
    onTabChange(tab);
    setMobileOpen(false);
  };

  return (
    <header className="brand-header sticky top-0 z-40 bg-white/95 backdrop-blur-md border-b border-slate-200 shadow-2xs w-full max-w-full">
      <div className="bg-slate-950 text-white text-[11px] py-1.5 px-3 sm:px-6 flex items-center justify-between gap-3 w-full">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-bold text-slate-200 truncate">NATTON SKILLX JUNIOR</span>
          <span className="text-slate-600 hidden md:inline">·</span>
          <span className="text-slate-400 hidden md:inline whitespace-nowrap">
            Role: <strong className="text-white">{session.role.replace(/_/g, ' ')}</strong>
          </span>
          <span className="text-slate-600 hidden lg:inline">·</span>
          <span className="text-slate-400 hidden lg:inline truncate">{session.email}</span>
        </div>

        <div className="flex items-center gap-2 shrink-0 text-[11px]">
          {hasSchools && (
            <button
              type="button"
              onClick={() => setConfirmClear(true)}
              className="px-2.5 py-0.5 bg-slate-800 hover:bg-rose-900 text-rose-200 hover:text-white rounded font-semibold transition-colors flex items-center gap-1 border border-slate-700 cursor-pointer whitespace-nowrap shrink-0"
            >
              <Trash2 className="w-3 h-3" />
              <span className="hidden sm:inline">Clear Register</span>
              <span className="sm:hidden">Clear</span>
            </button>
          )}
          <button
            type="button"
            onClick={onOpenGuide}
            className="px-2.5 py-0.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded font-semibold transition-colors flex items-center gap-1 border border-slate-700 cursor-pointer whitespace-nowrap shrink-0"
          >
            <BookOpen className="w-3 h-3" />
            <span>Guide</span>
          </button>
          <button
            type="button"
            onClick={onSignOut}
            className="px-2.5 py-0.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded font-semibold transition-colors flex items-center gap-1 border border-slate-700 cursor-pointer whitespace-nowrap shrink-0"
          >
            <LogOut className="w-3 h-3" />
            <span>Sign Out</span>
          </button>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-3 sm:px-6 py-2.5 flex items-center justify-between gap-4">
        <button
          type="button"
          onClick={() => selectTab('BUSINESS_AUDIT')}
          className="flex items-center gap-2.5 shrink-0 cursor-pointer"
        >
          <img
            src="/skillx-junior.png"
            alt="Natton SkillX Junior"
            className="h-9 w-auto object-contain"
            referrerPolicy="no-referrer"
          />
        </button>

        <nav className="hidden xl:flex items-center gap-1 overflow-x-auto no-scrollbar">
          {NAV_TABS.map((tab) => {
            const Icon = tab.icon;
            const active = currentTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => selectTab(tab.id)}
                className={`px-3 py-2 rounded-xl text-xs font-bold transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer ${
                  active
                    ? 'bg-slate-900 text-white shadow-xs'
                    : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
                }`}
              >
                <Icon className="w-3.5 h-3.5 shrink-0" />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={onOpenUpload}
            className="px-3.5 py-2 bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs rounded-xl shadow-xs transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Upload className="w-3.5 h-3.5 shrink-0" />
            <span>Upload Excel</span>
          </button>

          <button
            type="button"
            onClick={() => setMobileOpen((v) => !v)}
            className="xl:hidden p-2 rounded-xl border border-slate-200 text-slate-700 hover:bg-slate-100 cursor-pointer"
            aria-label="Toggle navigation menu"
          >
            {mobileOpen ? <X className="w-4 h-4" /> : <Menu className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {mobileOpen && (
        <div className="xl:hidden border-t border-slate-200 bg-white px-3 py-2.5 grid grid-cols-2 sm:grid-cols-4 gap-1.5">
          {NAV_TABS.map((tab) => {
            const Icon = tab.icon;
            const active = currentTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => selectTab(tab.id)}
                className={`px-3 py-2 rounded-xl text-xs font-bold transition-colors flex items-center gap-1.5 whitespace-nowrap cursor-pointer ${
                  active ? 'bg-slate-900 text-white' : 'bg-slate-50 text-slate-700 hover:bg-slate-100'
                }`}
              >
                <Icon className="w-3.5 h-3.5 shrink-0" />
                <span className="truncate">{tab.label}</span>
              </button>
            );
          })}
        </div>
      )}

      {confirmClear && (
        <div className="fixed inset-0 z-50 bg-slate-950/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl border border-slate-200 max-w-md w-full p-6 shadow-2xl space-y-4">
            <h2 className="text-base font-bold text-slate-900">Clear active register?</h2>
            <p className="text-xs text-slate-600 leading-relaxed">
              This removes all uploaded schools, businesses, and upload batches from the active register on both your browser and the server. DPR reports and reviews are preserved.
            </p>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setConfirmClear(false)}
                className="px-4 py-2 text-xs font-bold rounded-xl border border-slate-300 text-slate-700 hover:bg-slate-50 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirmClear(false);
                  onClearSchools();
                }}
                className="px-4 py-2 text-xs font-bold rounded-xl bg-rose-600 hover:bg-rose-700 text-white cursor-pointer"
              >
                Clear Register
              </button>
            </div>
          </div>
        </div>
      )}
    </header>
  );
};

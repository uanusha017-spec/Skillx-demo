/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState } from 'react';
import type { AppTab, RecordEntityType, SchoolRecord } from './types';
import { appStore } from './services/appStore';
import { readJsonSafe } from './services/apiClient';
import { isBusinessRecord, isEducationRecord } from './utils/schoolHelpers';
import { LoginPortal } from './components/LoginPortal';
import { Navbar } from './components/Navbar';
import { BusinessResearchView } from './components/BusinessResearchView';
import { SchoolLabsView } from './components/SchoolLabsView';
import { PriorityTargetingView } from './components/PriorityTargetingView';
import { DprConsoleView } from './components/DprConsoleView';
import { RoadmapExportsView } from './components/RoadmapExportsView';
import { MobileAppView } from './components/MobileAppView';
import { ReviewsView } from './components/ReviewsView';
import { ExcelUploaderModal } from './components/ExcelUploaderModal';
import { SystemGuideModal } from './components/SystemGuideModal';

export default function App() {
  const [healthState, setHealthState] = useState<'checking' | 'ready' | 'unavailable'>('checking');
  const [healthError, setHealthError] = useState('');

  const [session, setSession] = useState(appStore.getSession());
  const [currentTab, setCurrentTab] = useState<AppTab>('BUSINESS_AUDIT');
  const [schools, setSchools] = useState(appStore.getSchools());
  const [storageStatus, setStorageStatus] = useState(appStore.getStorageStatus());
  const [reports, setReports] = useState(appStore.getReports());
  const [reviews, setReviews] = useState(appStore.getReviews());

  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadContext, setUploadContext] = useState<RecordEntityType>('SCHOOL');
  const [guideOpen, setGuideOpen] = useState(false);
  const [preselectedSchool, setPreselectedSchool] = useState<SchoolRecord | null>(null);
  const [preselectedReviewSchool, setPreselectedReviewSchool] = useState<SchoolRecord | null>(null);
  const [autoLabTrigger, setAutoLabTrigger] = useState(0);
  const [autoIndustryTrigger, setAutoIndustryTrigger] = useState(0);

  const checkHealth = async () => {
    setHealthState('checking');
    setHealthError('');
    try {
      const resp = await fetch('/api/health');
      const data = await readJsonSafe<{ ok?: boolean; error?: string }>(resp);
      if (!resp.ok || !data.ok) {
        throw new Error(data.error || 'Backend health check failed.');
      }
      setHealthState('ready');
    } catch (err) {
      setHealthError(err instanceof Error ? err.message : 'Unable to reach backend server.');
      setHealthState('unavailable');
    }
  };

  useEffect(() => {
    void checkHealth();
  }, []);

  useEffect(() => {
    const unsubscribe = appStore.subscribe(() => {
      setSession(appStore.getSession());
      setStorageStatus(appStore.getStorageStatus());
      setSchools(appStore.getSchools());
      setReports(appStore.getReports());
      setReviews(appStore.getReviews());
    });
    return unsubscribe;
  }, []);

  const handleSignOut = () => {
    appStore.setSession(null);
    setSession(null);
  };

  const handleSelectForDPR = (school: SchoolRecord) => {
    setPreselectedSchool(school);
    setCurrentTab('DPR_CONSOLE');
  };

  const handleSelectForReview = (school: SchoolRecord) => {
    setPreselectedReviewSchool(school);
    setCurrentTab('REVIEWS');
  };

  const openUploader = (ctx?: RecordEntityType) => {
    const inferred: RecordEntityType = ctx || (currentTab === 'BUSINESS_AUDIT' ? 'BUSINESS' : 'SCHOOL');
    setUploadContext(inferred);
    setUploadOpen(true);
  };

  if (healthState !== 'ready') {
    return (
      <main className="min-h-screen bg-slate-950 flex items-center justify-center p-6">
        <section className="max-w-xl w-full bg-white rounded-3xl p-8 space-y-4 shadow-2xl">
          <img
            src="/skillx-junior.png"
            alt="Natton SkillX Junior"
            className="w-48 object-contain"
            referrerPolicy="no-referrer"
          />
          <h1 className="text-xl font-bold text-slate-900">
            {healthState === 'checking' ? 'Connecting to Campus Lab Finder...' : 'Backend server unavailable'}
          </h1>
          <p className="text-sm text-slate-600" role="status">
            {healthState === 'checking'
              ? 'Verifying authentication, storage, and Google Search services.'
              : healthError}
          </p>
          {healthState === 'unavailable' && (
            <button
              type="button"
              onClick={() => void checkHealth()}
              className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2.5 rounded-xl font-bold text-sm cursor-pointer"
            >
              Retry Connection
            </button>
          )}
        </section>
      </main>
    );
  }

  if (!session) {
    return <LoginPortal onLoginSuccess={(u) => setSession(u)} />;
  }

  // Strict separation: Schools stay in School Labs; Businesses stay in Business Research
  const educationSchools = schools.filter(isEducationRecord);
  const businessRecords = schools.filter(isBusinessRecord);

  return (
    <div className="brand-page min-h-screen flex flex-col text-slate-900 selection:bg-blue-600 selection:text-white w-full max-w-full overflow-x-hidden">
      <Navbar
        currentTab={currentTab}
        onTabChange={setCurrentTab}
        session={session}
        hasSchools={schools.length > 0}
        onOpenUpload={() => openUploader()}
        onOpenGuide={() => setGuideOpen(true)}
        onSignOut={handleSignOut}
        onClearSchools={() => appStore.clearAllSchools()}
      />

      <div role="status" className="px-4 sm:px-6 py-1.5 text-xs text-slate-500 bg-white border-b border-slate-200/80">
        {storageStatus}
      </div>

      <main className="flex-1 max-w-7xl w-full mx-auto px-3 sm:px-6 py-4 sm:py-8 min-w-0">
        {currentTab === 'BUSINESS_AUDIT' && (
          <BusinessResearchView
            schools={businessRecords}
            onUpload={() => openUploader('BUSINESS')}
            autoRunQueueTrigger={autoIndustryTrigger}
          />
        )}

        {currentTab === 'SCHOOL_LABS' && (
          <SchoolLabsView
            schools={educationSchools}
            onSelectSchoolForDPR={handleSelectForDPR}
            onSelectSchoolForReview={handleSelectForReview}
            onOpenUpload={() => openUploader('SCHOOL')}
            autoVerifyTrigger={autoLabTrigger}
          />
        )}

        {currentTab === 'PRIORITY_TARGETING' && (
          <PriorityTargetingView
            schools={schools}
            session={session}
            onSelectForDPR={handleSelectForDPR}
            onSelectForLabCheck={() => setCurrentTab('SCHOOL_LABS')}
          />
        )}

        {currentTab === 'DPR_CONSOLE' && (
          <DprConsoleView
            schools={schools}
            reports={reports}
            session={session}
            preselectedSchool={preselectedSchool}
            onClearPreselected={() => setPreselectedSchool(null)}
          />
        )}

        {currentTab === 'ROADMAP_EXPORTS' && (
          <RoadmapExportsView schools={educationSchools} allRecords={schools} session={session} />
        )}

        {currentTab === 'MOBILE_APP' && (
          <MobileAppView schools={educationSchools.length > 0 ? educationSchools : schools} session={session} />
        )}

        {currentTab === 'REVIEWS' && (
          <ReviewsView
            schools={schools}
            reviews={reviews}
            session={session}
            preselectedSchool={preselectedReviewSchool}
            onClearPreselected={() => setPreselectedReviewSchool(null)}
          />
        )}
      </main>

      <footer className="mt-auto border-t border-slate-200/80 bg-white/70 py-4 px-6 text-center text-xs text-slate-500">
        <p className="font-medium">
          NATTON SKILLX JUNIOR · School Computer Lab Verification, Google Contact Lookup &amp; Industry Business Intelligence
        </p>
      </footer>

      {uploadOpen && (
        <ExcelUploaderModal
          defaultEntityType={uploadContext}
          onClose={() => setUploadOpen(false)}
          onSuccess={(filename, records, csvText, sheetNames, opts) => {
            appStore.addUploadedFile(filename, records, csvText, sheetNames, opts.entityType);
            setUploadOpen(false);
            if (opts.entityType === 'SCHOOL') {
              setCurrentTab('SCHOOL_LABS');
              if (opts.autoVerifyLabs) {
                setAutoLabTrigger((n) => n + 1);
              }
            } else {
              setCurrentTab('BUSINESS_AUDIT');
              if (opts.autoAnalyzeIndustry || opts.autoFetchMissingPhones) {
                setAutoIndustryTrigger((n) => n + 1);
              }
            }
          }}
        />
      )}

      {guideOpen && <SystemGuideModal onClose={() => setGuideOpen(false)} />}
    </div>
  );
}

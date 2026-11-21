export type UserRole = 'SUPER_ADMIN' | 'ADMIN' | 'USER';

export interface UserSession {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  designation: string;
  state: string;
}

export type ComputerLabStatus = 'Yes' | 'No' | 'Unverified';
export type LabVerificationSource = 'GOOGLE_SEARCH' | 'WEBSITE' | 'EXCEL' | 'VISIT' | 'SERPFORGE' | 'UNVERIFIED';
export type ContactSourceType = 'Uploaded Excel' | 'Google Search' | 'Official Website' | 'SerpForge' | 'Manual';
export type PriorityLevel = 'P1_CRITICAL' | 'P2_HIGH' | 'P3_MEDIUM' | 'P4_LOW';
export type AnalysisStatus = 'PENDING' | 'QUEUED' | 'CHECKING' | 'COMPLETED' | 'FAILED';
export type RecordEntityType = 'SCHOOL' | 'BUSINESS';

export interface ContactEvidenceItem {
  value: string;
  sourceUrl?: string;
  sourceType: ContactSourceType;
  confidence: 'High' | 'Medium' | 'Low';
  checkedAt: string;
}

export interface SocialProfileItem {
  platform: string;
  url: string;
  sourceUrl?: string;
}

export interface MetadataItem {
  label: string;
  value: string;
  sourceUrl?: string;
}

export interface FieldCoverageItem {
  field: string;
  status: 'Found' | 'Missing' | 'Unconfirmed';
  detail: string;
}

export interface MarketingIntentEvidence {
  text: string;
  sourceUrl?: string;
  date?: string;
}

export interface ResearchProfile {
  matchStatus: 'Verified' | 'Likely match' | 'Needs review' | 'No match';
  matchReason?: string;
  checkedAt: string;
  emails: ContactEvidenceItem[];
  phones: ContactEvidenceItem[];
  addresses: ContactEvidenceItem[];
  socialProfiles: SocialProfileItem[];
  metadata: MetadataItem[];
  fieldCoverage: FieldCoverageItem[];
  marketingIntent: {
    status: 'Public request found' | 'Growth signals detected' | 'No public request' | 'Unknown';
    summary: string;
    evidence: MarketingIntentEvidence[];
  };
  warnings: string[];
}

export interface DigitalCheckItem {
  service: string;
  status: 'Detected' | 'Not detected' | 'Needs review';
  evidence: string;
  sourceUrl?: string;
}

export interface GroundingSource {
  title: string;
  url: string;
  snippet?: string;
}

export interface DigitalAudit {
  checkedAt: string;
  websiteUrl?: string;
  identityStatus: string;
  checks: DigitalCheckItem[];
  recommendations: string[];
  sources: GroundingSource[];
  limitations: string[];
}

export interface WebsiteReviewCheck {
  label: string;
  result: 'Pass' | 'Improve' | 'Not detected';
  priority: 'High' | 'Medium' | 'Low';
  evidence: string;
  recommendation: string;
  sourceUrl?: string;
}

export interface WebsiteReview {
  checkedAt: string;
  verdict: string;
  summary: string;
  pagesInspected: string[];
  checks: WebsiteReviewCheck[];
  limitations: string[];
}

export type ServiceDemandState =
  | 'HAS_SERVICE'
  | 'NEEDS_UPGRADE'
  | 'MISSING_NEEDED'
  | 'ACTIVELY_SEEKING'
  | 'INTERNAL_UNCONFIRMED';

export interface ServiceAssessmentItem {
  id: string;
  name: string;
  group: string;
  status: 'Signals detected' | 'Improvement suggested' | 'Not detected' | 'Needs confirmation';
  demandState?: ServiceDemandState;
  evidence: Array<{ text: string; sourceUrl?: string }>;
  missingSignals: string[];
  recommendation: string;
  customerQuestions: string[];
}

export interface ServiceAssessment {
  version: number;
  checkedAt: string;
  services: ServiceAssessmentItem[];
}

export interface IndustryBenchmarkItem {
  criterion: string;
  status: 'Strong' | 'Partial' | 'Gap' | 'Unconfirmed';
  finding: string;
  impact: string;
}

export interface IndustryRecommendedService {
  serviceId: string;
  serviceName: string;
  priority: 'High' | 'Medium' | 'Low';
  rationale: string;
  expectedOutcome: string;
}

export interface IndustryAnalysis {
  industry: string;
  subCategory?: string;
  analyzedAt: string;
  maturityScore: number;
  maturityLabel: 'Advanced' | 'Developing' | 'Early Stage' | 'Needs Foundation';
  executiveSummary: string;
  industryContext: string;
  benchmarks: IndustryBenchmarkItem[];
  strengths: string[];
  gaps: string[];
  recommendedServices: IndustryRecommendedService[];
  outreachPitch: string;
  sources: GroundingSource[];
}

export interface SchoolRecord {
  id: string;
  name: string;
  recordType?: RecordEntityType;
  industry: string;
  area: string;
  city: string;
  state?: string;
  board?: string;
  code?: string;
  address?: string;
  website?: string;
  contactPerson?: string;
  contactPhone?: string;
  contactPhoneSource?: ContactSourceType;
  contactPhoneSourceUrl?: string;
  contactEmail?: string;
  contactEmailSource?: ContactSourceType;
  studentEnrollment?: number;
  sheetName?: string;
  mapsUrl?: string;

  // Computer Lab verification fields
  computerLab: ComputerLabStatus;
  computerLabSource?: LabVerificationSource;
  computerLabSourceUrl?: string;
  computerLabCheckedAt?: string;
  labComputersCount?: number | null;
  labInternetAvailable?: string;
  labConfidence?: number;
  labVerificationNote?: string;

  // Priority & Visit tracking
  priorityLevel: PriorityLevel;
  priorityScore: number;
  targetPriorityReason: string;
  daysSinceLastVisit: number;
  lastVisitedDate?: string;
  totalVisitsCount?: number;
  assignedOfficerName?: string;

  // Business intelligence & analysis
  targetServiceId?: string;
  analysisStatus?: AnalysisStatus;
  analysisError?: string;
  research?: ResearchProfile;
  digitalAudit?: DigitalAudit;
  websiteReview?: WebsiteReview;
  serviceAssessment?: ServiceAssessment;
  industryAnalysis?: IndustryAnalysis;
  uploadedData?: Record<string, string>;
}

export interface UploadedFileRecord {
  id: string;
  filename: string;
  recordType?: RecordEntityType;
  uploadedAt: string;
  recordsCount: number;
  records: SchoolRecord[];
  csvText?: string;
  sheetNames: string[];
  ownerId: string;
  ownerName: string;
  canVisit?: boolean;
  canShare?: boolean;
}

export interface DPRReport {
  id: string;
  schoolId: string;
  schoolName: string;
  schoolArea: string;
  officerId: string;
  officerName: string;
  visitDate: string;
  visitDurationMinutes: number;
  keyPersonMet: string;
  discussionNotes: string;
  computerLabObserved: 'Yes' | 'No' | 'Partial';
  computersCountObserved: number;
  internetWorking: boolean;
  actionItems: string;
  approvalStatus: 'SUBMITTED' | 'APPROVED' | 'NEEDS_REVISION';
  adminRemarks?: string;
  createdAt: string;
}

export interface FieldReview {
  id: string;
  schoolId: string;
  schoolName: string;
  reviewerName: string;
  reviewerRole: string;
  personMet: string;
  rating: number;
  comment: string;
  computerLabVerified: boolean;
  reviewedAt: string;
}

export type AppTab =
  | 'BUSINESS_AUDIT'
  | 'SCHOOL_LABS'
  | 'PRIORITY_TARGETING'
  | 'DPR_CONSOLE'
  | 'ROADMAP_EXPORTS'
  | 'MOBILE_APP'
  | 'REVIEWS';

export interface SearchEngineStatus {
  provider: 'gemini-search' | 'serpforge' | 'serpforge+gemini' | 'unconfigured';
  ready: boolean;
  lifetimeAccess: boolean;
  hasGemini: boolean;
  hasSerpForge: boolean;
  label: string;
  serpForgeDiagnostic?: {
    status: number;
    message: string;
    checkedAt: string;
  } | null;
  geminiDiagnostic?: {
    model: string;
    status: string;
    message: string;
    checkedAt: string;
  } | null;
}

export interface SchoolAutoVerifyStatus {
  status: 'IDLE' | 'RUNNING' | 'PAUSED' | 'COMPLETE';
  mode: 'LAB_AND_PHONE' | 'MISSING_PHONE_ONLY';
  total: number;
  checked: number;
  confirmedYes: number;
  confirmedNo: number;
  unverifiedCount: number;
  missingPhoneCount: number;
  phonesFetched: number;
  message: string;
  lastError?: string;
}

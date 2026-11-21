import type { SchoolRecord, ServiceAssessment, ServiceAssessmentItem } from '../types';

export interface NattonServiceDef {
  id: string;
  label: string;
  group: 'Digital marketing services' | 'Products & platforms' | 'Tailored solutions';
  checks: string[];
}

export const NATTON_SERVICE_GROUPS = [
  'Digital marketing services',
  'Products & platforms',
  'Tailored solutions',
] as const;

export const NATTON_SERVICES: NattonServiceDef[] = [
  { id: 'website', label: 'Website Design & Development', group: 'Digital marketing services', checks: ['Website development', 'Mobile responsiveness', 'Lead generation / booking'] },
  { id: 'seo', label: 'Search Engine Optimization (SEO)', group: 'Digital marketing services', checks: ['SEO: page title', 'SEO: meta description', 'SEO: heading', 'Structured data'] },
  { id: 'gbp', label: 'Google Business Profile (GMB/GBP)', group: 'Digital marketing services', checks: ['Google Business Profile'] },
  { id: 'google-ads', label: 'PPC & Google Ads Management', group: 'Digital marketing services', checks: ['Google Ads tracking', 'Paid ads tracking', 'Analytics setup'] },
  { id: 'social', label: 'Social Media Marketing', group: 'Digital marketing services', checks: ['Social media presence'] },
  { id: 'meta-ads', label: 'Meta Ads (Facebook & Instagram)', group: 'Digital marketing services', checks: ['Meta Ads tracking', 'Paid ads tracking', 'Social media presence'] },
  { id: 'content', label: 'Content Marketing & Blogging', group: 'Digital marketing services', checks: ['Content marketing'] },
  { id: 'aeo', label: 'AEO & AI Search Optimization', group: 'Digital marketing services', checks: ['AEO & FAQ structure', 'Structured data', 'Content marketing'] },
  { id: 'design', label: 'Graphic Design', group: 'Digital marketing services', checks: ['Brand & visual media', 'Social media presence'] },
  { id: 'email', label: 'Email Marketing & Automation', group: 'Digital marketing services', checks: ['Email marketing & newsletter'] },
  { id: 'ecommerce', label: 'E-commerce Website Development', group: 'Digital marketing services', checks: ['E-commerce functionality', 'Analytics setup'] },
  { id: 'analytics', label: 'Analytics & Conversion Rate Optimization', group: 'Digital marketing services', checks: ['Analytics setup', 'Lead generation / booking'] },
  { id: 'ai-growth', label: 'AI Growth Marketing', group: 'Digital marketing services', checks: ['Analytics setup', 'Content marketing', 'Paid ads tracking'] },
  { id: 'ai-marketing-saas', label: 'AI Marketing SaaS', group: 'Products & platforms', checks: ['CRM & marketing automation', 'Analytics setup'] },
  { id: 'crm', label: 'CRM & AI Automation SaaS', group: 'Products & platforms', checks: ['CRM & marketing automation', 'Lead generation / booking'] },
  { id: 'conversational', label: 'Conversational AI Hub', group: 'Products & platforms', checks: ['Live chat & conversational AI', 'WhatsApp automation'] },
  { id: 'whatsapp', label: 'WhatsApp Automation', group: 'Products & platforms', checks: ['WhatsApp automation', 'Lead generation / booking'] },
  { id: 'calling', label: 'AI Calling Agents', group: 'Products & platforms', checks: ['Cloud telephony & click-to-call'] },
  { id: 'telephony', label: 'Cloud Telephony Platform', group: 'Products & platforms', checks: ['Cloud telephony & click-to-call'] },
  { id: 'rcs', label: 'RCS Messaging Platform', group: 'Products & platforms', checks: ['WhatsApp automation', 'Email marketing & newsletter'] },
  { id: 'agents', label: 'AI Agents & Automation', group: 'Products & platforms', checks: ['Live chat & conversational AI', 'CRM & marketing automation'] },
  { id: 'natchat', label: 'NatChat - WhatsApp CRM', group: 'Products & platforms', checks: ['WhatsApp automation', 'CRM & marketing automation'] },
  { id: 'nativox', label: 'NatiVox - Voice AI', group: 'Products & platforms', checks: ['Cloud telephony & click-to-call'] },
  { id: 'growthos', label: 'GrowthOS', group: 'Tailored solutions', checks: ['Website development', 'SEO: page title', 'Analytics setup', 'Lead generation / booking'] },
  { id: 'businessos', label: 'BusinessOS', group: 'Tailored solutions', checks: ['CRM & marketing automation', 'Lead generation / booking'] },
  { id: 'agenticos', label: 'AgenticOS', group: 'Tailored solutions', checks: ['Live chat & conversational AI', 'CRM & marketing automation'] },
  { id: 'ai-platforms', label: 'AI Marketing Platforms', group: 'Tailored solutions', checks: ['Analytics setup', 'CRM & marketing automation', 'Paid ads tracking'] },
];

export const SCHOOL_INDUSTRY_SET = new Set([
  'Education',
  'Schools',
  'Colleges & Universities',
  'Coaching & Training',
]);

export const INDUSTRIES_LIST: string[] = [
  'Education',
  'Schools',
  'Colleges & Universities',
  'Coaching & Training',
  'Healthcare',
  'Hospitals',
  'Clinics',
  'Dental Clinics',
  'Pharmacies',
  'Diagnostics & Laboratories',
  'Wellness & Fitness',
  'Beauty Parlour',
  'Salons & Spas',
  'Real Estate',
  'Property Management',
  'Construction',
  'Architecture & Interior Design',
  'E-commerce',
  'Retail',
  'Fashion & Apparel',
  'Jewellery',
  'Electronics',
  'Furniture & Home Decor',
  'Grocery & Supermarkets',
  'IT Services',
  'Software & SaaS',
  'Web & App Development',
  'Cybersecurity',
  'Telecommunications',
  'Digital Marketing Agencies',
  'Professional Services',
  'Accounting & Tax Services',
  'Legal Services',
  'Consulting',
  'Recruitment & Staffing',
  'Financial Services',
  'Insurance',
  'Hospitality',
  'Hotels & Resorts',
  'Restaurants & Cafes',
  'Food & Beverage',
  'Travel & Tourism',
  'Events & Wedding Services',
  'Photography & Videography',
  'Media & Entertainment',
  'Sports & Recreation',
  'Manufacturing',
  'Industrial Equipment',
  'Automotive',
  'Vehicle Dealers & Repairs',
  'Logistics & Transportation',
  'Warehousing',
  'Agriculture',
  'Food Processing',
  'Energy & Solar',
  'Environmental Services',
  'Cleaning & Maintenance',
  'Home Services',
  'Security Services',
  'Printing & Packaging',
  'Import & Export',
  'Wholesale & Distribution',
  'Nonprofits & NGOs',
  'Government & Public Services',
  'Pet Care & Veterinary',
  'Art & Crafts',
  'Other / Custom Industry',
];

export const BUSINESS_INDUSTRIES_LIST: string[] = INDUSTRIES_LIST.filter(
  (ind) => !SCHOOL_INDUSTRY_SET.has(ind)
);

export const GENERAL_DISCOVERY_QUESTIONS: string[] = [
  'What are your main business goals for the next three months?',
  'Which products, services and locations are most important to promote?',
  'Where do your enquiries come from, and how many become customers?',
  'Which marketing channels or software do you currently use, and who manages them?',
  'Where are enquiries lost, responses delayed or follow-ups missed?',
  'What outcomes would make this project successful, and how will we measure them?',
  'What budget range, timeline and approval process should we plan around?',
  'Who is responsible for decisions, content approvals and ongoing operations?',
];

export const SERVICE_QUESTIONS: Record<string, string[]> = {
  website: [
    'What should visitors do on your website: call, book, enquire or buy?',
    'Which pages or mobile experiences cause problems, and when was the site last updated?',
  ],
  seo: [
    'Which services and locations should people find you for in Google?',
    'Can you share Search Console reports through an authorized read-only invitation to review search performance?',
  ],
  gbp: [
    'Do you own and verify your Google Business Profile for this location?',
    'Are the hours, contact details, categories, photos and reviews kept up to date?',
  ],
  'google-ads': [
    'Are Google Ads campaigns running, and what is your cost per qualified enquiry?',
    'Are calls, forms and sales measured as conversions, and which budget or campaign changes need approval?',
  ],
  social: [
    'Which social channels are actively managed and who approves posts?',
    'What audiences, content themes and enquiry outcomes matter most?',
  ],
  'meta-ads': [
    'Are Facebook or Instagram campaigns running, and what results do they generate?',
    'Is conversion tracking configured with the required consent, and who owns the ad account?',
  ],
  content: [
    'Which customer questions should your articles, videos or guides answer?',
    'Who can supply subject expertise and approve an ongoing content schedule?',
  ],
  aeo: [
    'Which questions should customers find clear answers to about your business?',
    'Do you have accurate FAQs, structured information and sources supporting your claims?',
  ],
  design: [
    'Do you have current logos, brand guidelines and reusable creative assets?',
    'Which brochures, advertisements or social designs need improvement?',
  ],
  email: [
    'Do you have an opted-in email audience and a process for unsubscribing?',
    'Which welcome, follow-up or retention campaigns are currently used?',
  ],
  ecommerce: [
    'Would online sales, payments, appointments or orders suit your business?',
    'Which catalogue, payment, stock, shipping and refund workflows need to connect?',
  ],
  analytics: [
    'Which actions count as a qualified enquiry or sale for your business?',
    'Can your team trace channel visits through to enquiries and completed sales?',
  ],
  'ai-growth': [
    'Where do campaign research, content or optimization take the most time?',
    'Which AI-assisted tasks can be piloted with human review and a measurable goal?',
  ],
  'ai-marketing-saas': [
    'Which marketing tools are already in use and where is work duplicated?',
    'Who will use the platform and approve generated campaign content?',
  ],
  crm: [
    'Where are leads stored and who owns each follow-up?',
    'Which pipeline stages, reminders, permissions and existing systems must be connected?',
  ],
  conversational: [
    'Which recurring customer questions and channels should an assistant handle?',
    'When should the conversation transfer to a person, and who maintains its answers?',
  ],
  whatsapp: [
    'How do you currently receive and follow up WhatsApp enquiries?',
    'Which opted-in messages, templates and human handovers would help the team?',
  ],
  calling: [
    'What calling tasks and languages are needed, and what consent rules apply?',
    'Which calls require a person, and how will call quality and escalation be reviewed?',
  ],
  telephony: [
    'Do missed calls, call routing or follow-up assignments cause lost enquiries?',
    'What numbers, routing rules, recording consent and CRM connections are required?',
  ],
  rcs: [
    'Which customer journeys would benefit from richer business messages?',
    'What opt-in records, message approvals and fallback channels are available?',
  ],
  agents: [
    'Which repetitive tasks follow clear rules and slow down customer response?',
    'What approval checkpoints should stay with staff?',
  ],
  natchat: [
    'Would a shared WhatsApp CRM inbox help track enquiries across team members?',
    'Which automated follow-up reminders would prevent lost leads?',
  ],
  nativox: [
    'How many inbound or follow-up calls go unanswered during peak hours?',
    'Which languages and scripts would a voice assistant need to support?',
  ],
  growthos: [
    'How do you currently coordinate website updates, SEO, ads, and enquiry tracking?',
    'Which weekly growth metrics would leadership want in one dashboard?',
  ],
  businessos: [
    'Which daily operations (inquiries, billing, scheduling, reporting) rely on manual spreadsheets?',
    'Which roles need separate access and approval views?',
  ],
  agenticos: [
    'Which multi-step outreach, verification, or customer support workflows could run semi-autonomously?',
    'What guardrails and human sign-off rules are required?',
  ],
  'ai-platforms': [
    'Do you need custom AI workflows tailored to your industry data and compliance needs?',
    'Which existing tools or CRMs would need integration?',
  ],
};

export const DOCUMENTS_CHECKLIST: string[] = [
  'Current website URL, hosting/CMS access overview (read-only audit)',
  'Google Business Profile ownership status and active location list',
  'Google Analytics 4 & Search Console read-only access (if configured)',
  'Current brochures, service catalog, or fee/pricing structure',
  'Brand logo files, color palette, and approved photography',
  'Current lead handling workflow (phone, WhatsApp, CRM, or spreadsheet)',
];

const INTERNAL_ONLY_SERVICES = new Set([
  'rcs',
  'businessos',
  'agenticos',
  'ai-marketing-saas',
  'ai-platforms',
]);

export function computeServiceAssessment(record: SchoolRecord): ServiceAssessment {
  const audit = record.digitalAudit;
  const checks = audit?.checks || [];
  const recommendedMap = new Map(
    (record.industryAnalysis?.recommendedServices || []).map((s) => [s.serviceId, s])
  );
  const industry = record.industry || (record.recordType === 'BUSINESS' ? 'General Business' : 'Education');
  const intentStatus = record.research?.marketingIntent?.status;
  const intentSummary = (record.research?.marketingIntent?.summary || '').toLowerCase();
  const hasPublicRequest = intentStatus === 'Public request found';

  const services: ServiceAssessmentItem[] = NATTON_SERVICES.map((def) => {
    const matchedChecks = checks.filter((c) => def.checks.includes(c.service));
    const detected = matchedChecks.filter((c) => c.status === 'Detected');
    const missing = matchedChecks.filter((c) => c.status === 'Not detected');
    const needsReview = matchedChecks.filter((c) => c.status === 'Needs review');
    const industryRec = recommendedMap.get(def.id);
    const isHighPriorityNeed = industryRec?.priority === 'High';

    const serviceKeywords = def.label
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 4 && !['services', 'platform', 'marketing', 'management', 'development', 'design'].includes(w));
    const intentMentionsService =
      hasPublicRequest ||
      (intentStatus === 'Growth signals detected' &&
        serviceKeywords.some((kw) => intentSummary.includes(kw)));

    let status: ServiceAssessmentItem['status'] = 'Needs confirmation';
    let demandState: ServiceAssessmentItem['demandState'] = 'INTERNAL_UNCONFIRMED';

    if (detected.length > 0 && missing.length === 0 && needsReview.length === 0) {
      status = 'Signals detected';
      demandState = 'HAS_SERVICE';
    } else if (detected.length > 0 && (missing.length > 0 || needsReview.length > 0)) {
      status = 'Improvement suggested';
      demandState = 'NEEDS_UPGRADE';
    } else if (missing.length > 0) {
      status = 'Not detected';
      if (intentMentionsService || isHighPriorityNeed) {
        demandState = 'ACTIVELY_SEEKING';
      } else if (INTERNAL_ONLY_SERVICES.has(def.id) && !audit?.websiteUrl) {
        status = 'Needs confirmation';
        demandState = 'INTERNAL_UNCONFIRMED';
      } else {
        demandState = 'MISSING_NEEDED';
      }
    } else if (industryRec) {
      status = isHighPriorityNeed ? 'Not detected' : 'Improvement suggested';
      demandState = isHighPriorityNeed ? 'ACTIVELY_SEEKING' : 'MISSING_NEEDED';
    } else {
      status = 'Needs confirmation';
      demandState = 'INTERNAL_UNCONFIRMED';
    }

    const evidence: Array<{ text: string; sourceUrl?: string }> = matchedChecks.map((c) => ({
      text: `${c.service}: ${c.evidence}`,
      sourceUrl: c.sourceUrl,
    }));

    if (industryRec) {
      evidence.push({
        text: `${industry} fit (${industryRec.priority} priority): ${industryRec.rationale}`,
      });
    } else if (evidence.length === 0) {
      evidence.push({
        text: audit?.websiteUrl
          ? `Inspected ${audit.websiteUrl}; internal tooling not publicly exposed — confirm in discovery call.`
          : `No official website inspected yet; run Industry Analysis or verify directly with the business.`,
      });
    }

    const missingSignals = missing.map((m) => `${m.service} not detected in live inspection`);
    if (def.id === 'website' && record.websiteReview) {
      missingSignals.push(
        ...record.websiteReview.checks
          .filter((c) => c.result === 'Improve' || c.result === 'Not detected')
          .map((c) => c.label)
      );
    }

    const recommendation =
      industryRec?.expectedOutcome ||
      (demandState === 'ACTIVELY_SEEKING'
        ? `High-priority ${industry} opportunity — pitch ${def.label} with concrete ROI examples.`
        : demandState === 'MISSING_NEEDED'
        ? `Not detected publicly — strong opportunity to introduce ${def.label} for ${industry}.`
        : demandState === 'NEEDS_UPGRADE'
        ? `Partially in place — propose upgrading ${def.label} to close conversion gaps.`
        : demandState === 'HAS_SERVICE'
        ? `Already active publicly — audit performance/ROI or cross-sell complementary Natton tools.`
        : `Internal capability not visible externally — confirm current setup with the decision-maker.`);

    return {
      id: def.id,
      name: def.label,
      group: def.group,
      status,
      demandState,
      evidence,
      missingSignals: [...new Set(missingSignals)],
      recommendation,
      customerQuestions: SERVICE_QUESTIONS[def.id] || [
        'Which current process needs improvement, and how would you measure success?',
      ],
    };
  });

  return {
    version: 2,
    checkedAt:
      record.industryAnalysis?.analyzedAt ||
      record.websiteReview?.checkedAt ||
      audit?.checkedAt ||
      new Date().toISOString(),
    services,
  };
}

export function getServiceAssessment(record: SchoolRecord): ServiceAssessment {
  if (
    record.serviceAssessment?.version === 2 &&
    record.serviceAssessment.services.length === NATTON_SERVICES.length
  ) {
    return record.serviceAssessment;
  }
  return computeServiceAssessment(record);
}

export function summarizeServiceAssessment(assessment: ServiceAssessment) {
  let hasService = 0;
  let needsUpgrade = 0;
  let missingNeeded = 0;
  let activelySeeking = 0;
  let internalCheck = 0;
  for (const s of assessment.services) {
    const d = s.demandState;
    if (d === 'HAS_SERVICE' || (!d && s.status === 'Signals detected')) hasService++;
    else if (d === 'NEEDS_UPGRADE' || (!d && s.status === 'Improvement suggested')) needsUpgrade++;
    else if (d === 'ACTIVELY_SEEKING') activelySeeking++;
    else if (d === 'MISSING_NEEDED' || (!d && s.status === 'Not detected')) missingNeeded++;
    else internalCheck++;
  }
  return {
    total: assessment.services.length,
    hasService,
    needsUpgrade,
    missingNeeded,
    activelySeeking,
    missingOrSeeking: missingNeeded + activelySeeking,
    internalCheck,
  };
}

import * as XLSX from 'xlsx';
import { Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } from 'docx';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import type { SchoolRecord } from '../types';
import {
  DOCUMENTS_CHECKLIST,
  GENERAL_DISCOVERY_QUESTIONS,
  getServiceAssessment,
  NATTON_SERVICES,
  SERVICE_QUESTIONS,
} from '../data/nattonCatalog';
import { createMapsUrl, formatIST, formatLocation, isEducationRecord, normalizeArea } from './schoolHelpers';

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function exportBusinessResearchExcel(records: SchoolRecord[], filename = 'business-research.xlsx') {
  const wb = XLSX.utils.book_new();

  const sheets: Record<string, Record<string, unknown>[]> = {
    Businesses: records.map((r) => {
      const assessment = getServiceAssessment(r);
      return {
        'Business ID': r.id,
        Name: r.name,
        Industry: r.industry || 'Business',
        'Sub-Category': r.industryAnalysis?.subCategory || '',
        City: r.city,
        Area: normalizeArea(r.name, r.area, r.city),
        Website: r.digitalAudit?.websiteUrl || r.website || '',
        'Contact Phone': r.contactPhone || '',
        'Phone Source': r.contactPhoneSource || (r.contactPhone ? 'Uploaded Excel' : 'Missing'),
        'Phone Source URL': r.contactPhoneSourceUrl || '',
        'Contact Email': r.contactEmail || '',
        Address: r.address || '',
        'Industry Maturity Score': r.industryAnalysis?.maturityScore ?? '',
        'Industry Maturity Level': r.industryAnalysis?.maturityLabel || 'Not analyzed',
        'Industry Executive Summary': r.industryAnalysis?.executiveSummary || '',
        'Top Recommended Services':
          r.industryAnalysis?.recommendedServices.map((s) => `${s.serviceName} (${s.priority})`).join('; ') || '',
        'Tailored Outreach Pitch': r.industryAnalysis?.outreachPitch || '',
        'Website Verdict': r.websiteReview?.verdict || 'Not assessed',
        'Services With Signals': assessment.services
          .filter((s) => s.status === 'Signals detected')
          .map((s) => s.name)
          .join('; '),
        'Analysis Status': r.analysisStatus || 'PENDING',
        'Checked At': formatIST(r.industryAnalysis?.analyzedAt || r.research?.checkedAt),
      };
    }),
    'Industry Analysis': records.flatMap((r) =>
      (r.industryAnalysis?.benchmarks || []).map((b) => ({
        'Business ID': r.id,
        Business: r.name,
        Industry: r.industry || 'Business',
        Criterion: b.criterion,
        Status: b.status,
        Finding: b.finding,
        Impact: b.impact,
      }))
    ),
    'Recommended Services': records.flatMap((r) =>
      (r.industryAnalysis?.recommendedServices || []).map((s) => ({
        'Business ID': r.id,
        Business: r.name,
        Industry: r.industry || 'Business',
        Service: s.serviceName,
        Priority: s.priority,
        Rationale: s.rationale,
        'Expected Outcome': s.expectedOutcome,
      }))
    ),
    'All Service Assessments': records.flatMap((r) =>
      getServiceAssessment(r).services.map((s) => ({
        'Business ID': r.id,
        Business: r.name,
        Industry: r.industry || 'Business',
        Service: s.name,
        Group: s.group,
        Assessment: s.status,
        Gaps: s.missingSignals.join('; ') || (s.status === 'Needs confirmation' ? 'Confirm with customer' : 'None'),
        Evidence: s.evidence.map((e) => e.text).join('; '),
        Recommendation: s.recommendation,
      }))
    ),
    Contacts: records.map((r) => ({
      'Business ID': r.id,
      Business: r.name,
      Industry: r.industry || 'Business',
      Phone: r.contactPhone || 'Not found',
      'Phone Source': r.contactPhoneSource || '',
      'Phone Source URL': r.contactPhoneSourceUrl || '',
      Email: r.contactEmail || '',
      'Email Source': r.contactEmailSource || '',
      'Contact Person': r.contactPerson || '',
      Website: r.website || '',
      Address: r.address || '',
    })),
    'Original Upload': records.flatMap((r) =>
      Object.entries(r.uploadedData || {}).map(([field, value]) => ({
        'Business ID': r.id,
        Business: r.name,
        Field: field,
        Value: value,
      }))
    ),
  };

  for (const [sheetName, rows] of Object.entries(sheets)) {
    const safeRows = rows.length ? rows : [{ Information: 'No data available for selected businesses.' }];
    const ws = XLSX.utils.json_to_sheet(safeRows);
    ws['!cols'] = Object.keys(safeRows[0]).map((k) => ({
      wch: /summary|pitch|evidence|rationale|url|address|finding/i.test(k) ? 48 : 24,
    }));
    XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31));
  }

  XLSX.writeFile(wb, filename);
}

export function exportSchoolLabsExcel(schools: SchoolRecord[]) {
  const rows = schools.map((s) => ({
    'School Name': s.name,
    Area: normalizeArea(s.name, s.area, s.city),
    City: s.city,
    State: s.state || '',
    Board: s.board || '',
    'Sheet Tab': s.sheetName || '',
    'Computer Lab': s.computerLab || 'Unverified',
    'Computers Count': s.labComputersCount ?? '',
    Broadband: s.labInternetAvailable || '',
    'Lab Verification Source': s.computerLabSource || '',
    'Lab Evidence Note': s.labVerificationNote || '',
    'Contact Person': s.contactPerson || '',
    'Contact Phone': s.contactPhone || '',
    'Phone Source': s.contactPhoneSource || (s.contactPhone ? 'Uploaded Excel' : 'Missing'),
    'Contact Email': s.contactEmail || '',
    Website: s.website || '',
    'Source URL': s.computerLabSourceUrl || s.website || '',
    'Verified Date': s.computerLabCheckedAt ? formatIST(s.computerLabCheckedAt) : 'Pending',
    'Google Maps Link': s.mapsUrl || createMapsUrl(s.name, s.area, s.city),
  }));
  const ws = XLSX.utils.json_to_sheet(rows.length ? rows : [{ Information: 'No school records available.' }]);
  ws['!cols'] = Object.keys(rows[0] || { Information: '' }).map((k) => ({
    wch: /note|url|link|website/i.test(k) ? 45 : 22,
  }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'School_Labs_Roadmap');
  XLSX.writeFile(wb, `Natton_SkillX_School_Labs_${new Date().toISOString().slice(0, 10)}.xlsx`);
}

export function exportPriorityTargetsExcel(schools: SchoolRecord[]) {
  const rows = schools.map((s) => {
    const isSchool = isEducationRecord(s);
    return {
      'Organization Name': s.name,
      'Record Type': isSchool ? 'School' : 'Business',
      Industry: s.industry || (isSchool ? 'Education' : 'Business'),
      'UDISE / Code': s.code || '',
      'Priority Level': s.priorityLevel,
      'Priority Score': s.priorityScore,
      Reason: s.targetPriorityReason,
      Location: formatLocation(s.name, s.area, s.city, s.state),
      Board: isSchool ? s.board || '' : '',
      Enrollment: isSchool ? s.studentEnrollment || '' : '',
      'Days Since Last Visit': s.daysSinceLastVisit,
      'Computer Lab Status': isSchool ? s.computerLab || 'Unverified' : 'N/A (Business)',
      'Contact Phone': s.contactPhone || '',
      'Phone Source': s.contactPhoneSource || '',
      'Assigned Officer': s.assignedOfficerName || '',
    };
  });
  const ws = XLSX.utils.json_to_sheet(rows.length ? rows : [{ Information: 'No priority targets.' }]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Priority_Targeting');
  XLSX.writeFile(wb, `Natton_SkillX_Priority_Targets_${new Date().toISOString().slice(0, 10)}.xlsx`);
}

export async function exportSchoolLabsWord(
  schools: SchoolRecord[],
  meta: { title?: string; period?: string; officerName?: string } = {}
) {
  const title = meta.title || 'School Labs Verification & Field Route Roadmap';
  const period = meta.period || new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const headerRow = new TableRow({
    children: ['School Name', 'Area / City', 'Computer Lab', 'Contact Phone (Source)', 'Evidence / Notes'].map(
      (text) =>
        new TableCell({
          children: [new Paragraph({ children: [new TextRun({ text, bold: true, size: 18 })] })],
        })
    ),
  });

  const dataRows = schools.map(
    (s) =>
      new TableRow({
        children: [
          s.name,
          formatLocation(s.name, s.area, s.city, s.state),
          `${s.computerLab}${s.labComputersCount ? ` (${s.labComputersCount} PCs)` : ''}`,
          s.contactPhone ? `${s.contactPhone} [${s.contactPhoneSource || 'Excel'}]` : 'Not found',
          s.labVerificationNote || 'Pending verification',
        ].map(
          (val) =>
            new TableCell({
              children: [new Paragraph({ children: [new TextRun({ text: String(val), size: 17 })] })],
            })
        ),
      })
  );

  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({
            text: 'NATTON SKILLX JUNIOR',
            heading: HeadingLevel.HEADING_3,
          }),
          new Paragraph({
            text: title,
            heading: HeadingLevel.HEADING_1,
          }),
          new Paragraph({
            children: [
              new TextRun({
                text: `Period: ${period} | Officer: ${meta.officerName || 'Field Officer'} | Schools: ${schools.length}`,
                color: '475569',
                size: 20,
              }),
            ],
            spacing: { after: 240 },
          }),
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: [headerRow, ...dataRows],
          }),
        ],
      },
    ],
  });

  const blob = await Packer.toBlob(doc);
  downloadBlob(blob, `Natton_SkillX_Roadmap_${new Date().toISOString().slice(0, 10)}.docx`);
}

export function exportBusinessResearchPdf(records: SchoolRecord[]) {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' });

  doc.setFontSize(10);
  doc.setTextColor(37, 99, 235);
  doc.text('NATTON SKILLX JUNIOR · BUSINESS INTELLIGENCE', 40, 40);

  doc.setFontSize(20);
  doc.setTextColor(15, 23, 42);
  doc.text('Industry Business Research Report', 40, 66);

  doc.setFontSize(9);
  doc.setTextColor(100, 116, 139);
  doc.text(`${records.length} selected organizations · Generated ${formatIST(new Date().toISOString())}`, 40, 84);

  autoTable(doc, {
    startY: 102,
    head: [['Business', 'Industry', 'Phone (Source)', 'Industry Maturity', 'Top Recommended Service']],
    body: records.map((r) => [
      `${r.name}\n${formatLocation(r.name, r.area, r.city, r.state)}`,
      r.industry || 'Business',
      r.contactPhone ? `${r.contactPhone}\n(${r.contactPhoneSource || 'Excel'})` : 'Pending lookup',
      r.industryAnalysis
        ? `${r.industryAnalysis.maturityScore}/100 (${r.industryAnalysis.maturityLabel})`
        : 'Pending analysis',
      r.industryAnalysis?.recommendedServices[0]?.serviceName || 'Pending analysis',
    ]),
    styles: { fontSize: 8, cellPadding: 6 },
    headStyles: { fillColor: [15, 23, 42], textColor: 255 },
  });

  records.forEach((r, idx) => {
    if (!r.industryAnalysis) return;
    doc.addPage();
    doc.setFontSize(14);
    doc.setTextColor(15, 23, 42);
    doc.text(`${idx + 1}. ${r.name}`, 40, 48);

    doc.setFontSize(9);
    doc.setTextColor(71, 85, 105);
    doc.text(
      `Industry: ${r.industry} (${r.industryAnalysis.subCategory || r.industry}) · Location: ${r.city || r.area} · Score: ${r.industryAnalysis.maturityScore}/100`,
      40,
      64
    );
    doc.text(
      `Phone: ${r.contactPhone || 'Not found'} (${r.contactPhoneSource || 'N/A'}) · Website: ${r.website || 'Not found'}`,
      40,
      78
    );

    const summaryLines = doc.splitTextToSize(r.industryAnalysis.executiveSummary, 515);
    doc.setTextColor(30, 41, 59);
    doc.text(summaryLines, 40, 100);

    const startBenchY = 108 + summaryLines.length * 12;
    autoTable(doc, {
      startY: startBenchY,
      head: [['Industry Criterion', 'Status', 'Finding', 'Impact']],
      body: r.industryAnalysis.benchmarks.map((b) => [b.criterion, b.status, b.finding, b.impact]),
      styles: { fontSize: 8, cellPadding: 5 },
      headStyles: { fillColor: [30, 64, 175], textColor: 255 },
    });

    const afterTableY = (doc as unknown as { lastAutoTable?: { finalY?: number } }).lastAutoTable?.finalY || startBenchY + 120;
    doc.setFontSize(10);
    doc.setTextColor(15, 23, 42);
    doc.text('Tailored Outreach Pitch:', 40, afterTableY + 24);
    doc.setFontSize(9);
    doc.setTextColor(51, 65, 85);
    doc.text(doc.splitTextToSize(r.industryAnalysis.outreachPitch, 515), 40, afterTableY + 40);
  });

  doc.save(`natton-business-research-${new Date().toISOString().slice(0, 10)}.pdf`);
}

export function exportCustomerDiscussionGuidePdf() {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' });
  doc.setFontSize(10);
  doc.setTextColor(37, 99, 235);
  doc.text('NATTON DIGITAL · CUSTOMER DISCOVERY GUIDE', 40, 40);

  doc.setFontSize(18);
  doc.setTextColor(15, 23, 42);
  doc.text('Customer Discovery & Service Discussion Guide', 40, 64);

  doc.setFontSize(9);
  doc.setTextColor(100, 116, 139);
  doc.text(`Generated ${formatIST(new Date().toISOString())}`, 40, 80);

  autoTable(doc, {
    startY: 98,
    head: [['#', 'Core Discovery Questions']],
    body: GENERAL_DISCOVERY_QUESTIONS.map((q, i) => [String(i + 1), q]),
    styles: { fontSize: 9, cellPadding: 6 },
    headStyles: { fillColor: [15, 23, 42] },
  });

  doc.addPage();
  autoTable(doc, {
    startY: 42,
    head: [['Natton Service / Product', 'Group', 'Key Customer Questions']],
    body: NATTON_SERVICES.map((s) => [s.label, s.group, (SERVICE_QUESTIONS[s.id] || []).join('\n')]),
    styles: { fontSize: 8, cellPadding: 5 },
    headStyles: { fillColor: [30, 64, 175] },
  });

  doc.addPage();
  autoTable(doc, {
    startY: 42,
    head: [['Documents & Authorized Access Checklist']],
    body: DOCUMENTS_CHECKLIST.map((item) => [item]),
    styles: { fontSize: 9, cellPadding: 6 },
    headStyles: { fillColor: [15, 23, 42] },
  });

  doc.save('natton-customer-discussion-guide.pdf');
}

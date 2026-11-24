// Turn raw ClinicalTrials.gov studies into backtest cases.
// Each case carries two separate inputs: what the forecaster may see (the
// registration record, with everything that reveals the outcome removed) and
// what the grader sees (the posted primary results).
// Usage: node src/prepare.mjs <raw.jsonl> <cases.jsonl> [live]
// With "live", the trials have not read out: every trial is kept, there is
// no grader input, and the forecaster may see the current status and the
// planned completion date, since both are public today.
import { readFileSync, writeFileSync } from "node:fs";
import { features, ruleLabel } from "./features.mjs";

const [rawPath, outPath, mode] = process.argv.slice(2);
if (!rawPath || !outPath || (mode && mode !== "live")) {
  console.error("usage: node src/prepare.mjs <raw.jsonl> <cases.jsonl> [live]");
  process.exit(1);
}
const live = mode === "live";

// A primary-results block larger than this is skipped rather than cut down,
// because a grader reading a truncated record could grade it wrong.
const MAX_LABEL_CHARS = 60_000;

const studies = readFileSync(rawPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

function forecastInput(p) {
  const id = p.identificationModule ?? {};
  const sponsor = p.sponsorCollaboratorsModule ?? {};
  const design = p.designModule ?? {};
  const desc = p.descriptionModule ?? {};
  const arms = p.armsInterventionsModule ?? {};
  const outcomes = p.outcomesModule ?? {};
  const elig = p.eligibilityModule ?? {};
  const locations = p.contactsLocationsModule?.locations ?? [];
  const countries = [...new Set(locations.map((l) => l.country).filter(Boolean))];

  // Deliberately left out: overall status, why-stopped, completion dates,
  // results dates, and references. Each can reveal how the trial ended.
  const record = {
    nctId: id.nctId,
    briefTitle: id.briefTitle,
    officialTitle: id.officialTitle,
    leadSponsor: sponsor.leadSponsor,
    collaborators: sponsor.collaborators,
    startDate: p.statusModule?.startDateStruct?.date,
    firstRegistered: p.statusModule?.studyFirstSubmitDate,
    hasDataMonitoringCommittee: p.oversightModule?.oversightHasDmc,
    conditions: p.conditionsModule?.conditions,
    keywords: p.conditionsModule?.keywords,
    phases: design.phases,
    design: design.designInfo,
    enrollment: design.enrollmentInfo?.count,
    briefSummary: desc.briefSummary,
    detailedDescription: desc.detailedDescription,
    arms: arms.armGroups,
    interventions: arms.interventions,
    primaryOutcomes: outcomes.primaryOutcomes,
    secondaryOutcomes: outcomes.secondaryOutcomes,
    eligibility: {
      criteria: elig.eligibilityCriteria,
      healthyVolunteers: elig.healthyVolunteers,
      sex: elig.sex,
      minimumAge: elig.minimumAge,
      maximumAge: elig.maximumAge,
    },
    siteCount: locations.length,
    countries,
    ...(live
      ? {
          overallStatus: p.statusModule?.overallStatus,
          enrollmentType: design.enrollmentInfo?.type,
          plannedPrimaryCompletion: p.statusModule?.primaryCompletionDateStruct?.date,
          recordLastUpdated: p.statusModule?.lastUpdatePostDateStruct?.date,
        }
      : {}),
  };
  return JSON.stringify(record, null, 1);
}

const counts = { total: studies.length, noPrimaryPValue: 0, tooLarge: 0, kept: 0 };
const lines = [];
for (const s of studies) {
  const p = s.protocolSection;
  if (live) {
    lines.push(
      JSON.stringify({
        nct: p.identificationModule.nctId,
        title: p.identificationModule.briefTitle,
        sponsor: p.sponsorCollaboratorsModule?.leadSponsor?.name ?? null,
        phase: (p.designModule?.phases ?? []).join("/"),
        sponsorClass: p.sponsorCollaboratorsModule?.leadSponsor?.class ?? "UNKNOWN",
        status: p.statusModule?.overallStatus,
        primaryCompletion: p.statusModule?.primaryCompletionDateStruct?.date ?? null,
        enrollment: p.designModule?.enrollmentInfo?.count ?? null,
        features: features(p),
        forecastInput: forecastInput(p),
      }),
    );
    counts.kept++;
    continue;
  }
  const primaries = (s.resultsSection?.outcomeMeasuresModule?.outcomeMeasures ?? []).filter(
    (o) => o.type === "PRIMARY",
  );
  if (!primaries.some((o) => (o.analyses ?? []).some((a) => a.pValue))) {
    counts.noPrimaryPValue++;
    continue;
  }
  const labelInput = JSON.stringify(primaries, null, 1);
  if (labelInput.length > MAX_LABEL_CHARS) {
    counts.tooLarge++;
    continue;
  }
  lines.push(
    JSON.stringify({
      nct: p.identificationModule.nctId,
      phase: (p.designModule?.phases ?? []).join("/"),
      sponsorClass: p.sponsorCollaboratorsModule?.leadSponsor?.class ?? "UNKNOWN",
      status: p.statusModule?.overallStatus,
      primaryCompletion: p.statusModule?.primaryCompletionDateStruct?.date ?? null,
      resultsPosted: p.statusModule?.resultsFirstPostDateStruct?.date ?? null,
      ruleLabel: ruleLabel(primaries),
      features: features(p),
      forecastInput: forecastInput(p),
      labelInput,
    }),
  );
  counts.kept++;
}

writeFileSync(outPath, lines.join("\n") + "\n");
console.log(counts);

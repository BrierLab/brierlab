// Shared by the batch tools and the site's worker: what the forecaster reads
// for one trial, and the exact text that is hashed when a forecast is sealed.
// Nothing here touches the file system, so it runs anywhere.

// The exact text that is hashed for one forecast. Field order is fixed, so
// the same forecast always produces the same hash.
export const leafText = (f) =>
  JSON.stringify({ nct: f.nct, method: f.method, probability: f.probability, model: f.model, madeAt: f.madeAt });

// One trial's registry record as the forecaster sees it. With live = true the
// trial has not read out, so its current status and planned finish are shown.
export function forecastInput(p, live = false) {
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

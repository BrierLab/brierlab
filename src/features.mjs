// Model-free helpers: a rule-based outcome label read straight from posted
// p-values, and a handful of numeric features taken from the registration
// record. Both exist so the AI forecaster has a plain statistical baseline
// to beat.

// ClinicalTrials.gov p-values are free text: ".8074", "<0.001", "=0.03".
export function parsePValue(text) {
  if (text == null) return null;
  const m = String(text).replace(/,/g, ".").match(/(\d*\.?\d+(?:[eE]-?\d+)?)/);
  if (!m) return null;
  const v = Number(m[1]);
  if (!Number.isFinite(v) || v < 0 || v > 1) return null;
  // ">0.05" means not significant, whatever the number says.
  if (/>/.test(text)) return Math.max(v, 0.5);
  return v;
}

// Rough label: was any analysis on the first primary outcome that has
// analyses significant at 0.05? It ignores direction and non-inferiority
// logic, so it is a baseline label, not ground truth.
export function ruleLabel(primaryOutcomes) {
  for (const o of primaryOutcomes) {
    const ps = (o.analyses ?? []).map((a) => parsePValue(a.pValue)).filter((p) => p != null);
    if (ps.length) return ps.some((p) => p < 0.05) ? 1 : 0;
  }
  return null;
}

const ONCOLOGY = /cancer|carcinoma|tumou?r|lymphoma|leuk(a)?emia|myeloma|melanoma|neoplasm|sarcoma|glioma/i;

export function features(p) {
  const design = p.designModule ?? {};
  const arms = p.armsInterventionsModule?.armGroups ?? [];
  const interventions = p.armsInterventionsModule?.interventions ?? [];
  const phases = design.phases ?? [];
  const masking = design.designInfo?.maskingInfo?.masking ?? "NONE";
  const conditionText = [...(p.conditionsModule?.conditions ?? []), ...(p.conditionsModule?.keywords ?? [])].join(" ");
  const titleText = [
    p.identificationModule?.briefTitle,
    p.identificationModule?.officialTitle,
    p.descriptionModule?.briefSummary,
  ].join(" ");
  const b = (x) => (x ? 1 : 0);
  return {
    phase3: b(phases.includes("PHASE3")),
    industry: b(p.sponsorCollaboratorsModule?.leadSponsor?.class === "INDUSTRY"),
    logEnrollment: Math.log10((design.enrollmentInfo?.count ?? 0) + 1),
    placeboControlled: b(arms.some((a) => a.type === "PLACEBO_COMPARATOR")),
    activeControlled: b(arms.some((a) => a.type === "ACTIVE_COMPARATOR")),
    blinded: b(["DOUBLE", "TRIPLE", "QUADRUPLE"].includes(masking)),
    armCount: arms.length,
    oncology: b(ONCOLOGY.test(conditionText)),
    biologic: b(interventions.some((i) => i.type === "BIOLOGICAL")),
    vaccine: b(/vaccin/i.test(titleText)),
    nonInferiority: b(/non-?inferior|equivalen/i.test(titleText)),
    hasMonitoringCommittee: b(p.oversightModule?.oversightHasDmc),
  };
}

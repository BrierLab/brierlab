// Features for the learned model. Two kinds:
//   1. facts read off the registration record (design, size, endpoint type);
//   2. track records: how earlier trials from the same sponsor, of the same
//      drug, in the same condition and with similar endpoints turned out,
//      counting only results that were public before this trial read out.
import { features as baseFeatures } from "./features.mjs";

const b = (x) => (x ? 1 : 0);
const AREAS = {
  oncology: /cancer|carcinoma|tumou?r|lymphoma|leuk(a)?emia|myeloma|melanoma|neoplasm|sarcoma|glioma|metasta/i,
  infection: /infect|hiv|hepatitis|influenza|covid|sars|pneumonia|sepsis|malaria|tubercul|bacter|viral|virus|fung/i,
  neuro: /alzheimer|parkinson|epilep|seizure|migraine|multiple sclerosis|neuropath|stroke|dementia|schizophren|depress|bipolar|anxiety|adhd|autism|insomnia/i,
  cardio: /cardi|heart|hypertens|atrial|coronary|thrombo|stroke|cholesterol|lipid|vascular/i,
  metabolic: /diabet|obes|glyc|insulin|metabolic|nash|fatty liver|weight/i,
  respiratory: /asthma|copd|pulmonary|respirat|cystic fibrosis|lung disease|bronch/i,
  immune: /arthritis|psoria|lupus|crohn|colitis|dermatitis|eczema|autoimmun|spondyl|inflammat/i,
  pain: /pain|analges|an(a)?esth|postoperative|opioid/i,
  eye: /macular|glaucoma|retin|ocular|dry eye|ophthalm|uveitis/i,
};
const ENDPOINTS = {
  epSurvival: /overall survival|progression.free|disease.free|event.free|time to (death|progression)/i,
  epResponse: /response rate|objective response|complete response|remission|responder|proportion of (patients|participants|subjects)|percentage of (patients|participants|subjects)/i,
  epChange: /change from baseline|change in|mean change|reduction in/i,
  epPk: /pharmacokinetic|\bauc\b|cmax|plasma concentration|bioequivalen|bioavailab/i,
  epSafety: /adverse event|safety|tolerab|toxicit|dose.limiting/i,
  epImmuno: /antibod|titer|seroconver|seroprotect|immunogenic|geometric mean/i,
  epScale: /score|scale|index|questionnaire|rating/i,
  epEvent: /incidence|occurrence|time to first|number of (events|episodes)|rate of/i,
};
const MASK = { NONE: 0, SINGLE: 1, DOUBLE: 2, TRIPLE: 3, QUADRUPLE: 4 };

const years = (text) => {
  const m = /(\d+)\s*(year|month|week|day)/i.exec(text ?? "");
  if (!m) return null;
  const k = { year: 1, month: 1 / 12, week: 1 / 52, day: 1 / 365 }[m[2].toLowerCase()];
  return Number(m[1]) * k;
};

export function time(text) {
  if (!text) return null;
  const t = Date.parse(text.length === 7 ? `${text}-15` : text);
  return Number.isFinite(t) ? t : null;
}

export function staticFeatures(p) {
  const design = p.designModule ?? {};
  const info = design.designInfo ?? {};
  const arms = p.armsInterventionsModule?.armGroups ?? [];
  const interventions = p.armsInterventionsModule?.interventions ?? [];
  const outcomes = p.outcomesModule ?? {};
  const elig = p.eligibilityModule ?? {};
  const sponsor = p.sponsorCollaboratorsModule ?? {};
  const loc = p.contactsLocationsModule ?? {};
  const sites = loc.siteCount ?? (loc.locations ?? []).length;
  const countries = loc.countries ?? [...new Set((loc.locations ?? []).map((l) => l.country).filter(Boolean))];
  const phases = design.phases ?? [];
  const conditionText = [...(p.conditionsModule?.conditions ?? []), ...(p.conditionsModule?.keywords ?? [])].join(" ");
  const endpointText = (outcomes.primaryOutcomes ?? []).map((o) => o.measure).join(" ; ");
  const start = time(p.statusModule?.startDateStruct?.date);
  const minAge = years(elig.minimumAge);
  const maxAge = years(elig.maximumAge);
  const cls = sponsor.leadSponsor?.class ?? "UNKNOWN";

  const f = { ...baseFeatures(p) };
  f.phase2only = b(phases.length === 1 && phases[0] === "PHASE2");
  f.phase2and3 = b(phases.includes("PHASE2") && phases.includes("PHASE3"));
  f.sponsorNih = b(cls === "NIH" || cls === "FED");
  f.sponsorAcademic = b(cls === "OTHER" || cls === "NETWORK");
  f.collaborators = (sponsor.collaborators ?? []).length;
  f.masking = MASK[info.maskingInfo?.masking ?? "NONE"] ?? 0;
  f.crossover = b(info.interventionModel === "CROSSOVER");
  f.factorial = b(info.interventionModel === "FACTORIAL");
  f.prevention = b(info.primaryPurpose === "PREVENTION");
  f.treatment = b(info.primaryPurpose === "TREATMENT");
  f.interventionCount = interventions.length;
  f.drugCount = interventions.filter((i) => i.type === "DRUG" || i.type === "BIOLOGICAL").length;
  f.primaryCount = (outcomes.primaryOutcomes ?? []).length;
  f.secondaryCount = Math.min((outcomes.secondaryOutcomes ?? []).length, 40);
  f.logSites = Math.log10(sites + 1);
  f.countryCount = countries.length;
  f.usOnly = b(countries.length === 1 && countries[0] === "United States");
  f.hasUs = b(countries.includes("United States"));
  f.startYear = start ? new Date(start).getUTCFullYear() + new Date(start).getUTCMonth() / 12 : 2015;
  f.healthyVolunteers = b(elig.healthyVolunteers);
  f.pediatric = b(maxAge != null && maxAge <= 18);
  f.adultsOnly = b(minAge != null && minAge >= 18);
  f.oneSex = b(elig.sex && elig.sex !== "ALL");
  f.logCriteria = Math.log10((elig.eligibilityCriteria ?? "").length + 1);
  f.logSummary = Math.log10((p.descriptionModule?.briefSummary ?? "").length + 1);
  for (const [name, re] of Object.entries(AREAS)) if (name !== "oncology") f[`area_${name}`] = b(re.test(conditionText));
  for (const [name, re] of Object.entries(ENDPOINTS)) f[name] = b(re.test(endpointText));
  return f;
}

const STOP = new Set(
  "the of and in to a at for with from by on or as is per that be an after during between than versus vs each all any using were was not time number patients participants subjects who percentage proportion baseline week weeks day days month months".split(" "),
);
const words = (text) => (text ?? "").toLowerCase().match(/[a-z][a-z-]{2,}/g)?.filter((w) => !STOP.has(w)) ?? [];
const CONTROL = /placebo|saline|vehicle|sham|standard of care|standard care|best supportive|usual care|no treatment|observation/i;

// Drug names as written on the record, with doses and brackets removed.
const drugName = (name) =>
  name
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .replace(/\b\d+(\.\d+)?\s*(mg|mcg|µg|ug|g|ml|iu|units?|%)(\/\w+)?\b/g, " ")
    .replace(/\b(tablets?|capsules?|injection|oral|solution|cream|gel|dose|low|high|group|arm)\b/g, " ")
    .replace(/[^a-z0-9-]+/g, " ")
    .trim();

// The keys a trial is filed under in each track record.
export function keys(p) {
  const interventions = p.armsInterventionsModule?.interventions ?? [];
  const outcomes = p.outcomesModule?.primaryOutcomes ?? [];
  const uniq = (list) => [...new Set(list.filter(Boolean))];
  return {
    sponsor: uniq([p.sponsorCollaboratorsModule?.leadSponsor?.name?.toLowerCase()]),
    drug: uniq(interventions.filter((i) => !CONTROL.test(i.name ?? "")).map((i) => drugName(i.name ?? ""))),
    condition: uniq((p.conditionsModule?.conditions ?? []).map((c) => c.toLowerCase().trim())),
    conditionWord: uniq((p.conditionsModule?.conditions ?? []).flatMap(words)),
    endpointWord: uniq(outcomes.flatMap((o) => words(o.measure))),
  };
}

export const GROUPS = ["sponsor", "drug", "condition", "conditionWord", "endpointWord"];

// Running tallies of outcomes per key. read() turns a trial's keys into
// features; add() files a finished trial. The caller decides the order, so a
// trial is only ever read against results that were public before it.
export class TrackRecord {
  constructor() {
    this.tables = Object.fromEntries(GROUPS.map((g) => [g, new Map()]));
    this.n = 0;
    this.met = 0;
  }
  add(k, label) {
    this.n++;
    this.met += label;
    for (const g of GROUPS) {
      for (const key of k[g]) {
        const row = this.tables[g].get(key) ?? [0, 0];
        row[0]++;
        row[1] += label;
        this.tables[g].set(key, row);
      }
    }
  }
  read(k) {
    const prior = this.n ? this.met / this.n : 0.5;
    const out = {};
    for (const g of GROUPS) {
      let n = 0;
      let met = 0;
      let lift = 0;
      let seen = 0;
      for (const key of k[g]) {
        const row = this.tables[g].get(key);
        if (!row) continue;
        n += row[0];
        met += row[1];
        // How far this key's own rate sits from the overall rate, shrunk toward zero when it has few trials.
        lift += (row[1] + 4 * prior) / (row[0] + 4) - prior;
        seen++;
      }
      out[`${g}_n`] = Math.log10(n + 1);
      out[`${g}_rate`] = (met + 6 * prior) / (n + 6) - prior;
      out[`${g}_lift`] = seen ? lift / seen : 0;
    }
    return out;
  }
}

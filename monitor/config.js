// config.js — what counts as a "remote role you care about"

// Role buckets and the keywords that map a job title into them.
// First matching bucket wins (order matters), so more specific buckets that
// share a keyword with another should come first.
export const ROLE_RULES = [
  { category: "Chat Support",     keywords: ["chat support", "live chat", "chat agent", "messaging support", "email support", "ticket support", "moderation", "community support", "social media support"] },
  { category: "Customer Service", keywords: ["customer service", "customer support", "csr", "customer care", "client service", "support specialist", "support representative", "help desk", "service desk", "customer experience", "client success", "customer success", "escalations", "complaints", "concierge"] },
  { category: "Call Center",      keywords: ["call center", "contact center", "call centre", "inbound", "outbound call", "phone agent", "telephone", "dialer", "phone support", "telephony"] },
  { category: "Data Entry",       keywords: ["data entry", "order entry", "data processor", "keying", "document processing", "transcription", "typist", "data specialist", "back office", "product listing", "data annotation"] },
  { category: "Medical Records",  keywords: ["medical records", "record retrieval", "release of information", "roi specialist", "health information", "him ", "medical coder", "records specialist", "prior authorization", "insurance verification", "eligibility", "claims processor", "medical scribe", "chart retrieval"] },
  { category: "Member Services",  keywords: ["member service", "patient access", "patient service", "claims processor", "enrollment", "benefits specialist", "intake coordinator", "scheduling coordinator", "appointment scheduler"] },
  { category: "Sales",            keywords: ["sales representative", "sales rep", "inside sales", "telesales", "telemarketer", "appointment setter", "business development rep", "account representative", "retention specialist", "lead generation", "virtual assistant", "collections"] },
];

// A job must look remote AND match at least one role bucket.
const REMOTE_HINTS = ["remote", "work from home", "wfh", "work-from-home", "telecommute", "virtual", "anywhere"];
const NON_REMOTE_TRAPS = ["hybrid", "on-site", "onsite", "in office", "in-office"]; // downgrade, don't hard-block

// ---- Equipment / BYOD detection --------------------------------------------
// CONFIRMED BYOD (the real target) = the posting requires the applicant's OWN
// computer/laptop AND lists computer specs (Windows 10/11, RAM, storage, CPU).
// Peripheral-only mentions (headset, webcam, internet) are NOT confirmed BYOD —
// they're a weaker "maybe" signal handled downstream.

// Computer specs — the tell-tale of a real "use your own machine" requirement.
const SPEC_RULES = [
  ["Windows 10/11", /\bwindows\s*1[01]\b/i],
  ["RAM",           /\b\d{1,3}\s*gb\b[^.]{0,15}\bram\b|\bram\b[^.]{0,15}\b\d{1,3}\s*gb\b|\b\d{1,3}\s*gb\s*ram\b/i],
  ["Storage/SSD",   /\b(ssd|solid[- ]state|hard\s*drive|\d{2,4}\s*gb\s*(ssd|storage|hdd)|\d\s*tb)\b/i],
  ["CPU/processor", /\b(cpu|processor|\d\.?\d?\s*ghz|i[3579]-?\d{3,}|ryzen|dual[- ]core|quad[- ]core)\b/i],
];

// Peripherals — a soft "maybe" signal only, never confirmed BYOD on their own.
const PERIPHERAL_RULES = [
  ["USB headset",    /\b(usb|wired)?\s*headset\b/i],
  ["Webcam",         /\bweb\s?cam(era)?\b/i],
  ["Dual monitors",  /\b(dual|two|second|2)\s+monitors?\b/i],
  ["Wired internet", /\b(ethernet|wired\s+(internet|connection)|hard[\s-]?wired)\b/i],
];

// The applicant must supply their OWN computer/laptop. Allow a few words between
// "own"/"personal" and the machine noun ("your own Windows 11 laptop").
const OWN_COMPUTER = [
  /\bown\b[^.]{0,30}?\b(laptop|computer|pc|desktop)\b/i,
  /\bpersonal\b[^.]{0,25}?\b(laptop|computer|pc|desktop)\b/i,
  /\b(must|need(?:s)?\s+to|required\s+to|able\s+to)\b[^.]{0,25}?\b(have|provide|own|supply|furnish|use)\b[^.]{0,25}?\b(laptop|computer|pc|desktop)\b/i,
  /\b(laptop|computer|pc|desktop)\s+(?:is\s+)?(required|needed|a\s+must|mandatory)\b/i,
  /\bown\s+(equipment|device)s?\b/i,
];

// A softer "bring your own" signal (no specs) — feeds the "likely" tier.
const SOFT_BYOD = [/\bbyod\b/i, /(provide|supply|bring|use)\s+your\s+own/i, /your\s+own\s+(equipment|laptop|computer|device)/i];

// Phrases that say the COMPANY supplies the gear -> suppress BYOD.
const PROVIDED_HINTS = [
  /\bprovided\b/, /\bsupplied\b/, /\bfurnished\b/,
  /(we|company|employer|client)(?:'?ll| will)?\s+(?:provide|ship|mail|send|supply|furnish|issue|give)\b/i,
  /(?:equipment|laptop|computer|hardware|headset|monitors?|devices?)\s+(?:is|are|will\s+be)\s+(?:provided|shipped|mailed|sent|supplied|furnished|issued|included)/i,
  /(?:ship|mail|send|sent|deliver)[a-z]*\s+(?:directly\s+)?to\s+your\s+(?:home|address|door|residence)/i,
  /(?:shipped|mailed|sent|delivered)\s+(?:directly\s+)?to\s+you\b/i,
  /company[-\s]?(?:provided|issued|furnished)/i,
  /provided\s+by\s+(?:the\s+)?(?:company|employer|us)/i,
];

// Returns { byod, equipment, softBYOD }.
//  - byod (CONFIRMED): own-computer requirement + at least one computer spec,
//    and the company doesn't say it provides the gear.
//  - equipment: matched spec + peripheral labels (for display).
//  - softBYOD: a "bring your own" signal without full specs (a "likely" hint).
function detectEquipment(hay) {
  const specs = SPEC_RULES.filter(([, re]) => re.test(hay)).map(([l]) => l);
  const peripherals = PERIPHERAL_RULES.filter(([, re]) => re.test(hay)).map(([l]) => l);
  const provided = PROVIDED_HINTS.some(re => re.test(hay));
  const ownComputer = OWN_COMPUTER.some(re => re.test(hay));
  const soft = SOFT_BYOD.some(re => re.test(hay)) || ownComputer;

  const byod = ownComputer && specs.length > 0 && !provided;   // CONFIRMED
  return { byod, equipment: [...specs, ...peripherals], softBYOD: soft && !provided && !byod };
}

export function classify(title = "", location = "", description = "") {
  const hay = `${title} ${location} ${description}`.toLowerCase();

  const looksRemote = REMOTE_HINTS.some(h => hay.includes(h));
  if (!looksRemote) return null;

  let matched = null;
  for (const rule of ROLE_RULES) {
    if (rule.keywords.some(k => hay.includes(k))) { matched = rule.category; break; }
  }
  if (!matched) return null;

  // Flag likely-hybrid so the dashboard can show it dimmer.
  const maybeHybrid = NON_REMOTE_TRAPS.some(h => hay.includes(h));
  const { byod, equipment, softBYOD } = detectEquipment(hay);
  return { category: matched, maybeHybrid, byod, equipment, softBYOD };
}

// ---- Pay + employment-type extraction (drive the dashboard's relevance sort) --
// BYOD roles tend to be low hourly ($10-18) and seasonal/temp/contract, so we
// surface those signals for ranking without hiding anything.

const money = n => (Number.isInteger(n) ? `${n}` : `${Math.round(n * 100) / 100}`);

// Format an hourly min/max into a display label. Shared by text + structured pay.
export function payLabel(min, max) {
  if (min == null && max == null) return "";
  if (min != null && max != null && min !== max) return `$${money(min)}–${money(max)}/hr`;
  const v = min ?? max;
  return `$${money(v)}/hr`;
}

// Pull an HOURLY pay range from free text. Returns { min, max, label }.
export function extractPay(text = "") {
  const t = String(text).replace(/,/g, " ");
  const hr = "(?:\\/|\\s|per\\s)?\\s*(?:hr|hour|hourly|an\\s*hour)\\b";
  // range: $15-$18/hr  |  15 to 18 per hour
  let m = t.match(new RegExp(`\\$?\\s*(\\d{1,3}(?:\\.\\d{1,2})?)\\s*(?:-|–|—|to)\\s*\\$?\\s*(\\d{1,3}(?:\\.\\d{1,2})?)\\s*${hr}`, "i"));
  if (m) { const a = Math.min(+m[1], +m[2]), b = Math.max(+m[1], +m[2]); return { min: a, max: b, label: payLabel(a, b) }; }
  // single: $16/hr  |  16.50 per hour
  m = t.match(new RegExp(`\\$?\\s*(\\d{1,3}(?:\\.\\d{1,2})?)\\s*${hr}`, "i"));
  if (m) { const a = +m[1]; if (a >= 5 && a <= 150) return { min: a, max: a, label: payLabel(a, a) }; }
  return { min: null, max: null, label: "" };
}

// Employment type; earlier patterns win (more specific first).
const EMPLOYMENT_RULES = [
  ["Temp-to-hire",  /(temp|contract)[-\s]*to[-\s]*(hire|perm)/i],
  ["Seasonal",      /\bseasonal\b/i],
  ["Temporary",     /\btemp(orary)?\b/i],
  ["Contract",      /\bcontract\b|\b1099\b|independent contractor/i],
  ["Part-time",     /\bpart[-\s]?time\b/i],
];
export function extractEmployment(text = "") {
  for (const [label, re] of EMPLOYMENT_RULES) if (re.test(text)) return label;
  return "";
}

// Stable id so the same posting is never alerted twice.
export function jobKey({ agency, title, url }) {
  const raw = `${agency}::${title}::${url}`.toLowerCase().replace(/\s+/g, " ").trim();
  // tiny djb2 hash -> short hex, no deps
  let h = 5381;
  for (let i = 0; i < raw.length; i++) h = ((h << 5) + h + raw.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

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
// Each item pairs a display label with the patterns that indicate it. Word
// boundaries keep short tokens (ram, cpu) from matching inside unrelated words
// like "program" or "capture".
const EQUIPMENT_RULES = [
  { label: "Windows 10/11 laptop",    patterns: [/windows\s*1[01]/, /windows (laptop|pc|computer)/] },
  { label: "USB/wired headset",       patterns: [/\b(usb|wired)\s+headset/, /\bheadset\b/] },
  { label: "Dual monitors",           patterns: [/\bdual\s+monitor/, /\btwo\s+monitor/, /\b2\s+monitor/, /\bsecond\s+monitor/] },
  { label: "Webcam",                  patterns: [/\bweb\s?cam(era)?\b/] },
  { label: "Wired/Ethernet internet", patterns: [/\bethernet\b/, /wired\s+(internet|connection)/, /hard[\s-]?wired/] },
  { label: "Minimum RAM/CPU specs",   patterns: [/\bram\b/, /\bcpu\b/, /\bghz\b/, /\bprocessor\b/] },
];

// Phrases that say the WORKER must supply the gear -> points to BYOD.
const BYOD_PHRASES = [
  /\bbyod\b/,
  /(provide|supply|bring|use)\s+your\s+own/,
  /your\s+own\s+(equipment|laptop|computer|device|pc)/,
  /own\s+(equipment|laptop|computer|device)/,
];

// Phrases that say the COMPANY supplies the gear -> suppress BYOD. Covers the
// many ways a posting says "we'll get equipment to you": provided/supplied/
// furnished, we (will) ship/mail/send/issue, "<gear> will be provided/shipped",
// and "shipped/mailed/sent to your home / to you".
const PROVIDED_HINTS = [
  /\bprovided\b/, /\bsupplied\b/, /\bfurnished\b/,
  /(we|company|employer|client)(?:'?ll| will)?\s+(?:provide|ship|mail|send|supply|furnish|issue|give)\b/i,
  /(?:equipment|laptop|computer|hardware|headset|monitors?|devices?)\s+(?:is|are|will\s+be)\s+(?:provided|shipped|mailed|sent|supplied|furnished|issued|included)/i,
  /(?:ship|mail|send|sent|deliver)[a-z]*\s+(?:directly\s+)?to\s+your\s+(?:home|address|door|residence)/i,
  /(?:shipped|mailed|sent|delivered)\s+(?:directly\s+)?to\s+you\b/i,
  /company[-\s]?(?:provided|issued|furnished)/i,
  /provided\s+by\s+(?:the\s+)?(?:company|employer|us)/i,
];

// Returns { byod, equipment }. `equipment` lists every gear item mentioned.
// `byod` is true only when that gear is stated as the worker's responsibility:
// an explicit "bring/use your own" phrase, or specific gear called out — unless
// the posting says the company provides/ships it (and there's no explicit BYOD).
function detectEquipment(hay) {
  const equipment = [];
  for (const item of EQUIPMENT_RULES) {
    if (item.patterns.some(re => re.test(hay))) equipment.push(item.label);
  }
  const hasStrong = BYOD_PHRASES.some(re => re.test(hay));
  const providerSupplies = PROVIDED_HINTS.some(re => re.test(hay));
  let byod = hasStrong || equipment.length > 0;
  if (providerSupplies && !hasStrong) byod = false;
  return { byod, equipment };
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
  const { byod, equipment } = detectEquipment(hay);
  return { category: matched, maybeHybrid, byod, equipment };
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

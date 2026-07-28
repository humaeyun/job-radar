// Tests for config.js classify() — run with `npm test` (node's built-in runner,
// no dependencies). Focus: role/remote matching, the Sales bucket, and BYOD
// detection (especially NOT flagging company-provided/shipped equipment).
import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, jobKey, extractPay, extractEmployment } from "../config.js";

const c = (desc, title = "Remote Customer Service", loc = "Remote") => classify(title, loc, desc);

test("matches remote + role buckets", () => {
  assert.equal(classify("Remote Customer Service Rep", "Remote", "").category, "Customer Service");
  assert.equal(classify("Chat Support Agent", "Work from home", "live chat").category, "Chat Support");
  assert.equal(classify("Data Entry Clerk", "Remote", "typist").category, "Data Entry");
});

test("new Sales bucket", () => {
  assert.equal(classify("Inside Sales Representative", "Remote", "telesales").category, "Sales");
  assert.equal(classify("Appointment Setter (WFH)", "Remote", "").category, "Sales");
});

test("non-remote or non-role returns null", () => {
  assert.equal(classify("Customer Service Rep", "Dallas, TX onsite", "on-site role"), null); // not remote
  assert.equal(classify("Warehouse Associate", "Remote", "forklift"), null);                 // no role bucket
});

test("hybrid is flagged but not blocked", () => {
  const t = classify("Remote Customer Service Rep", "Remote / Charlotte hybrid", "");
  assert.equal(t.category, "Customer Service");
  assert.equal(t.maybeHybrid, true);
});

test("CONFIRMED BYOD = own computer + specs", () => {
  for (const d of [
    "You must provide your own Windows 11 laptop with 8GB RAM.",
    "Use your own computer (Windows 10, 16 GB RAM, SSD).",
    "Requires a personal laptop with an i5 processor and 256GB storage.",
  ]) assert.equal(c(d).byod, true, `expected confirmed byod for: ${d}`);
});

test("NOT confirmed without specs or without own-computer", () => {
  assert.equal(c("Bring your own computer and webcam.").byod, false);       // no specs
  assert.equal(c("USB headset and wired internet required.").byod, false);  // peripherals only, no computer
  assert.equal(c("Provide your own laptop and USB headset.").byod, false);  // own computer but no specs
});

test("softBYOD flags bring-your-own without full specs", () => {
  assert.equal(c("Bring your own laptop.").softBYOD, true);
  assert.equal(c("You must provide your own Windows 11 laptop with 8GB RAM.").softBYOD, false); // confirmed, not soft
});

test("company provides/ships gear -> byod false", () => {
  for (const d of [
    "We will ship a Windows 11 laptop with 16GB RAM to your home.",
    "A company laptop (Windows 10, 8GB RAM) will be mailed to you.",
    "All equipment provided; own computer not required.",
    "Company-issued laptop with 16 GB RAM.",
  ]) assert.equal(c(d).byod, false, `expected byod=false for: ${d}`);
});

test("equipment detected (specs + peripherals), no RAM false-positive", () => {
  assert.ok(c("Use your own laptop: Windows 11, 8GB RAM, webcam.").equipment.includes("Windows 10/11"));
  assert.deepEqual(c("Requires a webcam and dual monitors.").equipment, ["Webcam", "Dual monitors"]);
  assert.equal(c("Join our program for remote customer service work.").equipment.length, 0); // 'program' must not match RAM
});

test("extractPay reads hourly rates", () => {
  assert.deepEqual(extractPay("16/Hr REMOTE CSR"), { min: 16, max: 16, label: "$16/hr" });
  assert.deepEqual(extractPay("$15-$18 per hour"), { min: 15, max: 18, label: "$15–18/hr" });
  assert.equal(extractPay("competitive pay").label, "");     // no rate
  assert.equal(extractPay("$45,000/year").label, "");        // yearly, not hourly text
});

test("extractEmployment reads job type", () => {
  assert.equal(extractEmployment("Temp-to-Hire Data Entry"), "Temp-to-hire");
  assert.equal(extractEmployment("Seasonal Remote CSR"), "Seasonal");
  assert.equal(extractEmployment("Contract Customer Service (1099)"), "Contract");
  assert.equal(extractEmployment("Full-time remote rep"), "");
});

test("jobKey is stable and deterministic", () => {
  const j = { agency: "Acme", title: "Remote CSR", url: "https://x/y" };
  assert.equal(jobKey(j), jobKey({ ...j }));
});

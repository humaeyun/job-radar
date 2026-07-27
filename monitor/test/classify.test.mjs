// Tests for config.js classify() — run with `npm test` (node's built-in runner,
// no dependencies). Focus: role/remote matching, the Sales bucket, and BYOD
// detection (especially NOT flagging company-provided/shipped equipment).
import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, jobKey } from "../config.js";

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

test("BYOD required -> byod true", () => {
  for (const d of [
    "You must provide your own laptop and USB headset.",
    "Bring your own computer and webcam.",
    "Requires your own dual monitors.",
    "BYOD environment; must have wired ethernet.",
    "We provide paid training; you supply your own laptop and headset.", // BYOD wins over provider phrase
  ]) assert.equal(c(d).byod, true, `expected byod=true for: ${d}`);
});

test("company provides/ships gear -> byod false", () => {
  for (const d of [
    "Equipment Provided and shipped directly to your home.",
    "We will ship a company laptop, USB headset and dual monitors to your home.",
    "A Windows 11 laptop and headset will be mailed to you.",
    "All equipment will be provided.",
    "Company-issued laptop and headset.",
    "Your laptop and monitor will be sent to you before day one.",
  ]) assert.equal(c(d).byod, false, `expected byod=false for: ${d}`);
});

test("equipment items are detected without RAM false-positives", () => {
  assert.deepEqual(c("Requires your own dual monitors and a webcam.").equipment, ["Dual monitors", "Webcam"]);
  assert.equal(c("Join our program for remote customer service work.").equipment.length, 0); // 'program' must not match RAM
});

test("jobKey is stable and deterministic", () => {
  const j = { agency: "Acme", title: "Remote CSR", url: "https://x/y" };
  assert.equal(jobKey(j), jobKey({ ...j }));
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluate, findVendor, isLookalike, scoreOf, skeleton, verdictFor, type BillFields, type Vendor } from "../src/rules.ts";

const grainger: Vendor = {
  id: "grainger",
  name: "Grainger",
  aliases: ["W.W. Grainger"],
  domains: ["grainger.com"],
  phone: "1-800-472-4643",
  bankLast4: "8841",
  contactUrl: "https://www.grainger.com/content/general-contact-us",
};

const bill = (over: Partial<BillFields> = {}): BillFields => ({
  vendorName: "Grainger",
  fromEmail: "ar@grainger.com",
  replyTo: "",
  phone: "1-800-472-4643",
  bankLast4: "8841",
  bankChangeClaimed: false,
  invoiceNumber: "1",
  amount: "100.00",
  urgencyQuote: "",
  ...over,
});

const verdict = (b: BillFields, age: Parameters<typeof evaluate>[0]["domainAge"] = null, vendor: Vendor | null = grainger) =>
  verdictFor(scoreOf(evaluate({ bill: b, vendor, domainAge: age, sitePhones: ["8004724643"] })));

test("lookalikes are caught", () => {
  for (const d of ["gra1nger.com", "graingerr.com", "grainger.co", "graingre.com", "grainger-billing.com", "xn--gringer-8fg.com"]) {
    assert.equal(isLookalike(d, "grainger.com"), true, d);
  }
});

test("the real domain and its subdomains are not lookalikes", () => {
  assert.equal(isLookalike("grainger.com", "grainger.com"), false);
  assert.equal(isLookalike("mail.grainger.com", "grainger.com"), false);
});

test("unrelated names are not lookalikes", () => {
  for (const d of ["gmail.com", "proton.me", "stripe.com", "ranger.com"]) {
    assert.equal(isLookalike(d, "graybar.com"), false, d);
  }
  assert.equal(isLookalike("online.com", "uline.com"), false);
});

test("skeleton folds the look-alike letters", () => {
  assert.equal(skeleton("gra1nger"), skeleton("grainger"));
  assert.equal(skeleton("rnerck"), skeleton("merck"));
});

test("a clean bill passes with no signals", () => {
  assert.deepEqual(evaluate({ bill: bill(), vendor: grainger, domainAge: null, sitePhones: ["8004724643"] }), []);
  assert.equal(verdict(bill()), "PASS");
});

test("a bank change alone holds", () => {
  assert.equal(verdict(bill({ bankLast4: "3307" })), "HOLD");
});

test("urgent wording alone cannot hold a bill", () => {
  assert.equal(verdict(bill({ urgencyQuote: "pay today" })), "PASS");
});

test("a lookalike with a new domain, new bank and wrong phone blocks", () => {
  const b = bill({ fromEmail: "x@gra1nger.com", bankLast4: "4471", phone: "415-555-0142" });
  assert.equal(verdict(b, { status: "ok", days: 12, registered: "2026-10-18" }), "BLOCK");
});

test("an unknown vendor on an unregistered domain blocks", () => {
  const b = bill({ vendorName: "Ghost LLC", fromEmail: "x@ghost-site.com" });
  assert.equal(verdict(b, { status: "missing" }, null), "BLOCK");
});

test("a failed domain lookup adds no points", () => {
  assert.equal(verdict(bill(), { status: "error", message: "timeout" }), "PASS");
});

test("a site that could not be fetched still compares the vendor list", () => {
  const signals = evaluate({ bill: bill({ phone: "415-555-0142" }), vendor: grainger, domainAge: null, sitePhones: null });
  assert.deepEqual(signals.map((s) => s.id), ["phone_mismatch"]);
});

test("the vendor is found by name, then by domain, then by lookalike", () => {
  assert.equal(findVendor("W.W. Grainger, Inc.", "", [grainger])?.id, "grainger");
  assert.equal(findVendor("", "grainger.com", [grainger])?.id, "grainger");
  assert.equal(findVendor("Somebody", "gra1nger.com", [grainger])?.id, "grainger");
  assert.equal(findVendor("Somebody", "stripe.com", [grainger]), null);
});

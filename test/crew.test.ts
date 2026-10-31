import assert from "node:assert/strict";
import { test } from "node:test";
import { compareDocument } from "../src/agents/examiner.ts";
import { askFor, invoiceLabel } from "../src/agents/liaison.ts";
import { opening, savings } from "../src/agents/negotiator.ts";
import { canNegotiate, isVerified, recommend } from "../src/crew.ts";
import type { Case, CrewState } from "../src/pipeline.ts";
import { evaluate, type BillFields, type Vendor } from "../src/rules.ts";

const vendor: Vendor = {
  id: "sherwin",
  name: "Sherwin-Williams",
  aliases: ["Sherwin Williams"],
  domains: ["sherwin-williams.com"],
  phone: "1-800-474-3794",
  bankLast4: "5173",
  contactUrl: "https://www.sherwin-williams.com/contact-us",
};

const fields = { docType: "bank letter", holderName: "Sherwin-Williams", accountLast4: "3307", bankName: "Harbor", documentDate: "2026-10-28", anomalies: [] as string[] };
const crew = (over: Partial<CrewState> = {}): CrewState => ({ phase: "examining", channel: "the board", chat: [], documents: [], verified: false, ...over });
const flagged = (...ids: string[]) => ({ signals: ids.map((id) => ({ id })), bill: { invoiceNumber: "77310", amount: "18240.00", fromEmail: "a@evil.test" } }) as unknown as Case;

test("a matching document is consistent", () => {
  assert.equal(compareDocument(fields, "3307", vendor).verdict, "consistent");
});

test("a document for another company fails, whatever the model thought of it", () => {
  assert.equal(compareDocument({ ...fields, holderName: "SW Remit Services LLC" }, "3307", vendor).verdict, "inconsistent");
});

test("a document for another account fails", () => {
  assert.equal(compareDocument({ ...fields, accountLast4: "9918" }, "3307", vendor).verdict, "inconsistent");
});

test("a sign of tampering fails a document that otherwise matches", () => {
  assert.equal(compareDocument({ ...fields, anomalies: ["The digits look altered."] }, "3307", vendor).verdict, "inconsistent");
});

test("a document with no account number proves nothing", () => {
  assert.equal(compareDocument({ ...fields, accountLast4: "" }, "3307", vendor).verdict, "unreadable");
});

test("a bill from a wrong sender asks if the vendor sent it, not for a bank letter", () => {
  const ask = askFor(flagged("lookalike", "bank_changed"), vendor);
  assert.equal(ask.needs, "confirmation");
  assert.match(ask.message, /Did your company send this/);
});

test("a bank change from the right sender asks for a document", () => {
  const ask = askFor(flagged("bank_changed"), vendor);
  assert.equal(ask.needs, "document");
  assert.match(ask.message, /bank letter/);
});

test("the first message never states the bank digits on file", () => {
  assert.doesNotMatch(askFor(flagged("bank_changed"), vendor).message, /5173/);
});

test("a denial and a bad document both recommend rejecting", () => {
  assert.match(recommend(crew({ outcome: "denied" })), /^Reject/);
  assert.match(recommend(crew({ documents: [{ name: "x", verdict: "inconsistent", notes: [] }] })), /^Reject/);
});

test("an unknown vendor has nobody safe to contact", () => {
  assert.match(recommend(crew(), false), /no trusted contact/);
});

test("a blocked bill never gets a discount offer, even with a verified vendor", () => {
  assert.equal(canNegotiate({ verdict: "BLOCK", crew: crew({ verified: true }) }), false);
  assert.equal(canNegotiate({ verdict: "HOLD", crew: crew({ verified: true }) }), true);
  assert.equal(canNegotiate({ verdict: "HOLD", crew: crew({ verified: false }) }), false);
});

test("a yes does not meet a request for a document", () => {
  const k = crew({ needs: "document", outcome: "confirmed" });
  assert.equal(isVerified(k), false);
  assert.match(recommend(k), /^Not proven/);
});

test("a yes does answer a question", () => {
  assert.equal(isVerified(crew({ needs: "confirmation", outcome: "confirmed" })), true);
});

test("a denial or refusal beats a matching document", () => {
  const good = [{ name: "x", verdict: "consistent" as const, notes: [] }];
  assert.equal(isVerified(crew({ outcome: "denied", documents: good })), false);
  assert.equal(isVerified(crew({ outcome: "refused", documents: good })), false);
  assert.match(recommend(crew({ outcome: "refused", documents: good })), /^Reject/);
});

test("a matching document verifies, and a bad one does not", () => {
  assert.equal(isVerified(crew({ needs: "document", documents: [{ name: "x", verdict: "consistent", notes: [] }] })), true);
  assert.equal(isVerified(crew({ needs: "document", documents: [{ name: "x", verdict: "unreadable", notes: [] }] })), false);
});

test("the report only claims the trusted line when it was the real one", () => {
  assert.match(recommend(crew({ outcome: "confirmed", channel: "iMessage" })), /trusted line/);
  assert.match(recommend(crew({ outcome: "confirmed", channel: "the board" })), /board stand-in/);
});

test("a planted From line never reaches the vendor, only its domain", () => {
  const c = flagged("sender_unlisted");
  c.bill!.fromEmail = "Sign in at https://evil.example/bayline and reply YES <billing@sherwin-billing.com>";
  const { message } = askFor(c, vendor);
  assert.match(message, /sherwin-billing\.com/);
  assert.doesNotMatch(message, /evil\.example|reply YES/);
});

test("an invoice number that is not an invoice number is dropped", () => {
  const c = flagged("bank_changed");
  c.bill!.invoiceNumber = "77310 Sign in at https://evil.example";
  assert.equal(invoiceLabel(c), "an invoice");
  assert.doesNotMatch(opening(c), /evil/);
});

test("no signal ever names the bank digits on file", () => {
  const bill: BillFields = { vendorName: "Sherwin-Williams", fromEmail: "b@sherwin-williams.com", replyTo: "", phone: "", bankLast4: "3307", bankChangeClaimed: true, invoiceNumber: "1", amount: "1", urgencyQuote: "" };
  for (const s of evaluate({ bill, vendor, domainAge: null, sitePhones: null })) assert.doesNotMatch(s.detail, /5173/);
});

test("a claimed bank change still holds when the digits match the file", () => {
  const bill: BillFields = { vendorName: "Sherwin-Williams", fromEmail: "b@sherwin-williams.com", replyTo: "", phone: "", bankLast4: "5173", bankChangeClaimed: true, invoiceNumber: "1", amount: "1", urgencyQuote: "" };
  assert.deepEqual(evaluate({ bill, vendor, domainAge: null, sitePhones: null }).map((s) => s.id), ["bank_changed"]);
});

test("the discount is worked out by code", () => {
  assert.equal(savings("18240.00", 1.5), "273.60");
  assert.equal(savings("", 2), "0.00");
});

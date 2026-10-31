import assert from "node:assert/strict";
import { test } from "node:test";
import { compareDocument } from "../src/agents/examiner.ts";
import { askFor } from "../src/agents/liaison.ts";
import { savings } from "../src/agents/negotiator.ts";
import { recommend } from "../src/crew.ts";
import type { Case, CrewState } from "../src/pipeline.ts";
import type { Vendor } from "../src/rules.ts";

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

test("the discount is worked out by code", () => {
  assert.equal(savings("18240.00", 1.5), "273.60");
  assert.equal(savings("", 2), "0.00");
});

import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createEventLog } from "../src/eventlog.ts";
import { groundFields, senderFrom, summary, type Case } from "../src/pipeline.ts";
import type { BillFields } from "../src/rules.ts";
import { createSigner } from "../src/signing.ts";
import { findPhones, pageFrom, refuseClaim } from "../src/web.ts";

const page = pageFrom("https://vendor.test/contact", "Call **customer service** on 1-800-472-4643 or (609) 689-3000.\nWe   never change bank details by email.");

test("phones are found in the common formats", () => {
  assert.deepEqual(findPhones(page.text), ["8004724643", "6096893000"]);
  assert.deepEqual(findPhones("1 (855) 347-2839"), ["8553472839"]);
});

test("a quote from a fetched page is accepted", () => {
  const claim = { text: "It never changes bank details by email.", url: page.url, quote: "We never change bank details by email" };
  assert.equal(refuseClaim(claim, [page]), null);
});

test("a claim citing a page nobody fetched is refused", () => {
  const reason = refuseClaim({ text: "x", url: "https://fake.example/ok", quote: "bank account change confirmed" }, [page]);
  assert.match(reason ?? "", /never fetched/);
});

test("a quote that is not on the page is refused", () => {
  const reason = refuseClaim({ text: "x", url: page.url, quote: "bank account change confirmed" }, [page]);
  assert.match(reason ?? "", /not on/);
});

test("signatures verify, and fail after any change", () => {
  const signer = createSigner();
  const payload = { caseId: "c_1", score: 40 };
  const signature = signer.sign(payload);
  assert.equal(signer.verify(payload, signature), true);
  assert.equal(signer.verify({ ...payload, score: 0 }, signature), false);
});

test("the hash chain finds an edited event", () => {
  const log = createEventLog(join(tmpdir(), `holdfast-test-${process.pid}-${Date.now()}.jsonl`));
  log.append("a", { data: 1 });
  log.append("b", { data: 2 });
  assert.equal(log.verify(), null);
  (log.list()[0] as any).data = 99;
  assert.equal(log.verify(), 1);
});

const fields: BillFields = {
  vendorName: "Graybar",
  fromEmail: "billing@graybar.com",
  replyTo: "",
  phone: "1-855-347-2839",
  bankLast4: "2206",
  bankChangeClaimed: false,
  invoiceNumber: "1",
  amount: "10",
  urgencyQuote: "pay today",
};

test("the header line beats what the model reports for the sender", () => {
  const raw = "From: A <x@graybarr.com>\nReply-To: y@proton.me\n\nGraybar 1-855-347-2839 account 2206 pay today";
  const out = groundFields(fields, raw);
  assert.equal(out.fromEmail, "A <x@graybarr.com>");
  assert.equal(out.replyTo, "y@proton.me");
});

test("the last From line is the original sender on a forward", () => {
  const raw = "From: me@bayline.example\n\n---------- Forwarded message ---------\nFrom: x@graybarr.com\nSubject: Hi";
  assert.equal(senderFrom(raw).from, "x@graybarr.com");
});

test("values the model invented are dropped", () => {
  const out = groundFields(fields, "From: x@acme.example\n\nHello there, please send it.");
  assert.equal(out.vendorName, "");
  assert.equal(out.phone, "");
  assert.equal(out.bankLast4, "");
  assert.equal(out.urgencyQuote, "");
});

test("the text never tells someone to call a number from the email", () => {
  const c = {
    status: "done",
    verdict: "HOLD",
    score: 40,
    signals: [{ id: "bank_changed", points: 40, label: "Bank changed", detail: "Bill pays account ending 3307. On file: 5173." }],
    vendor: { id: "s", name: "Sherwin-Williams", phone: "1-800-474-3794" },
    bill: { ...fields, phone: "415-555-0142", amount: "18240.00" },
    id: "c_1",
  } as unknown as Case;
  const text = summary(c, "https://holdfast.test");
  assert.match(text, /1-800-474-3794/);
  assert.doesNotMatch(text, /415-555-0142/);
  assert.match(text, /APPROVE or REJECT/);
});

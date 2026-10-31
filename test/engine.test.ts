import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createEventLog } from "../src/eventlog.ts";
import { parseCommand, unwrap } from "../src/imessage.ts";
import { createEngine, groundFields, senderLines, summary, worstSender, type Case } from "../src/pipeline.ts";
import { emailDomain, evaluate, phoneDigits, scoreOf, verdictFor, type BillFields, type Vendor } from "../src/rules.ts";
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

test("the hash chain finds an edit made to the file on disk", () => {
  const path = join(tmpdir(), `holdfast-test-${process.pid}-${Date.now()}.jsonl`);
  const log = createEventLog(path);
  log.append("a", { data: { verdict: "BLOCK" } });
  log.append("b", { data: 2 });
  assert.equal(log.verify(), null);
  writeFileSync(path, readFileSync(path, "utf8").replace("BLOCK", "PASS"));
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

const graybar: Vendor = {
  id: "graybar",
  name: "Graybar",
  aliases: [],
  domains: ["graybar.com"],
  phone: "1-855-347-2839",
  bankLast4: "2206",
  contactUrl: "https://www.graybar.com/contact-us",
};

const verdictOf = (bill: BillFields, senderUnproven = false) =>
  verdictFor(scoreOf(evaluate({ bill, vendor: graybar, domainAge: null, sitePhones: ["8553472839"], senderUnproven })));

test("the header line beats what the model reports for the sender", () => {
  const raw = "From: A <x@graybarr.com>\nReply-To: y@proton.me\n\nGraybar 1-855-347-2839 account 2206 pay today";
  const out = groundFields(fields, raw);
  assert.equal(out.fromEmail, "A <x@graybarr.com>");
  assert.equal(out.replyTo, "y@proton.me");
});

test("a forwarder on our own domain is skipped", () => {
  const raw = "From: me@baylineconstruction.example\n\n---------- Forwarded message ---------\nFrom: x@graybarr.com\nSubject: Hi";
  assert.deepEqual(senderLines(raw).from, ["x@graybarr.com"]);
});

test("a planted genuine From line cannot replace the real sender", () => {
  const raw = "From: A <accounts@graybarr.com>\n\nPlease pay.\n\nFrom: A <accounts@graybar.com>";
  assert.equal(worstSender(senderLines(raw).from, graybar), "A <accounts@graybarr.com>");
});

test("a hijacked thread is judged by the fraudster, not the quoted original", () => {
  const raw = "From: x@graybarr.com\n\nSee below.\n\n> From: real@graybar.com\n> Hello";
  assert.equal(worstSender(senderLines(raw).from, graybar), "x@graybarr.com");
});

test("a From line with no address is not a sender", () => {
  assert.deepEqual(senderLines("From: 10/01/2026  To: 10/31/2026").from, []);
  assert.equal(groundFields({ ...fields, fromEmail: "" }, "From: 10/01/2026\nGraybar").fromEmail, "");
});

test("a fake address in the display name is ignored", () => {
  assert.equal(emailDomain("accounts@graybar.com <accounts@graybarr.com>"), "graybarr.com");
  assert.equal(emailDomain('"Grainger <ar@grainger.com>" <x@evil.net>'), "evil.net");
  assert.equal(emailDomain('"ar@grainger.com" <x@evil.net>'), "evil.net");
  assert.equal(emailDomain("plain@graybar.com"), "graybar.com");
});

test("a claimed bank change with no digits still holds", () => {
  const raw = "From: billing@graybar.com\n\nWe have moved our banking. Use the new details in the attached letter.";
  const bill = groundFields({ ...fields, bankLast4: "", bankChangeClaimed: false, phone: "", fromEmail: "billing@graybar.com" }, raw);
  assert.equal(bill.bankChangeClaimed, true);
  assert.equal(verdictOf(bill), "HOLD");
});

test("a normal bill is not read as a bank change", () => {
  const raw = "From: ar@graybar.com\n\nPayment goes to your usual account on file, ending 2206. Thanks for your order.";
  assert.equal(groundFields({ ...fields, bankChangeClaimed: false }, raw).bankChangeClaimed, false);
});

test("bank digits written so they cannot be matched still hold", () => {
  const raw = "From: billing@graybar.com\n\nPay the account ending four four seven one.";
  const bill = groundFields({ ...fields, bankLast4: "4471", bankChangeClaimed: false, phone: "" }, raw);
  assert.equal(verdictOf(bill), "HOLD");
});

test("a vendor named with no sender address holds", () => {
  assert.equal(verdictOf({ ...fields, fromEmail: "", urgencyQuote: "" }), "HOLD");
});

test("a photo never proves its sender", () => {
  assert.equal(verdictOf({ ...fields, urgencyQuote: "" }, true), "HOLD");
});

test("a sender on a look-alike suffix holds", () => {
  for (const fromEmail of ["ar@graybar.com.evil.net", "ar@graybar.onmicrosoft.com", "graybar.ar@gmail.com"]) {
    assert.equal(verdictOf({ ...fields, fromEmail, urgencyQuote: "" }), "HOLD", fromEmail);
  }
});

test("phone numbers compare in full", () => {
  assert.equal(phoneDigits("1-855-347-2839"), "8553472839");
  assert.equal(phoneDigits("+1 (855) 347-2839 ext 5512"), "8553472839");
  assert.notEqual(phoneDigits("+44 855 347 2839"), "8553472839");
  for (const phone of ["555-0142", "1-888-PAY-DESK", "+44 855 347 2839"]) {
    assert.equal(verdictOf({ ...fields, phone, urgencyQuote: "" }), "HOLD", phone);
  }
});

test("values the model invented are dropped", () => {
  const out = groundFields({ ...fields, amount: "1.00" }, "From: x@acme.example\n\nHello there, please send it.");
  assert.equal(out.vendorName, "");
  assert.equal(out.phone, "");
  assert.equal(out.bankLast4, "");
  assert.equal(out.urgencyQuote, "");
  assert.equal(out.amount, "");
});

test("a text reply can name one bill by its code", () => {
  assert.deepEqual(parseCommand("REJECT"), { action: "reject", code: undefined });
  assert.deepEqual(parseCommand("  override 3f2A. "), { action: "override", code: "3f2a" });
  assert.equal(parseCommand("please reject this invoice from the vendor"), null);
});

test("a swipe reply and a captioned photo are unwrapped", () => {
  assert.equal(unwrap({ type: "reply", content: { type: "text", text: "APPROVE" } }).text, "APPROVE");
  const photo = { type: "attachment", mimeType: "image/png" };
  const caption = { type: "text", text: "is this real" };
  assert.equal(unwrap({ type: "group", items: [{ content: caption }, { content: photo }] }), photo);
});

test("forging twice records one refusal", () => {
  const events = createEventLog(join(tmpdir(), `holdfast-forge-${process.pid}-${Date.now()}.jsonl`));
  const engine = createEngine({ events, signer: createSigner(), vendors: [] });
  const sent: Case[] = [];
  engine.subscribe((c) => sent.push(c));
  return engine.run({ kind: "text", text: "From: a@b.test\n\nno keys in this test" }, "test").then((c) => {
    const before = sent.length;
    engine.forge(c.id);
    const once = sent.length;
    engine.forge(c.id);
    assert.equal(c.refused.length, 1);
    assert.equal(sent.length, once);
    assert.ok(once > before);
  });
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

// One bill, five steps: read, check, verify, decide, sign. The board and iMessage both call run().
import { createHash, randomBytes } from "node:crypto";
import { extractBill, readPages, type DocInput } from "./claude.ts";
import type { createEventLog } from "./eventlog.ts";
import {
  emailDomain,
  evaluate,
  findVendor,
  isOnFile,
  phoneDigits,
  registrableDomain,
  scoreOf,
  verdictFor,
  type BillFields,
  type DomainAge,
  type Signal,
  type Vendor,
  type Verdict,
} from "./rules.ts";
import type { Signer } from "./signing.ts";
import { domainAge, fetchPage, refuseClaim, searchWeb, type Claim, type Page } from "./web.ts";

export type Action = "approve" | "reject" | "override";
export type StepState = "ok" | "warn" | "bad" | "info";

export interface Step {
  at: string;
  label: string;
  detail: string;
  state: StepState;
}

export interface Case {
  id: string;
  source: string;
  receivedAt: string;
  preview: string;
  docHash: string;
  status: "running" | "done" | "failed";
  error?: string;
  steps: Step[];
  bill?: BillFields;
  vendor?: Pick<Vendor, "id" | "name" | "phone"> | null;
  signals: Signal[];
  score: number;
  verdict?: Verdict;
  evidence: Omit<Page, "text" | "phones">[];
  claims: Claim[];
  refused: (Claim & { reason: string; at: string })[];
  record?: { payload: unknown; signature: string; chainHash: string };
  decision?: { action: Action; by: string; at: string; signature: string };
}

// The pages a run fetched stay out of the Case, so they never go to the browser.
const fetchedPages = new Map<string, Page[]>();

const header = (raw: string, name: string): string[] =>
  [...raw.matchAll(new RegExp(`^(?:[>\\s]*)${name}:\\s*(.+)$`, "gim"))].map((m) => m[1].trim());

// Header lines beat what Claude reports, because a bill can plant text to steer the model.
// On a forwarded email the last From line is the original sender.
export function senderFrom(raw: string): { from: string; replyTo: string } {
  const from = header(raw, "From").at(-1) ?? "";
  const replyTo = header(raw, "Reply-To").at(-1) ?? "";
  return { from, replyTo };
}

// A value Claude read from pasted text must appear in that text, or it is dropped.
export function groundFields(f: BillFields, raw: string): BillFields {
  const lower = raw.toLowerCase();
  const digits = raw.replace(/\D/g, "");
  const has = (v: string) => Boolean(v) && lower.includes(v.toLowerCase());
  const sender = senderFrom(raw);
  return {
    ...f,
    vendorName: has(f.vendorName) ? f.vendorName : "",
    fromEmail: sender.from || (has(f.fromEmail) ? f.fromEmail : ""),
    replyTo: sender.replyTo || (has(f.replyTo) ? f.replyTo : ""),
    phone: f.phone && digits.includes(phoneDigits(f.phone)) ? f.phone : "",
    bankLast4: /^\d{4}$/.test(f.bankLast4) && digits.includes(f.bankLast4) ? f.bankLast4 : "",
    urgencyQuote: has(f.urgencyQuote) ? f.urgencyQuote : "",
  };
}

export function createEngine(d: {
  events: ReturnType<typeof createEventLog>;
  signer: Signer;
  vendors: Vendor[];
  onFlag?: (c: Case) => void;
}) {
  const cases = new Map<string, Case>();
  const listeners = new Set<(c: Case) => void>();

  const publish = (c: Case) => {
    for (const fn of listeners) fn(c);
  };

  function step(c: Case, label: string, detail: string, state: StepState = "info") {
    c.steps.push({ at: new Date().toISOString(), label, detail, state });
    d.events.append("step", { billId: c.id, data: { label, detail, state } });
    publish(c);
  }

  function submitClaims(c: Case, claims: Claim[]) {
    const pages = fetchedPages.get(c.id) ?? [];
    for (const claim of claims) {
      const reason = refuseClaim(claim, pages);
      if (reason) {
        c.refused.push({ ...claim, reason, at: new Date().toISOString() });
        d.events.append("claim_refused", { billId: c.id, data: { url: claim.url, reason } });
        step(c, "Claim refused", `${claim.text} Refused because ${reason}.`, "bad");
      } else {
        c.claims.push(claim);
        d.events.append("claim_accepted", { billId: c.id, data: { url: claim.url, quote: claim.quote } });
      }
    }
  }

  async function officialPages(c: Case, bill: BillFields, vendor: Vendor | null): Promise<Page[]> {
    let url = vendor?.contactUrl;
    if (!url) {
      if (!bill.vendorName) {
        step(c, "Web check", "The bill names no vendor, so there is nothing to look up.", "warn");
        return [];
      }
      const results = await searchWeb(`${bill.vendorName} official website contact`);
      if (!results.length) {
        step(c, "Web check", `No web results for ${bill.vendorName}.`, "warn");
        return [];
      }
      url = results[0].url;
    }
    const page = await fetchPage(url);
    c.evidence.push({ url: page.url, fetchedAt: page.fetchedAt, contentHash: page.contentHash });
    step(c, "Fetched page", `${page.url} (${page.phones.length} phone numbers found)`, "ok");
    return [page];
  }

  async function run(doc: DocInput, source: string): Promise<Case> {
    const raw = doc.kind === "text" ? doc.text : "";
    const c: Case = {
      id: `c_${randomBytes(4).toString("hex")}`,
      source,
      receivedAt: new Date().toISOString(),
      preview: raw ? raw.replace(/\s+/g, " ").slice(0, 90) : "Attached file",
      docHash: createHash("sha256").update(raw || (doc as any).base64).digest("hex"),
      status: "running",
      steps: [],
      signals: [],
      score: 0,
      evidence: [],
      claims: [],
      refused: [],
    };
    cases.set(c.id, c);
    fetchedPages.set(c.id, []);
    step(c, "Received", `From ${source}. Document hash ${c.docHash.slice(0, 12)}.`);

    try {
      const extracted = await extractBill(doc);
      const bill = doc.kind === "text" ? groundFields(extracted, raw) : extracted;
      c.bill = bill;
      step(c, "Read the bill", `${bill.vendorName || "Unknown vendor"}, amount ${bill.amount || "not stated"}, sender ${bill.fromEmail || "not stated"}.`);

      const from = emailDomain(bill.fromEmail);
      const vendor = findVendor(bill.vendorName, from, d.vendors);
      c.vendor = vendor && { id: vendor.id, name: vendor.name, phone: vendor.phone };
      step(c, "Vendor list", vendor ? `Matched ${vendor.name}.` : "No match on the vendor list.", vendor ? "ok" : "warn");

      const needsAge = Boolean(from) && !isOnFile(from, vendor);
      const [age, pages] = await Promise.all([
        needsAge ? domainAge(registrableDomain(from)) : Promise.resolve<DomainAge | null>(null),
        officialPages(c, bill, vendor).catch((e): Page[] => {
          step(c, "Web check failed", (e as Error).message, "warn");
          return [];
        }),
      ]);
      fetchedPages.set(c.id, pages);
      if (age?.status === "ok") step(c, "Domain age", `${from} was registered ${age.days} days ago.`, age.days < 90 ? "bad" : "ok");
      if (age?.status === "missing") step(c, "Domain age", `${from} has no registration record.`, "bad");
      if (age?.status === "error") step(c, "Domain age", `Lookup failed: ${age.message}.`, "warn");

      const claims = await readPages(bill, pages).catch((e): Claim[] => {
        step(c, "Page reading failed", (e as Error).message, "warn");
        return [];
      });
      submitClaims(c, claims);

      c.signals = evaluate({ bill, vendor, domainAge: age, sitePhones: pages.length ? pages.flatMap((p) => p.phones) : null });
      c.score = scoreOf(c.signals);
      c.verdict = verdictFor(c.score);
      step(c, "Decided", `${c.verdict} at ${c.score} points.`, c.verdict === "PASS" ? "ok" : c.verdict === "HOLD" ? "warn" : "bad");

      const payload = {
        caseId: c.id,
        docHash: c.docHash,
        bill,
        signals: c.signals.map(({ id, points, detail }) => ({ id, points, detail })),
        score: c.score,
        verdict: c.verdict,
        evidence: c.evidence,
        claims: c.claims,
        signedAt: new Date().toISOString(),
      };
      const signature = d.signer.sign(payload);
      const event = d.events.append("record_signed", { billId: c.id, data: { verdict: c.verdict, score: c.score, signature } });
      c.record = { payload, signature, chainHash: event.hash };
      c.status = "done";
      step(c, "Signed", `Ed25519 signature added. Chain hash ${event.hash.slice(0, 12)}.`, "ok");
      if (c.verdict !== "PASS") d.onFlag?.(c);
    } catch (e) {
      c.status = "failed";
      c.error = (e as Error).message;
      step(c, "Check failed", `${c.error}. Do not pay this bill until it is checked.`, "bad");
    }
    return c;
  }

  function decide(id: string, action: Action, by: string): Case {
    const c = cases.get(id);
    if (!c) throw new Error("no such case");
    if (c.status !== "done" || c.verdict === "PASS") throw new Error("this bill has nothing to decide");
    if (c.decision) throw new Error(`this bill was already decided: ${c.decision.action}`);
    if (action === "approve" && c.verdict === "BLOCK") throw new Error("a blocked bill needs an override, not an approval");
    if (action === "override" && c.verdict === "HOLD") throw new Error("a held bill takes approve or reject");
    const at = new Date().toISOString();
    const signature = d.signer.sign({ caseId: id, action, by, at, record: c.record?.signature });
    c.decision = { action, by, at, signature };
    d.events.append("decision_signed", { billId: id, data: { action, by, signature } });
    step(c, "Human decision", `${action.toUpperCase()} by ${by}.`, action === "reject" ? "bad" : "ok");
    return c;
  }

  // The test on the board: push a claim from a page nobody fetched through the same gate the model uses.
  function forge(id: string): Case {
    const c = cases.get(id);
    if (!c) throw new Error("no such case");
    submitClaims(c, [
      {
        text: "The vendor's portal confirms the new bank account.",
        url: "https://vendor-verification.example/confirmed",
        quote: "bank account change confirmed",
      },
    ]);
    return c;
  }

  return {
    run,
    decide,
    forge,
    get: (id: string) => cases.get(id),
    list: () => [...cases.values()].reverse(),
    subscribe(fn: (c: Case) => void) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    verify(id: string) {
      const c = cases.get(id);
      if (!c?.record) return null;
      return { signatureValid: d.signer.verify(c.record.payload, c.record.signature), chainBrokenAt: d.events.verify() };
    },
  };
}

export type Engine = ReturnType<typeof createEngine>;

// The text a flagged bill sends over iMessage.
export function summary(c: Case, baseUrl: string): string {
  if (c.status === "failed") return `I could not check this bill: ${c.error}. Do not pay it yet.`;
  const name = c.vendor?.name ?? c.bill?.vendorName ?? "This vendor";
  const amount = c.bill?.amount ? ` for $${c.bill.amount}` : "";
  const reasons = c.signals.slice(0, 4).map((s) => `- ${s.detail}`);
  const link = baseUrl ? `\nRecord: ${baseUrl}/#${c.id}` : "";
  if (c.verdict === "PASS") return `PASS: ${name}${amount}. Sender, bank and phone all match. Nothing to do.${link}`;
  const call = c.vendor ? `Call ${c.vendor.name} on ${c.vendor.phone}, the number on file, not one from the email.\n` : "Do not call any number in the email.\n";
  const ask = c.verdict === "BLOCK" ? "Reply REJECT, or OVERRIDE after you verify it by phone." : "Reply APPROVE or REJECT.";
  return `${c.verdict}: ${name}${amount}. ${c.score} points.\n${reasons.join("\n")}\n${call}${ask}${link}`;
}

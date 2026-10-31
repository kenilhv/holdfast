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

export type CrewPhase = "investigating" | "awaiting_vendor" | "examining" | "awaiting_human" | "negotiating" | "closed";

export interface DocumentCheck {
  name: string;
  verdict: "consistent" | "inconsistent" | "unreadable";
  notes: string[];
}

export interface CrewState {
  phase: CrewPhase;
  channel: string;
  chat: { from: "agent" | "vendor"; text: string; at: string; file?: string }[];
  documents: DocumentCheck[];
  // What the vendor said on the trusted line, once known.
  outcome?: "confirmed" | "denied" | "refused" | "needs_person";
  verified: boolean;
  recommendation?: string;
  offer?: { accepted: boolean; discountPct: number; savings: string; note: string };
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
  evidence: (Omit<Page, "text" | "phones"> & { official: boolean })[];
  claims: Claim[];
  refused: (Claim & { reason: string; at: string })[];
  record?: { payload: unknown; signature: string; chainHash: string };
  decision?: { action: Action; by: string; at: string; signature: string };
  crew?: CrewState;
  // Signed additions made after the first record, one per thing the crew found.
  addenda: { type: string; at: string; data: unknown; signature: string }[];
}

// The pages a run fetched stay out of the Case, so they never go to the browser.
const fetchedPages = new Map<string, Page[]>();

const FORGED_URL = "https://vendor-verification.example/confirmed";

const header = (raw: string, name: string): string[] =>
  [...raw.matchAll(new RegExp(`^[> \\t]*${name}:[ \\t]*(.+)$`, "gim"))].map((m) => m[1].trim());

// The team's own addresses are skipped, so forwarding a real bill does not flag the person who forwarded it.
const OWN_DOMAINS = (process.env.OWN_DOMAINS ?? "baylineconstruction.example").split(",").map((s) => s.trim().toLowerCase());

const addresses = (raw: string, name: string) =>
  header(raw, name).filter((line) => {
    const domain = emailDomain(line);
    return domain && !OWN_DOMAINS.includes(registrableDomain(domain));
  });

// Every line that names a sender. A line with no address, like "From: 10/01/2026", is not a sender.
export function senderLines(raw: string): { from: string[]; replyTo: string[] } {
  return { from: addresses(raw, "From"), replyTo: addresses(raw, "Reply-To") };
}

// A bill can plant a genuine From line, and a hijacked thread quotes one, so the worst sender on the page is the one that counts.
export function worstSender(lines: string[], vendor: Vendor | null): string | undefined {
  return lines.find((line) => !isOnFile(emailDomain(line), vendor)) ?? lines[0];
}

const BANK_CHANGE =
  /\b(?:new|updated?|changed?|changing|moved|moving|switched|switching)\W+(?:\w+\W+){0,4}?(?:bank|banking|remit\w*|routing|ach|wire|account details|payment details)\b|\b(?:bank|banking|remit\w*|routing|account details|payment details)\W+(?:\w+\W+){0,4}?(?:changed?|moved|updated?)\b/i;

// A value Claude read from pasted text must appear in that text, or it is dropped.
// A drop only removes the value: a bank change Claude left out is still found in the raw text.
export function groundFields(f: BillFields, raw: string): BillFields {
  const text = raw.normalize("NFKC");
  const lower = text.toLowerCase();
  const digits = text.replace(/\D/g, "");
  const has = (v: string) => Boolean(v) && lower.includes(v.toLowerCase());
  const sender = senderLines(raw);
  const bankOk = /^\d{4}$/.test(f.bankLast4) && digits.includes(f.bankLast4);
  const amount = f.amount.replace(/\D/g, "");
  const phone = phoneDigits(f.phone);
  return {
    ...f,
    vendorName: has(f.vendorName) ? f.vendorName : "",
    fromEmail: sender.from[0] ?? (has(f.fromEmail) && emailDomain(f.fromEmail) ? f.fromEmail : ""),
    replyTo: sender.replyTo[0] ?? (has(f.replyTo) ? f.replyTo : ""),
    phone: phone && digits.includes(phone) ? f.phone : "",
    bankLast4: bankOk ? f.bankLast4 : "",
    bankChangeClaimed: f.bankChangeClaimed || BANK_CHANGE.test(text) || (Boolean(f.bankLast4) && !bankOk),
    amount: amount && digits.includes(amount) ? f.amount : "",
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
    c.evidence.push({ url: page.url, fetchedAt: page.fetchedAt, contentHash: page.contentHash, official: Boolean(vendor) });
    step(c, vendor ? "Fetched official page" : "Fetched top search result", `${page.url} (${page.phones.length} phone number${page.phones.length === 1 ? "" : "s"} found)`, vendor ? "ok" : "info");
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
      addenda: [],
    };
    cases.set(c.id, c);
    fetchedPages.set(c.id, []);
    step(c, "Received", `From ${source}. Document hash ${c.docHash.slice(0, 12)}.`);

    try {
      const extracted = await extractBill(doc);
      const bill = doc.kind === "text" ? groundFields(extracted, raw) : extracted;
      const vendor = findVendor(bill.vendorName, emailDomain(bill.fromEmail), d.vendors);
      if (doc.kind === "text") {
        const lines = senderLines(raw);
        bill.fromEmail = worstSender(lines.from, vendor) ?? bill.fromEmail;
        const sender = registrableDomain(emailDomain(bill.fromEmail));
        bill.replyTo = lines.replyTo.find((line) => registrableDomain(emailDomain(line)) !== sender) ?? bill.replyTo;
      }
      c.bill = bill;
      step(c, "Read the bill", `${bill.vendorName || "Unknown vendor"}, amount ${bill.amount || "not stated"}, sender ${bill.fromEmail || "not stated"}.`);

      const from = emailDomain(bill.fromEmail);
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

      const claims = await readPages(bill, pages, Boolean(vendor)).catch((e): Claim[] => {
        step(c, "Page reading failed", (e as Error).message, "warn");
        return [];
      });
      submitClaims(c, claims);

      c.signals = evaluate({
        bill,
        vendor,
        domainAge: age,
        sitePhones: pages.length && vendor ? pages.flatMap((p) => p.phones) : null,
        senderUnproven: doc.kind === "file",
      });
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
        refused: c.refused.map(({ url, reason }) => ({ url, reason })),
        signedAt: new Date().toISOString(),
      };
      // A frozen copy: the crew adds findings to the case later, and a signed record must never change.
      const frozen = structuredClone(payload);
      const signature = d.signer.sign(frozen);
      const event = d.events.append("record_signed", { billId: c.id, data: { verdict: c.verdict, score: c.score, signature } });
      c.record = { payload: frozen, signature, chainHash: event.hash };
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
    if (c.crew) c.crew.phase = "closed";
    d.events.append("decision_signed", { billId: id, data: { action, by, signature } });
    step(c, "Human decision", `${action.toUpperCase()} by ${by}.`, action === "reject" ? "bad" : "ok");
    return c;
  }

  // The test on the board: push a claim from a page nobody fetched through the same gate the model uses.
  function forge(id: string): Case {
    const c = cases.get(id);
    if (!c) throw new Error("no such case");
    // Once per case: every step resends the whole case to every open board.
    if (c.refused.some((r) => r.url === FORGED_URL)) return c;
    submitClaims(c, [{ text: "The vendor's portal confirms the new bank account.", url: FORGED_URL, quote: "bank account change confirmed" }]);
    return c;
  }

  // A later finding gets its own signature and points back at the first record.
  function addendum(c: Case, type: string, data: unknown) {
    const at = new Date().toISOString();
    const signature = d.signer.sign({ caseId: c.id, type, data, at, record: c.record?.signature });
    c.addenda.push({ type, at, data, signature });
    d.events.append("addendum_signed", { billId: c.id, data: { type, signature } });
    publish(c);
  }

  return {
    run,
    decide,
    forge,
    step,
    publish,
    addendum,
    submitClaims,
    pagesOf: (id: string) => fetchedPages.get(id) ?? [],
    addPage: (id: string, page: Page) => void fetchedPages.set(id, [...(fetchedPages.get(id) ?? []), page]),
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

// The short code a text reply uses to name a bill, as in "REJECT 3f2a".
export const billCode = (id: string) => id.slice(-4);

// The text a flagged bill sends over iMessage.
export function summary(c: Case, baseUrl: string): string {
  if (c.status === "failed") return `I could not check this bill: ${c.error}. Do not pay it yet.`;
  const name = c.vendor?.name ?? c.bill?.vendorName ?? "This vendor";
  const amount = c.bill?.amount ? ` for $${c.bill.amount}` : "";
  const reasons = c.signals.slice(0, 4).map((s) => `- ${s.detail}`);
  const link = baseUrl ? `\nRecord: ${baseUrl}/#${c.id}` : "";
  if (c.verdict === "PASS") return `PASS: ${name}${amount}. No risk signals in what this bill shows.${link}`;
  const call = c.vendor ? `Call ${c.vendor.name} on ${c.vendor.phone}, the number on file, not one from the email.\n` : "Do not call any number in the email.\n";
  const ask = c.verdict === "BLOCK" ? "Reply REJECT, or OVERRIDE after you verify it by phone." : "Reply APPROVE or REJECT.";
  return `${c.verdict} (bill ${billCode(c.id)}): ${name}${amount}. ${c.score} points.\n${reasons.join("\n")}\n${call}${ask}${link}`;
}

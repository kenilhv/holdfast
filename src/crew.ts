// The crew runs after the gate, on flagged bills only. Plain code moves a bill from agent to agent,
// so no model decides what happens next, and no agent can change a score or approve anything.
import { answer } from "./agents/controller.ts";
import { examine, type DocFile } from "./agents/examiner.ts";
import { investigate } from "./agents/investigator.ts";
import { askFor, liaisonTurn } from "./agents/liaison.ts";
import { DISCOUNT_PCT, negotiatorTurn, opening, savings } from "./agents/negotiator.ts";
import type { Case, CrewState, DocumentCheck, Engine } from "./pipeline.ts";
import type { Vendor } from "./rules.ts";

export interface VendorLine {
  // True when the vendor is a real phone. Otherwise the vendor window on the board stands in.
  on: () => boolean;
  send: (text: string) => Promise<void>;
}

export interface HumanLine {
  send: (text: string, caseId: string) => Promise<void>;
}

const WAITING_ON_VENDOR = ["awaiting_vendor", "negotiating"];

// A denial or a refusal always wins, and a request for a document is only met by a document.
export function isVerified(k: CrewState): boolean {
  if (k.outcome === "denied" || k.outcome === "refused") return false;
  const doc = k.documents.at(-1);
  return doc ? doc.verdict === "consistent" : k.outcome === "confirmed" && k.needs !== "document";
}

// A discount is only for a real bill: the vendor is proven, and nothing still blocks the bill.
export const canNegotiate = (c: Pick<Case, "verdict" | "decision" | "crew">) => Boolean(c.crew?.verified) && c.verdict !== "BLOCK" && !c.decision && !c.crew?.offer;

export function recommend(k: CrewState, hasContact = true): string {
  const doc = k.documents.at(-1);
  const line = k.channel === "iMessage" ? "the trusted line" : "the board stand-in";
  if (!hasContact) return "We have no trusted contact for this vendor. Reject it unless someone here knows the company.";
  if (k.outcome === "denied") return "Reject. The vendor says it did not send this.";
  if (k.outcome === "refused") return "Reject. The vendor would not provide proof.";
  if (doc?.verdict === "inconsistent") return "Reject. The document does not match the bill.";
  if (doc?.verdict === "consistent") return "The document matches the bill. A forged document could too, so call if the amount worries you.";
  if (doc?.verdict === "unreadable") return "Not proven. The document does not show what we need.";
  if (k.outcome === "confirmed" && k.needs === "document") return "Not proven. The vendor says it made the change but sent no document.";
  if (k.outcome === "confirmed") return `The vendor confirmed it on ${line}.`;
  return "A person needs to look at this.";
}

export function createCrew(d: { engine: Engine; vendors: Vendor[]; vendorLine: VendorLine; human: HumanLine; baseUrl: string }) {
  // One step at a time per bill, so two quick vendor messages cannot race each other.
  const queues = new Map<string, Promise<unknown>>();
  function inOrder(c: Case, work: () => Promise<void>) {
    const next = (queues.get(c.id) ?? Promise.resolve()).then(work).catch((e) => {
      console.error(`crew ${c.id}: ${(e as Error).message}`);
      d.engine.step(c, "Crew error", (e as Error).message, "warn");
    });
    queues.set(c.id, next);
    return next;
  }

  const vendorOf = (c: Case) => d.vendors.find((v) => v.id === c.vendor?.id) ?? null;

  async function say(c: Case, text: string) {
    const k = c.crew!;
    k.chat.push({ from: "agent", text, at: new Date().toISOString() });
    d.engine.publish(c);
    if (!d.vendorLine.on()) return;
    try {
      await d.vendorLine.send(text);
    } catch (e) {
      k.channel = "the board";
      d.engine.step(c, "Vendor text failed", `${(e as Error).message}. Using the board instead.`, "warn");
    }
  }

  const tellPerson = (c: Case, text: string) => d.human.send(text, c.id).catch((e) => console.error(`human text: ${e.message}`));

  async function report(c: Case) {
    const k = c.crew!;
    k.recommendation = recommend(k, Boolean(c.vendor));
    k.verified = isVerified(k);
    d.engine.addendum(c, "crew_report", { outcome: k.outcome, channel: k.channel, documents: k.documents, recommendation: k.recommendation });
    // A person may have decided while the crew worked. The finding stays on the record, and the bill stays closed.
    if (c.decision) return;
    k.phase = "awaiting_human";
    d.engine.step(c, "Report to a person", k.recommendation, k.verified ? "ok" : "warn");
    const next = c.verdict === "BLOCK" ? "Reply REJECT, or OVERRIDE." : "Reply APPROVE or REJECT.";
    const extra = canNegotiate(c) ? ` Reply NEGOTIATE and I will ask for ${DISCOUNT_PCT}% off for early payment.` : "";
    const link = d.baseUrl ? `\nRecord: ${d.baseUrl}/#${c.id}` : "";
    await tellPerson(c, `Update on ${c.vendor?.name ?? c.bill?.vendorName ?? "this vendor"}: ${k.recommendation} ${next}${extra}${link}`);
  }

  async function start(c: Case) {
    const vendor = vendorOf(c);
    c.crew = { phase: "investigating", channel: d.vendorLine.on() ? "iMessage" : "the board", chat: [], documents: [], verified: false };
    d.engine.publish(c);
    await inOrder(c, async () => {
      await investigate(d.engine, c).catch((e) => d.engine.step(c, "Investigator failed", (e as Error).message, "warn"));
      if (c.decision) return;
      if (!vendor) {
        d.engine.step(c, "No trusted contact", "This vendor is not on our list, so there is nobody safe to contact.", "warn");
        c.crew!.outcome = "needs_person";
        return report(c);
      }
      const ask = askFor(c, vendor);
      c.crew!.needs = ask.needs;
      c.crew!.phase = "awaiting_vendor";
      d.engine.step(c, "Liaison", `Contacting ${vendor.name} on the trusted line, not the one on the bill.`);
      await say(c, ask.message);
    });
  }

  async function readDocument(c: Case, vendor: Vendor, file: DocFile) {
    const k = c.crew!;
    k.phase = "examining";
    d.engine.publish(c);
    d.engine.step(c, "Examiner", `Reading ${file.name}.`);
    const check = await examine(file, c, vendor).catch(
      (e): DocumentCheck => ({ name: file.name, verdict: "unreadable", notes: [`The Examiner could not read it: ${(e as Error).message}`] }),
    );
    k.documents.push(check);
    d.engine.step(c, "Examiner finished", `${check.name}: ${check.verdict}. ${check.notes.join(" ")}`, check.verdict === "consistent" ? "ok" : "bad");
    await say(c, "Thanks, we have it. Someone on our team will follow up.");
    return report(c);
  }

  async function negotiatorReply(c: Case) {
    const k = c.crew!;
    await negotiatorTurn({
      c,
      say: (text) => say(c, text),
      // Any discount above zero is an offer, including a counter below what we asked for.
      finish(_accepted, discountPct, note) {
        k.offer = { accepted: discountPct > 0, discountPct, savings: savings(c.bill?.amount ?? "", discountPct), note };
      },
    });
    if (!k.offer) return;
    d.engine.addendum(c, "negotiation", k.offer);
    if (c.decision) return;
    k.phase = "awaiting_human";
    d.engine.step(c, "Negotiator finished", k.offer.note, k.offer.accepted ? "ok" : "warn");
    const result = k.offer.accepted ? `They took ${k.offer.discountPct}% off, saving $${k.offer.savings}.` : "They said no to a discount.";
    await tellPerson(c, `${result} Nothing is agreed until you co-sign. Reply APPROVE or REJECT.`);
  }

  async function liaisonReply(c: Case, vendor: Vendor) {
    const k = c.crew!;
    let finished = false;
    await liaisonTurn({
      c,
      vendor,
      say: (text) => say(c, text),
      finish(outcome, note) {
        finished = true;
        k.outcome = outcome;
        d.engine.step(c, "Liaison finished", `${outcome}: ${note}`, outcome === "confirmed" ? "ok" : "bad");
      },
    });
    if (!finished) return;
    if (k.outcome === "confirmed" && !k.documents.length) {
      // Saying yes is not the document we asked for, so keep the line open and ask again.
      if (k.needs === "document") {
        k.outcome = undefined;
        await say(c, "Thanks. We still need the bank letter or voided check before anything can move forward.");
        return;
      }
      // Sending the bill and owning the new account are two claims. The account still needs its own proof.
      if (c.signals.some((s) => s.id === "bank_changed")) {
        k.outcome = undefined;
        k.needs = "document";
        await say(c, "Thanks for confirming. This invoice also has new bank details, so please send a bank letter on your letterhead or a voided check for the account you want paid.");
        return;
      }
    }
    await report(c);
  }

  function fromVendor(c: Case, message: { text?: string; file?: DocFile }) {
    const k = c.crew;
    if (!k || !WAITING_ON_VENDOR.includes(k.phase)) throw new Error("this bill is not waiting on the vendor");
    return inOrder(c, async () => {
      const vendor = vendorOf(c);
      if (!vendor) return;
      // The bill may have moved on while this message waited its turn.
      if (c.decision || !WAITING_ON_VENDOR.includes(k.phase)) {
        d.engine.step(c, "Late vendor message", "It arrived after the bill moved on, so nothing was done with it.", "warn");
        return;
      }
      k.chat.push({ from: "vendor", text: message.text ?? `Sent ${message.file?.name}`, at: new Date().toISOString(), file: message.file?.name });
      d.engine.publish(c);

      if (k.phase === "negotiating") return negotiatorReply(c);
      if (message.file) return readDocument(c, vendor, message.file);
      return liaisonReply(c, vendor);
    });
  }

  function negotiate(c: Case) {
    const k = c.crew;
    if (!k?.verified) throw new Error("only a verified vendor can be asked for a discount");
    if (c.decision) throw new Error("this bill is already decided");
    if (c.verdict === "BLOCK") throw new Error("a blocked bill gets no discount offer");
    if (k.offer || k.phase === "negotiating") throw new Error("this vendor has already been asked");
    k.phase = "negotiating";
    return inOrder(c, async () => {
      if (c.decision) return;
      d.engine.step(c, "Negotiator", `Asking for ${DISCOUNT_PCT}% off for early payment.`);
      await say(c, opening(c));
    });
  }

  return {
    start,
    fromVendor,
    negotiate,
    ask: (c: Case, question: string) => answer(c, question),
    // The bill the vendor's phone is talking about: the newest one still waiting on it.
    waitingOnVendor: () => d.engine.list().find((c) => c.crew && WAITING_ON_VENDOR.includes(c.crew.phase)),
  };
}

export type Crew = ReturnType<typeof createCrew>;

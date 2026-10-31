// The crew runs after the gate, on flagged bills only. Plain code moves a bill from agent to agent,
// so no model decides what happens next, and no agent can change a score or approve anything.
import { answer } from "./agents/controller.ts";
import { examine, type DocFile } from "./agents/examiner.ts";
import { investigate } from "./agents/investigator.ts";
import { askFor, liaisonTurn } from "./agents/liaison.ts";
import { DISCOUNT_PCT, negotiatorTurn, opening, savings } from "./agents/negotiator.ts";
import type { Case, CrewState, Engine } from "./pipeline.ts";
import type { Vendor } from "./rules.ts";

export interface VendorLine {
  // True when the vendor is a real phone. Otherwise the vendor window on the board stands in.
  on: () => boolean;
  send: (text: string) => Promise<void>;
}

export interface HumanLine {
  send: (text: string, caseId: string) => Promise<void>;
}

export function recommend(k: CrewState, hasContact = true): string {
  const doc = k.documents.at(-1);
  if (!hasContact) return "We have no trusted contact for this vendor. Reject it unless someone here knows the company.";
  if (k.outcome === "denied") return "Reject. The vendor says it did not send this.";
  if (doc?.verdict === "inconsistent") return "Reject. The document does not match the bill.";
  if (doc?.verdict === "consistent") return "The document matches the bill. A forged document could too, so call if the amount worries you.";
  if (doc?.verdict === "unreadable") return "Not proven. The document does not show what we need.";
  if (k.outcome === "confirmed") return "The vendor confirmed it on the trusted line.";
  if (k.outcome === "refused") return "Reject. The vendor would not provide proof.";
  return "A person needs to look at this.";
}

export function createCrew(d: { engine: Engine; vendors: Vendor[]; vendorLine: VendorLine; human: HumanLine; baseUrl: string }) {
  // One step at a time per bill, so two quick vendor messages cannot race each other.
  const queues = new Map<string, Promise<unknown>>();
  function inOrder(id: string, work: () => Promise<void>) {
    const next = (queues.get(id) ?? Promise.resolve()).then(work).catch((e) => console.error(`crew ${id}: ${(e as Error).message}`));
    queues.set(id, next);
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

  async function report(c: Case) {
    const k = c.crew!;
    k.phase = "awaiting_human";
    k.recommendation = recommend(k, Boolean(c.vendor));
    k.verified = k.documents.at(-1)?.verdict === "consistent" || (k.outcome === "confirmed" && !k.documents.length);
    d.engine.addendum(c, "crew_report", { outcome: k.outcome, documents: k.documents, recommendation: k.recommendation });
    d.engine.step(c, "Report to a person", k.recommendation, k.verified ? "ok" : "warn");
    const next = c.verdict === "BLOCK" ? "Reply REJECT, or OVERRIDE." : "Reply APPROVE or REJECT.";
    const extra = k.verified ? ` Reply NEGOTIATE and I will ask for ${DISCOUNT_PCT}% off for early payment.` : "";
    const link = d.baseUrl ? `\nRecord: ${d.baseUrl}/#${c.id}` : "";
    await d.human.send(`Update on ${c.vendor?.name ?? c.bill?.vendorName ?? "this vendor"}: ${k.recommendation} ${next}${extra}${link}`, c.id).catch((e) => console.error(`human text: ${e.message}`));
  }

  async function start(c: Case) {
    const vendor = vendorOf(c);
    c.crew = { phase: "investigating", channel: d.vendorLine.on() ? "iMessage" : "the board", chat: [], documents: [], verified: false };
    d.engine.publish(c);
    await inOrder(c.id, async () => {
      await investigate(d.engine, c).catch((e) => d.engine.step(c, "Investigator failed", (e as Error).message, "warn"));
      if (!vendor) {
        d.engine.step(c, "No trusted contact", "This vendor is not on our list, so there is nobody safe to contact.", "warn");
        c.crew!.outcome = "needs_person";
        return report(c);
      }
      c.crew!.phase = "awaiting_vendor";
      d.engine.step(c, "Liaison", `Contacting ${vendor.name} on the trusted line, not the one on the bill.`);
      await say(c, askFor(c, vendor).message);
    });
  }

  function fromVendor(c: Case, message: { text?: string; file?: DocFile }) {
    const k = c.crew;
    if (!k || !["awaiting_vendor", "negotiating"].includes(k.phase)) throw new Error("this bill is not waiting on the vendor");
    return inOrder(c.id, async () => {
      const vendor = vendorOf(c);
      if (!vendor) return;
      k.chat.push({ from: "vendor", text: message.text ?? `Sent ${message.file?.name}`, at: new Date().toISOString(), file: message.file?.name });
      d.engine.publish(c);

      if (k.phase === "negotiating") {
        await negotiatorTurn({
          c,
          say: (text) => say(c, text),
          finish(accepted, discountPct, note) {
            k.offer = { accepted, discountPct, savings: savings(c.bill?.amount ?? "", discountPct), note };
          },
        });
        if (!k.offer) return;
        k.phase = "awaiting_human";
        d.engine.addendum(c, "negotiation", k.offer);
        d.engine.step(c, "Negotiator finished", k.offer.note, k.offer.accepted ? "ok" : "warn");
        const result = k.offer.accepted ? `They took ${k.offer.discountPct}% off, saving $${k.offer.savings}.` : "They said no to a discount.";
        await d.human.send(`${result} Nothing is agreed until you co-sign. Reply APPROVE or REJECT.`, c.id).catch((e) => console.error(`human text: ${e.message}`));
        return;
      }

      if (message.file) {
        k.phase = "examining";
        d.engine.publish(c);
        d.engine.step(c, "Examiner", `Reading ${message.file.name}.`);
        const check = await examine(message.file, c, vendor);
        k.documents.push(check);
        d.engine.step(c, "Examiner finished", `${check.name}: ${check.verdict}. ${check.notes.join(" ")}`, check.verdict === "consistent" ? "ok" : "bad");
        await say(c, "Thanks, we have it. Someone on our team will follow up.");
        return report(c);
      }

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
      if (finished) await report(c);
    });
  }

  function negotiate(c: Case) {
    const k = c.crew;
    if (!k?.verified) throw new Error("only a verified vendor can be asked for a discount");
    if (c.decision) throw new Error("this bill is already decided");
    if (k.offer) throw new Error("this vendor has already been asked");
    return inOrder(c.id, async () => {
      k.phase = "negotiating";
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
    waitingOnVendor: () => d.engine.list().find((c) => c.crew && ["awaiting_vendor", "negotiating"].includes(c.crew.phase)),
  };
}

export type Crew = ReturnType<typeof createCrew>;

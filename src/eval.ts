// A small test set for the rules, written by the team. It includes cases the rules are expected to get wrong.
import { evaluate, findVendor, emailDomain, scoreOf, verdictFor, type BillFields, type DomainAge, type Vendor } from "./rules.ts";

const vendors: Vendor[] = [
  {
    id: "grainger",
    name: "Grainger",
    aliases: ["W.W. Grainger"],
    domains: ["grainger.com"],
    phone: "1-800-472-4643",
    bankLast4: "8841",
    contactUrl: "https://www.grainger.com/content/general-contact-us",
  },
];

const OLD: DomainAge = { status: "ok", days: 4000, registered: "2015-01-01" };
const NEW: DomainAge = { status: "ok", days: 11, registered: "2026-10-19" };
const site = ["8004724643"];

const base: BillFields = {
  vendorName: "Grainger",
  fromEmail: "ar@grainger.com",
  replyTo: "",
  phone: "1-800-472-4643",
  bankLast4: "8841",
  bankChangeClaimed: false,
  invoiceNumber: "1",
  amount: "1000.00",
  urgencyQuote: "",
};

type Row = { name: string; fraud: boolean; bill: Partial<BillFields>; age?: DomainAge };

const ROWS: Row[] = [
  { name: "digit swapped into the domain, new bank", fraud: true, bill: { fromEmail: "a@gra1nger.com", bankLast4: "4471" }, age: NEW },
  { name: "doubled letter, same bank and phone", fraud: true, bill: { fromEmail: "a@graingerr.com" }, age: OLD },
  { name: "other ending, new bank", fraud: true, bill: { fromEmail: "a@grainger.co", bankLast4: "1200" }, age: OLD },
  { name: "real name with a hyphen", fraud: true, bill: { fromEmail: "a@grainger-billing.com", bankLast4: "1200" }, age: NEW },
  { name: "Cyrillic letters in the domain", fraud: true, bill: { fromEmail: "a@xn--gringer-8fg.com", bankLast4: "1200" }, age: NEW },
  { name: "real mailbox hacked, new bank", fraud: true, bill: { bankLast4: "3307" } },
  { name: "Reply-To hijack, new bank", fraud: true, bill: { replyTo: "a@proton.me", bankLast4: "3307" } },
  { name: "free email, new bank", fraud: true, bill: { fromEmail: "grainger.ar@gmail.com", bankLast4: "3307" }, age: OLD },
  { name: "phone swapped only", fraud: true, bill: { phone: "415-555-0142" } },
  { name: "unknown vendor, old domain", fraud: true, bill: { vendorName: "Northgate Services", fromEmail: "a@northgate.net", bankLast4: "1200" }, age: OLD },
  { name: "unknown vendor, no domain record", fraud: true, bill: { vendorName: "Northgate Services", fromEmail: "a@northgate-sites.com" }, age: { status: "missing" } },
  { name: "Reply-To hijack only, bank untouched", fraud: true, bill: { replyTo: "a@proton.me" } },
  { name: "ordinary invoice", fraud: false, bill: {} },
  { name: "subdomain of the real domain", fraud: false, bill: { fromEmail: "ar@mail.grainger.com" } },
  { name: "no phone on the bill", fraud: false, bill: { phone: "" } },
  { name: "no bank on the bill", fraud: false, bill: { bankLast4: "" } },
  { name: "pushy wording only", fraud: false, bill: { urgencyQuote: "please pay this today" } },
  { name: "full legal name", fraud: false, bill: { vendorName: "W.W. Grainger, Inc." } },
  { name: "Reply-To on the same domain", fraud: false, bill: { replyTo: "billing@grainger.com" } },
  { name: "branch phone that is not on the site", fraud: false, bill: { phone: "312-555-0177" } },
  { name: "real rebrand to a new domain", fraud: false, bill: { fromEmail: "ar@graingerindustrial.com" }, age: NEW },
  { name: "real bank change, properly announced", fraud: false, bill: { bankLast4: "3307" } },
];

export function runEval() {
  const rows = ROWS.map((r) => {
    const bill = { ...base, ...r.bill };
    const vendor = findVendor(bill.vendorName, emailDomain(bill.fromEmail), vendors);
    const score = scoreOf(evaluate({ bill, vendor, domainAge: r.age ?? null, sitePhones: site }));
    const verdict = verdictFor(score);
    return { name: r.name, fraud: r.fraud, score, verdict, right: r.fraud === (verdict !== "PASS") };
  });
  const fraud = rows.filter((r) => r.fraud);
  const clean = rows.filter((r) => !r.fraud);
  return {
    fraud: fraud.length,
    caught: fraud.filter((r) => r.right).length,
    clean: clean.length,
    falseAlarms: clean.filter((r) => !r.right).length,
    wrong: rows.filter((r) => !r.right),
    rows,
  };
}

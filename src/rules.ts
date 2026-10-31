// The decision rules. All of this is plain code: Claude can only add the urgency points, so it can never clear a bill.
import { domainToUnicode } from "node:url";

export const POINTS = {
  lookalike: 60,
  unknown_vendor: 50,
  bank_changed: 40,
  new_domain: 40,
  phone_mismatch: 40,
  sender_unlisted: 30,
  reply_to: 30,
  urgency: 10,
} as const;
export type SignalId = keyof typeof POINTS;

export const HOLD_AT = 40;
export const BLOCK_AT = 80;
export const NEW_DOMAIN_DAYS = 90;

export type Verdict = "PASS" | "HOLD" | "BLOCK";

export interface Vendor {
  id: string;
  name: string;
  aliases: string[];
  domains: string[];
  phone: string;
  bankLast4: string;
  contactUrl: string;
}

export interface BillFields {
  vendorName: string;
  fromEmail: string;
  replyTo: string;
  phone: string;
  bankLast4: string;
  bankChangeClaimed: boolean;
  invoiceNumber: string;
  amount: string;
  urgencyQuote: string;
}

export type DomainAge = { status: "ok"; days: number; registered: string } | { status: "missing" } | { status: "error"; message: string };

export interface Signal {
  id: SignalId;
  points: number;
  label: string;
  detail: string;
}

export interface Facts {
  bill: BillFields;
  vendor: Vendor | null;
  domainAge: DomainAge | null;
  // Digits of every phone number on the fetched official pages. Null when no page could be fetched.
  sitePhones: string[] | null;
}

// Two-part public suffixes, so "acme.co.uk" keeps "acme" as the name.
const TWO_PART_SUFFIXES = new Set(["co.uk", "org.uk", "ac.uk", "com.au", "net.au", "co.nz", "co.in", "com.br", "co.jp", "com.mx", "com.sg"]);

export function emailDomain(address: string): string {
  const m = /@([^\s>,;]+)/.exec(address);
  return m ? m[1].toLowerCase().replace(/\.$/, "") : "";
}

export function registrableDomain(host: string): string {
  const parts = host.toLowerCase().replace(/\.$/, "").split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  const take = TWO_PART_SUFFIXES.has(parts.slice(-2).join(".")) ? 3 : 2;
  return parts.slice(-take).join(".");
}

const nameLabel = (domain: string) => registrableDomain(domain).split(".")[0];

const CONFUSABLES: Record<string, string> = {
  "0": "o", "1": "l", "3": "e", "5": "s", "7": "t", "8": "b", i: "l", "|": "l",
  а: "a", е: "e", о: "o", р: "p", с: "c", х: "x", у: "y", і: "l", ј: "j", ѕ: "s", ı: "l", ɑ: "a", ο: "o", ν: "v",
};

// Reduce a name to how it looks, so "gra1nger", "grainger" and a Cyrillic copy all come out the same.
export function skeleton(label: string): string {
  const unicode = domainToUnicode(`${label}.com`).replace(/\.com$/, "") || label;
  return [...unicode.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "")]
    .map((c) => CONFUSABLES[c] ?? c)
    .join("")
    .replace(/rn/g, "m")
    .replace(/vv/g, "w")
    .replace(/cl/g, "d");
}

// Optimal string alignment distance: inserts, deletes, swaps of one letter, and neighbours switched.
export function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

export function isLookalike(senderDomain: string, vendorDomain: string): boolean {
  const sender = registrableDomain(senderDomain);
  const real = registrableDomain(vendorDomain);
  if (!sender || sender === real) return false;
  const a = skeleton(nameLabel(sender));
  const b = skeleton(nameLabel(real));
  if (a === b) return true;
  const allowed = b.length <= 5 ? 1 : 2;
  if (editDistance(a, b) <= allowed) return true;
  // "grainger-billing.com" and "pay-grainger.com" trade on the real name.
  return b.length >= 5 && a.includes(b);
}

export function isOnFile(senderDomain: string, vendor: Vendor | null): boolean {
  if (!vendor || !senderDomain) return false;
  const sender = registrableDomain(senderDomain);
  return vendor.domains.some((d) => registrableDomain(d) === sender);
}

const companyName = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\b(inc|llc|ltd|co|corp|corporation|company|incorporated|limited)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export function findVendor(name: string, senderDomain: string, vendors: Vendor[]): Vendor | null {
  const wanted = companyName(name);
  if (wanted) {
    for (const v of vendors) {
      for (const candidate of [v.name, ...v.aliases].map(companyName)) {
        if (candidate === wanted || (candidate.length >= 4 && wanted.includes(candidate))) return v;
      }
    }
  }
  if (!senderDomain) return null;
  return (
    vendors.find((v) => isOnFile(senderDomain, v)) ??
    vendors.find((v) => v.domains.some((d) => isLookalike(senderDomain, d))) ??
    null
  );
}

export const phoneDigits = (s: string) => s.replace(/\D/g, "").slice(-10);

function signal(id: SignalId, label: string, detail: string): Signal {
  return { id, points: POINTS[id], label, detail };
}

export function evaluate({ bill, vendor, domainAge, sitePhones }: Facts): Signal[] {
  const out: Signal[] = [];
  const from = emailDomain(bill.fromEmail);
  const replyTo = emailDomain(bill.replyTo);

  if (!vendor) {
    out.push(signal("unknown_vendor", "Unknown vendor", `${bill.vendorName || "This sender"} is not on the vendor list.`));
  } else if (from && !isOnFile(from, vendor)) {
    const real = vendor.domains[0];
    if (vendor.domains.some((d) => isLookalike(from, d))) {
      const edits = editDistance(nameLabel(from), nameLabel(real));
      out.push(signal("lookalike", "Lookalike sender", `${from} is ${edits} edit${edits === 1 ? "" : "s"} from the real domain, ${real}.`));
    } else {
      out.push(signal("sender_unlisted", "Sender not on file", `${from} is not a domain on file for ${vendor.name}.`));
    }
  }

  if (replyTo && from && registrableDomain(replyTo) !== registrableDomain(from)) {
    out.push(signal("reply_to", "Reply-To differs", `Replies go to ${replyTo}, not ${from}.`));
  }

  if (domainAge?.status === "missing") {
    out.push(signal("new_domain", "New domain", `${from} has no registration record.`));
  } else if (domainAge?.status === "ok" && domainAge.days < NEW_DOMAIN_DAYS) {
    out.push(signal("new_domain", "New domain", `${from} was registered ${domainAge.days} days ago.`));
  }

  if (vendor && bill.bankLast4 && bill.bankLast4 !== vendor.bankLast4) {
    out.push(signal("bank_changed", "Bank changed", `Bill pays account ending ${bill.bankLast4}. On file: ${vendor.bankLast4}.`));
  }

  if (vendor && bill.phone) {
    const digits = phoneDigits(bill.phone);
    const trusted = [phoneDigits(vendor.phone), ...(sitePhones ?? [])];
    if (digits.length === 10 && !trusted.includes(digits)) {
      out.push(signal("phone_mismatch", "Phone mismatch", `${bill.phone} is not on the official site or the vendor list.`));
    }
  }

  if (bill.urgencyQuote) {
    out.push(signal("urgency", "Urgent wording", `"${bill.urgencyQuote}"`));
  }

  return out;
}

export const scoreOf = (signals: Signal[]) => signals.reduce((sum, s) => sum + s.points, 0);

export const verdictFor = (score: number): Verdict => (score >= BLOCK_AT ? "BLOCK" : score >= HOLD_AT ? "HOLD" : "PASS");

// Outside evidence: Firecrawl for pages, RDAP for domain age, and the check that every web claim came from a fetched page.
import { createHash } from "node:crypto";
import type { DomainAge } from "./rules.ts";
import { phoneDigits } from "./rules.ts";

export interface Page {
  url: string;
  fetchedAt: string;
  contentHash: string;
  text: string;
  phones: string[];
}

export interface Claim {
  text: string;
  url: string;
  quote: string;
}

const API = "https://api.firecrawl.dev/v2";
const CACHE_MS = 60 * 60 * 1000;
const cache = new Map<string, Page>();

async function firecrawl(path: string, body: unknown): Promise<any> {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) throw new Error("FIRECRAWL_API_KEY is not set");
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || json.success === false) throw new Error(`Firecrawl ${path} failed: ${json.error ?? res.status}`);
  return json;
}

export function findPhones(text: string): string[] {
  const found = text.match(/(?:\+?1[\s.\-]?)?(?:\(\d{3}\)\s?|\d{3}[\s.\-])\d{3}[\s.\-]\d{4}/g) ?? [];
  return [...new Set(found.map(phoneDigits))];
}

export function pageFrom(url: string, text: string): Page {
  return {
    url,
    fetchedAt: new Date().toISOString(),
    contentHash: createHash("sha256").update(text).digest("hex"),
    text,
    phones: findPhones(text),
  };
}

export async function fetchPage(url: string): Promise<Page> {
  const hit = cache.get(url);
  if (hit && Date.now() - Date.parse(hit.fetchedAt) < CACHE_MS) return hit;
  const json = await firecrawl("/scrape", { url, formats: ["markdown"], onlyMainContent: false });
  const page = pageFrom(url, String(json.data?.markdown ?? ""));
  if (!page.text) throw new Error(`Firecrawl returned no content for ${url}`);
  cache.set(url, page);
  return page;
}

export async function searchWeb(query: string, limit = 3): Promise<{ url: string; title: string }[]> {
  const json = await firecrawl("/search", { query, limit });
  const web: any[] = json.data?.web ?? (Array.isArray(json.data) ? json.data : []);
  return web.map((r) => ({ url: String(r.url), title: String(r.title ?? "") }));
}

export async function domainAge(domain: string): Promise<DomainAge> {
  try {
    const tld = domain.split(".").at(-1);
    const registry = tld === "com" || tld === "net" ? `https://rdap.verisign.com/${tld}/v1` : "https://rdap.org";
    const res = await fetch(`${registry}/domain/${encodeURIComponent(domain)}`, {
      headers: { Accept: "application/rdap+json", "User-Agent": "Holdfast/0.1" },
      signal: AbortSignal.timeout(8_000),
    });
    // Only the .com and .net registry is authoritative here. The public proxy also says 404 for real domains on other endings.
    if (res.status === 404) return registry === "https://rdap.org" ? { status: "error", message: `no registry data for .${tld}` } : { status: "missing" };
    if (!res.ok) return { status: "error", message: `RDAP returned ${res.status}` };
    const json: any = await res.json();
    const registered = (json.events ?? []).find((e: any) => e.eventAction === "registration")?.eventDate;
    if (!registered) return { status: "error", message: "RDAP has no registration date" };
    return { status: "ok", registered, days: Math.floor((Date.now() - Date.parse(registered)) / 86_400_000) };
  } catch (e) {
    return { status: "error", message: (e as Error).message };
  }
}

const comparable = (s: string) =>
  s
    .toLowerCase()
    .replace(/[*_`#>\[\]()]/g, "")
    .replace(/\s+/g, " ")
    .trim();

const MIN_QUOTE = 8;

// The guardrail. Returns the reason a claim is refused, or null when it came from a page this run fetched.
export function refuseClaim(claim: Claim, fetched: Page[]): string | null {
  const page = fetched.find((p) => p.url === claim.url);
  if (!page) return `${claim.url} was never fetched in this run`;
  const quote = comparable(claim.quote ?? "");
  if (quote.length < MIN_QUOTE) return "the claim has no usable quote";
  if (!comparable(page.text).includes(quote)) return `the quote is not on ${claim.url}`;
  return null;
}

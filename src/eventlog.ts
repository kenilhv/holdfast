// Append-only event log. Each event stores the hash of the one before it, so any edit breaks the chain.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export interface LogEvent {
  seq: number;
  at: string;
  type: string;
  billId?: string;
  seat?: string;
  data: unknown;
  prevHash: string;
  hash: string;
}

// Key order must not change a hash, so stringify with sorted keys.
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .filter((k) => (value as any)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical((value as any)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

const hashOf = (e: Omit<LogEvent, "hash">) => createHash("sha256").update(canonical(e)).digest("hex");

export function createEventLog(path: string) {
  const events: LogEvent[] = existsSync(path)
    ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];
  // Live listeners: the orchestrator streams seat progress to the dashboard from here.
  const listeners = new Set<(e: LogEvent) => void>();

  return {
    subscribe(fn: (e: LogEvent) => void): () => void {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    append(type: string, fields: { billId?: string; seat?: string; data?: unknown }): LogEvent {
      const prev = events.at(-1);
      const base = {
        seq: (prev?.seq ?? 0) + 1,
        at: new Date().toISOString(),
        type,
        billId: fields.billId,
        seat: fields.seat,
        data: fields.data ?? null,
        prevHash: prev?.hash ?? "genesis",
      };
      const event = { ...base, hash: hashOf(base) };
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, `${JSON.stringify(event)}\n`);
      events.push(event);
      for (const fn of listeners) {
        try {
          fn(event);
        } catch {
          // A broken listener must never stop the log.
        }
      }
      return event;
    },
    list(filter: { billId?: string; sinceSeq?: number } = {}): LogEvent[] {
      return events.filter(
        (e) => (!filter.billId || e.billId === filter.billId) && (!filter.sinceSeq || e.seq > filter.sinceSeq),
      );
    },
    // Recompute every hash from the file, so an edit on disk shows up; returns the first broken seq, or null when intact.
    verify(): number | null {
      if (!events.length) return null;
      const stored: LogEvent[] = [];
      try {
        for (const line of readFileSync(path, "utf8").split("\n").filter(Boolean)) stored.push(JSON.parse(line));
      } catch {
        return stored.length + 1;
      }
      let prev = "genesis";
      for (const e of stored) {
        const { hash, ...base } = e;
        if (e.prevHash !== prev || hashOf(base) !== hash) return e.seq;
        prev = hash;
      }
      return stored.length === events.length && prev === events.at(-1)?.hash ? null : stored.length + 1;
    },
    lastSeq: () => events.at(-1)?.seq ?? 0,
  };
}

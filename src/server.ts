// Holdfast: one service that holds a vendor payment until the payee proves who it is.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEMO_BILLS } from "./demo-bills.ts";
import { createEventLog } from "./eventlog.ts";
import { startImessage } from "./imessage.ts";
import { createEngine, summary, type Action, type Case } from "./pipeline.ts";
import { BLOCK_AT, HOLD_AT, POINTS, type Vendor } from "./rules.ts";
import { createSigner } from "./signing.ts";
import { fetchPage } from "./web.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
try {
  process.loadEnvFile(`${root}.env`);
} catch {
  // .env is optional when the variables are already set, as they are on Render.
}

const port = Number(process.env.PORT ?? 8790);
const baseUrl = (process.env.RENDER_EXTERNAL_URL ?? process.env.PUBLIC_URL ?? "").replace(/\/$/, "");
const vendors: Vendor[] = JSON.parse(readFileSync(`${root}data/vendors.json`, "utf8"));
const events = createEventLog(join(process.env.DATA_DIR ?? join(tmpdir(), "holdfast"), `events-${process.pid}.jsonl`));
const signer = createSigner(process.env.SIGNING_KEY_PEM || undefined);

let chat: Awaited<ReturnType<typeof startImessage>> | undefined;
const engine = createEngine({
  events,
  signer,
  vendors,
  onFlag(c: Case) {
    if (c.source !== "iMessage") chat?.notify(summary(c, baseUrl), c.id).catch((e: Error) => console.error(`notify: ${e.message}`));
  },
});

const BODY_LIMIT = 256 * 1024;
const TEXT_LIMIT = 30_000;
const CHECKS_PER_HOUR = Number(process.env.MAX_CHECKS_PER_HOUR ?? 60);
const recentChecks: number[] = [];

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw new HttpError(413, "body too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new HttpError(400, "body is not JSON");
  }
}

// The board is public, so a cap keeps a stranger from spending the API credits.
function spendCheck() {
  const hourAgo = Date.now() - 3_600_000;
  while (recentChecks.length && recentChecks[0] < hourAgo) recentChecks.shift();
  if (recentChecks.length >= CHECKS_PER_HOUR) throw new HttpError(429, "the hourly check limit is reached");
  recentChecks.push(Date.now());
}

function status() {
  return {
    imessage: Boolean(chat?.on),
    firecrawl: Boolean(process.env.FIRECRAWL_API_KEY),
    claude: Boolean(process.env.ANTHROPIC_API_KEY),
    chainLength: events.lastSeq(),
    chainBrokenAt: events.verify(),
    thresholds: { hold: HOLD_AT, block: BLOCK_AT, points: POINTS },
    publicKey: signer.publicKey(),
  };
}

function stream(req: IncomingMessage, res: ServerResponse) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  const emit = (c: Case) => res.write(`event: case\ndata: ${JSON.stringify(c)}\n\n`);
  const unsubscribe = engine.subscribe(emit);
  const beat = setInterval(() => res.write(": beat\n\n"), 25_000);
  req.on("close", () => {
    clearInterval(beat);
    unsubscribe();
  });
}

const server = createServer(async (req, res) => {
  const { pathname: path } = new URL(req.url ?? "/", "http://localhost");
  try {
    if (req.method === "GET" && path === "/health") return send(res, 200, { ok: true });
    if (req.method === "GET" && path === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
      return res.end(readFileSync(`${root}public/index.html`));
    }
    if (req.method === "GET" && path === "/api/status") return send(res, 200, status());
    if (req.method === "GET" && path === "/api/demo") return send(res, 200, DEMO_BILLS);
    if (req.method === "GET" && path === "/api/vendors") return send(res, 200, vendors.map(({ name, domains, phone }) => ({ name, domains, phone })));
    if (req.method === "GET" && path === "/api/cases") return send(res, 200, engine.list());
    if (req.method === "GET" && path === "/api/stream") return stream(req, res);

    if (req.method === "POST" && path === "/api/check") {
      const { text } = await readJson(req);
      if (typeof text !== "string" || text.trim().length < 20) throw new HttpError(400, "paste the vendor's email or invoice text");
      if (text.length > TEXT_LIMIT) throw new HttpError(413, "that text is too long");
      spendCheck();
      void engine.run({ kind: "text", text }, "the board");
      return send(res, 202, { accepted: true });
    }

    const m = /^\/api\/cases\/(c_[0-9a-f]+)(?:\/(decide|forge|verify))?$/.exec(path);
    if (m) {
      const [, id, part] = m;
      if (!engine.get(id)) throw new HttpError(404, "no such case");
      if (req.method === "GET" && !part) return send(res, 200, engine.get(id));
      if (req.method === "GET" && part === "verify") return send(res, 200, engine.verify(id));
      if (req.method === "POST" && part === "forge") return send(res, 200, engine.forge(id));
      if (req.method === "POST" && part === "decide") {
        const { action } = await readJson(req);
        if (!["approve", "reject", "override"].includes(action)) throw new HttpError(400, "action must be approve, reject or override");
        try {
          return send(res, 200, engine.decide(id, action as Action, "the board"));
        } catch (e) {
          throw new HttpError(409, (e as Error).message);
        }
      }
    }
    send(res, 404, { error: "not found" });
  } catch (e) {
    const code = e instanceof HttpError ? e.status : 500;
    if (code >= 500) console.error(`${req.method} ${path}: ${(e as Error).message}`);
    if (!res.headersSent) send(res, code, { error: (e as Error).message });
  }
});

server.listen(port, () => {
  console.log(`Holdfast on http://localhost:${port}`);
  // Fetch the vendor pages up front, so the first demo is fast and a Firecrawl failure shows early.
  if (process.env.FIRECRAWL_API_KEY) {
    for (const v of vendors) fetchPage(v.contactUrl).catch((e: Error) => console.error(`warm ${v.id}: ${e.message}`));
  }
  startImessage({ engine, baseUrl })
    .then((c) => (chat = c))
    .catch((e: Error) => console.error(`iMessage failed to start: ${e.message}`));
});

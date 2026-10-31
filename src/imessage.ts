// The iMessage agent. Text it a vendor email or a photo of an invoice and it replies with the verdict.
import { billCode, summary, type Action, type Engine } from "./pipeline.ts";

const COMMANDS: Record<string, Action> = { approve: "approve", approved: "approve", reject: "reject", rejected: "reject", override: "override" };
const HELP = "Send me a vendor's email, or a photo or PDF of an invoice, and I will check who is really getting paid before you pay.";
const LOOKS_LIKE_A_BILL = /@|invoice|remit|bank|routing|account|payment|\$\s?\d/i;
const FILE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf"]);
const MAX_FILE_BASE64 = 7_000_000;

async function toBase64(data: any): Promise<string> {
  if (typeof data?.arrayBuffer === "function") return Buffer.from(await data.arrayBuffer()).toString("base64");
  return Buffer.from(data).toString("base64");
}

// Enough to follow a conversation in the logs without storing someone's number.
const masked = (id: string) => `...${id.slice(-4)}`;

// "REJECT", or "reject 3f2a" to name one of several open bills.
export function parseCommand(text: string): { action: Action; code?: string } | null {
  const m = /^\s*(approved?|reject(?:ed)?|override)\b\W*([0-9a-f]{4})?\W*$/i.exec(text);
  return m ? { action: COMMANDS[m[1].toLowerCase()], code: m[2]?.toLowerCase() } : null;
}

// A swipe reply and a photo with a caption arrive wrapped. Take the part that matters, and prefer a file.
export function unwrap(content: any): any {
  if (content?.type === "reply") return unwrap(content.content);
  if (content?.type === "group") {
    const items: any[] = (content.items ?? []).map((item: any) => item.content ?? item);
    return (
      items.find((i) => i.type === "attachment" && FILE_TYPES.has(i.mimeType)) ??
      items.find((i) => i.type === "attachment") ??
      items.find((i) => i.type === "text") ??
      content
    );
  }
  return content;
}

export async function startImessage(d: { engine: Engine; baseUrl: string; spend: (who: string) => void }) {
  const off = { on: false, notify: async (_text: string, _caseId?: string) => {} };
  const projectId = process.env.SPECTRUM_PROJECT_ID;
  const projectSecret = process.env.SPECTRUM_PROJECT_SECRET;
  if (!projectId || !projectSecret) {
    console.log("iMessage is off: set SPECTRUM_PROJECT_ID and SPECTRUM_PROJECT_SECRET.");
    return off;
  }

  const { Spectrum } = await import("spectrum-ts");
  const { imessage } = await import("spectrum-ts/providers/imessage");
  const app: any = await Spectrum({ projectId, projectSecret, providers: [imessage.config()] });

  // The flagged bills waiting on each conversation. A conversation can only reach its own bills,
  // and flagged bills from the board go only to CONTROLLER_PHONE, so a stranger can never decide someone else's.
  const openCases = new Map<string, string[]>();
  let controller: any;

  const addOpen = (key: string, id: string) => openCases.set(key, [...(openCases.get(key) ?? []), id]);
  const waiting = (key: string) => (openCases.get(key) ?? []).filter((id) => !d.engine.get(id)?.decision);
  const vendorOf = (id: string) => {
    const c = d.engine.get(id);
    return c?.vendor?.name ?? c?.bill?.vendorName ?? "this vendor";
  };

  async function controllerSpace() {
    if (controller) return controller;
    const phone = process.env.CONTROLLER_PHONE;
    if (!phone) return undefined;
    const im = imessage(app);
    controller = await im.space.create(await im.user(phone));
    return controller;
  }

  async function check(space: any, who: string, doc: Parameters<Engine["run"]>[0]) {
    try {
      d.spend(who);
    } catch {
      await space.send("You have reached the hourly limit for checks. Try again later.");
      return;
    }
    await space.responding(async () => {
      const c = await d.engine.run(doc, "iMessage");
      console.log(`iMessage: ${c.id} ${c.status} ${c.verdict ?? c.error}`);
      if (c.status === "done" && c.verdict !== "PASS") addOpen(String(space.id), c.id);
      await space.send(summary(c, d.baseUrl));
    });
  }

  async function decide(space: any, who: string, action: Action, code?: string) {
    const open = waiting(String(space.id));
    if (!open.length) return space.send("There is no bill waiting for a decision here.");
    const id = code ? open.find((c) => billCode(c) === code) : open.length === 1 ? open[0] : undefined;
    if (!id) {
      const list = open.map((c) => `${billCode(c)}: ${vendorOf(c)}`).join("\n");
      return space.send(`Which bill? Reply like "${action.toUpperCase()} ${billCode(open[0])}".\n${list}`);
    }
    try {
      d.engine.decide(id, action, `iMessage ${masked(who)}`);
      return space.send(action === "reject" ? `Rejected ${vendorOf(id)}. Nothing gets paid.` : `Recorded ${action} for ${vendorOf(id)}. Your decision is signed on the record.`);
    } catch (e) {
      return space.send(`I could not record that: ${(e as Error).message}.`);
    }
  }

  async function handle(space: any, message: any) {
    const who = String(message.sender?.id ?? "unknown");
    const content = unwrap(message.content);
    console.log(`iMessage in: ${message.content?.type} from ${masked(who)}`);

    if (content.type === "attachment") {
      if (/hei[cf]/i.test(content.mimeType ?? "")) return void (await space.send("I can't read iPhone HEIC photos yet. Take a screenshot of it and send that."));
      if (!FILE_TYPES.has(content.mimeType)) return void (await space.send("Send the invoice as a photo or a PDF."));
      const base64 = await toBase64(await content.read());
      if (base64.length > MAX_FILE_BASE64) return void (await space.send("That file is too big. Send a smaller photo or PDF."));
      return check(space, who, { kind: "file", mediaType: content.mimeType, base64 });
    }
    // A tapback or read receipt needs no answer.
    if (content.type !== "text") {
      if (["voice", "contact", "richlink", "poll"].includes(content.type)) await space.send(HELP);
      return;
    }

    const text = String(content.text).trim();
    const command = parseCommand(text);
    if (command) return void (await decide(space, who, command.action, command.code));
    if (text.length >= 30 && LOOKS_LIKE_A_BILL.test(text)) return check(space, who, { kind: "text", text });
    await space.send(HELP);
  }

  void (async () => {
    for await (const [space, message] of app.messages) {
      if (message.direction === "outbound") continue;
      handle(space, message).catch((e) => console.error(`iMessage: ${(e as Error).message}`));
    }
    console.error("iMessage stream ended.");
  })().catch((e) => console.error(`iMessage stream stopped: ${(e as Error).message}`));

  console.log("iMessage agent is listening.");
  return {
    on: true,
    async notify(text: string, caseId?: string) {
      const space = await controllerSpace();
      if (!space) return;
      if (caseId) addOpen(String(space.id), caseId);
      await space.send(text);
    },
  };
}

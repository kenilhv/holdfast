// The iMessage agent. Text it a vendor email or a photo of an invoice and it replies with the verdict.
import { summary, type Action, type Engine } from "./pipeline.ts";

const COMMANDS: Record<string, Action> = { approve: "approve", approved: "approve", reject: "reject", rejected: "reject", override: "override" };
const HELP = "Send me a vendor's email, or a photo or PDF of an invoice, and I will check who is really getting paid before you pay.";
const LOOKS_LIKE_A_BILL = /@|invoice|remit|bank|routing|account|payment|\$\s?\d/i;
const FILE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf"]);

async function toBase64(data: any): Promise<string> {
  if (typeof data?.arrayBuffer === "function") return Buffer.from(await data.arrayBuffer()).toString("base64");
  return Buffer.from(data).toString("base64");
}

export async function startImessage(d: { engine: Engine; baseUrl: string }) {
  const off = { on: false, notify: async (_text: string) => {} };
  const projectId = process.env.SPECTRUM_PROJECT_ID;
  const projectSecret = process.env.SPECTRUM_PROJECT_SECRET;
  if (!projectId || !projectSecret) {
    console.log("iMessage is off: set SPECTRUM_PROJECT_ID and SPECTRUM_PROJECT_SECRET.");
    return off;
  }

  const { Spectrum } = await import("spectrum-ts");
  const { imessage } = await import("spectrum-ts/providers/imessage");
  const app: any = await Spectrum({ projectId, projectSecret, providers: [imessage.config()] });

  // The latest flagged case in each conversation, so a one-word reply knows which bill it means.
  const openCase = new Map<string, string>();
  let lastSpace: any;

  async function controllerSpace() {
    if (lastSpace) return lastSpace;
    const phone = process.env.CONTROLLER_PHONE;
    if (!phone) return undefined;
    const im = imessage(app);
    lastSpace = await im.space.create(await im.user(phone));
    return lastSpace;
  }

  async function check(space: any, doc: Parameters<Engine["run"]>[0]) {
    await space.responding(async () => {
      const c = await d.engine.run(doc, "iMessage");
      openCase.set(String(space.id), c.id);
      await space.send(summary(c, d.baseUrl));
    });
  }

  async function handle(space: any, message: any) {
    lastSpace = space;
    const content = message.content;
    if (content.type === "attachment") {
      if (!FILE_TYPES.has(content.mimeType)) return void (await space.send("Send the invoice as a photo or a PDF."));
      return check(space, { kind: "file", mediaType: content.mimeType, base64: await toBase64(await content.read()) });
    }
    if (content.type !== "text") return;

    const text = String(content.text).trim();
    const action = COMMANDS[text.toLowerCase().replace(/[^a-z]/g, "")];
    if (action) {
      const id = openCase.get(String(space.id));
      if (!id) return void (await space.send("There is no bill waiting for a decision here."));
      try {
        d.engine.decide(id, action, `iMessage ${message.sender?.id ?? "user"}`);
        const done = action === "reject" ? "Rejected. Nothing gets paid." : "Recorded. Your decision is signed on the record.";
        return void (await space.send(done));
      } catch (e) {
        return void (await space.send(`I could not record that: ${(e as Error).message}.`));
      }
    }
    if (text.length >= 30 && LOOKS_LIKE_A_BILL.test(text)) return check(space, { kind: "text", text });
    await space.send(HELP);
  }

  void (async () => {
    for await (const [space, message] of app.messages) {
      if (message.direction === "outbound") continue;
      handle(space, message).catch((e) => console.error(`iMessage: ${(e as Error).message}`));
    }
  })().catch((e) => console.error(`iMessage stream stopped: ${(e as Error).message}`));

  console.log("iMessage agent is listening.");
  return {
    on: true,
    async notify(text: string, caseId?: string) {
      const space = await controllerSpace();
      if (!space) return;
      if (caseId) openCase.set(String(space.id), caseId);
      await space.send(text);
    },
  };
}

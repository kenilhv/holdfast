// Proves the agent can start a conversation: node scripts/text-first.ts +15551234567
// It sends one text and stops. It never reads app.messages, so it cannot take texts from a running agent.
import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";

process.loadEnvFile(".env");
const phone = process.argv[2];
if (!/^\+\d{10,15}$/.test(phone ?? "")) throw new Error("Pass a phone number like +15551234567");

const app: any = await Spectrum({
  projectId: process.env.SPECTRUM_PROJECT_ID!,
  projectSecret: process.env.SPECTRUM_PROJECT_SECRET!,
  providers: [imessage.config()],
});
const im = imessage(app);
const space = await im.space.create(await im.user(phone));
await space.send("CoSign test: the agent started this conversation.");
console.log(`Sent. Space ${space.id}`);
await app.stop();
process.exit(0);

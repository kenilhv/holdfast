// One Ed25519 key pair per seat. Private keys stay on our server; Creao never holds them.
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonical } from "./eventlog.ts";
import { SEATS, type Seat } from "./seats.ts";

export function createSigner(keyDir: string) {
  mkdirSync(keyDir, { recursive: true });
  const keys = {} as Record<Seat, { privateKey: KeyObject; publicKey: KeyObject }>;
  for (const seat of Object.keys(SEATS) as Seat[]) {
    const file = join(keyDir, `${seat}.pem`);
    if (!existsSync(file)) {
      const { privateKey } = generateKeyPairSync("ed25519");
      writeFileSync(file, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    }
    const privateKey = createPrivateKey(readFileSync(file));
    keys[seat] = { privateKey, publicKey: createPublicKey(privateKey) };
  }

  return {
    sign: (seat: Seat, payload: unknown): string => sign(null, Buffer.from(canonical(payload)), keys[seat].privateKey).toString("base64"),
    verify: (seat: Seat, payload: unknown, signature: string): boolean =>
      verify(null, Buffer.from(canonical(payload)), keys[seat].publicKey, Buffer.from(signature, "base64")),
    publicKeys: (): Record<string, string> =>
      Object.fromEntries(Object.entries(keys).map(([s, k]) => [s, k.publicKey.export({ type: "spki", format: "pem" }).toString()])),
  };
}

// One Ed25519 key signs every record. Set SIGNING_KEY_PEM to keep it across deploys; without it a new key is made at boot.
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { canonical } from "./eventlog.ts";

export function createSigner(pem?: string) {
  const privateKey = pem ? createPrivateKey(pem.replace(/\\n/g, "\n")) : generateKeyPairSync("ed25519").privateKey;
  const publicKey = createPublicKey(privateKey);

  return {
    sign: (payload: unknown): string => sign(null, Buffer.from(canonical(payload)), privateKey).toString("base64"),
    verify: (payload: unknown, signature: string): boolean =>
      verify(null, Buffer.from(canonical(payload)), publicKey, Buffer.from(signature, "base64")),
    publicKey: (): string => publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

export type Signer = ReturnType<typeof createSigner>;

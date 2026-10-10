import {createHmac} from "node:crypto";

/** RFC 4648 base32 decoder: Node's Buffer.from does not support "base32". */
export function decodeBase32(secret: string): Buffer {
  const raw = secret.toUpperCase().replace(/[\s-]/g, "").replace(/=+$/, "");
  if (!raw || /[^A-Z2-7]/.test(raw)) throw new Error("Invalid base32 TOTP secret.");
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let buffer = 0, bits = 0;
  const out: number[] = [];
  for (const char of raw) {
    buffer = (buffer << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >>> bits) & 0xff);
      buffer &= (1 << bits) - 1;
    }
  }
  if (!out.length) throw new Error("Invalid base32 TOTP secret.");
  return Buffer.from(out);
}

export function totp(secret: string, atMs = Date.now()): string {
  const counter = Math.floor(atMs / 30_000);
  if (!Number.isSafeInteger(counter) || counter < 0) throw new Error("Invalid TOTP timestamp.");
  const step = Buffer.alloc(8);
  step.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", decodeBase32(secret)).update(step).digest();
  const offset = digest[digest.length - 1] & 15;
  return ((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, "0");
}

// A TOTP code (RFC 6238: SHA-1, 6 digits, 30 seconds) from an otpauth:// URI, as an
// authenticator app would compute it.
import { createHmac } from "node:crypto";

function base32(text: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of text.replace(/=+$/, "").toUpperCase())
    bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
  const bytes = bits.match(/.{8}/g) ?? [];
  return Buffer.from(bytes.map((byte) => Number.parseInt(byte, 2)));
}

export function totpCode(uri: string, at = Date.now()): string {
  const secret = new URL(uri).searchParams.get("secret") as string;
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const hmac = createHmac("sha1", base32(secret)).update(counter).digest();
  const offset = (hmac[hmac.length - 1] as number) & 0x0f;
  const value = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(value).padStart(6, "0");
}

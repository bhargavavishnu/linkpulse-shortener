const ALPHABET =
  "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const BASE = BigInt(ALPHABET.length);
// Offset ensures sequential ID 1 encodes cleanly into a 5-char compact slug.
const ID_OFFSET = 14776335n; // 62^4 - 1

/**
 * Encode a positive integer database ID into a deterministic Base62 short code.
 */
export function encodeBase62(num) {
  let value = BigInt(num) + ID_OFFSET;
  if (value <= 0n) {
    throw new Error("Value to encode must be positive");
  }
  let out = "";
  while (value > 0n) {
    const rem = Number(value % BASE);
    out = ALPHABET[rem] + out;
    value /= BASE;
  }
  return out;
}

/**
 * Decode a Base62 short code back to its original positive integer ID.
 */
export function decodeBase62(code) {
  if (!code || typeof code !== "string") {
    throw new Error("Short code must be a non-empty string");
  }
  let value = 0n;
  for (const ch of code) {
    const idx = ALPHABET.indexOf(ch);
    if (idx === -1) {
      throw new Error(`Invalid Base62 character: ${ch}`);
    }
    value = value * BASE + BigInt(idx);
  }
  const original = value - ID_OFFSET;
  if (original < 0n) {
    throw new Error("Decoded value out of range");
  }
  return Number(original);
}

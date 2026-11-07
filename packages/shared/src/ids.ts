/** Uses Web Crypto (available in Node >= 19 and all browsers) so the package is isomorphic. */

/** Unambiguous uppercase alphabet (no 0/O, 1/I/L). 31 symbols => 31^6 ≈ 887M codes. */
export const INVITE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const INVITE_CODE_LENGTH = 6;

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}

export function generateInviteCode(): string {
  // Rejection sampling avoids modulo bias.
  const out: string[] = [];
  const limit = 256 - (256 % INVITE_ALPHABET.length);
  while (out.length < INVITE_CODE_LENGTH) {
    for (const b of randomBytes(16)) {
      if (b < limit && out.length < INVITE_CODE_LENGTH) out.push(INVITE_ALPHABET[b % INVITE_ALPHABET.length]!);
    }
  }
  return out.join('');
}

export function isInviteCode(s: string): boolean {
  return s.length === INVITE_CODE_LENGTH && [...s].every((c) => INVITE_ALPHABET.includes(c));
}

export function newId(prefix: string): string {
  return `${prefix}_${globalThis.crypto.randomUUID().replace(/-/g, '')}`;
}

export function newSecretToken(): string {
  return Array.from(randomBytes(32), (b) => b.toString(16).padStart(2, '0')).join('');
}

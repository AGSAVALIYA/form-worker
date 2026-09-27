const encoder = new TextEncoder();

async function digest(value: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest('SHA-256', encoder.encode(value));
}

export async function sha256Hex(value: string): Promise<string> {
  return [...new Uint8Array(await digest(value))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Constant-time comparison of two secrets (hashing first makes the lengths equal). */
export async function secretsEqual(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([digest(a), digest(b)]);
  return crypto.subtle.timingSafeEqual(left, right);
}

/** Checks a presented API key against the stored SHA-256 hash. */
export async function apiKeyMatches(presented: string, storedHash: string): Promise<boolean> {
  const presentedHash = encoder.encode(await sha256Hex(presented));
  const expected = encoder.encode(storedHash);
  return presentedHash.byteLength === expected.byteLength && crypto.subtle.timingSafeEqual(presentedHash, expected);
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A new random API key. Only its hash is stored; the key is shown once. */
export function newApiKey(): string {
  return `fwk_${base64Url(crypto.getRandomValues(new Uint8Array(32)))}`;
}

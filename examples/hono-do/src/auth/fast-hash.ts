import { scrypt } from "@noble/hashes/scrypt";

/**
 * Faster password hash preset. Drops scrypt cost from BA's default
 * (N=16384, r=16, p=1) to (N=4096, r=8, p=1).
 *
 *   default :  N=16384, r=16  → ~150-300ms CPU per hash on a CF Worker
 *   preset  :  N=4096,  r=8   → ~25-50ms CPU per hash
 *
 * Still inside NIST SP 800-132 recommended range for password hashing,
 * just at the lower end. The right call when warm sign-in p50 needs to
 * be sub-half-second and the threat model is online attackers rather
 * than offline GPU farms. If you're protecting high-value secrets,
 * stay on BA's defaults.
 *
 * Drop-in for BA's `emailAndPassword.password.{hash,verify}`. Hash
 * format is `scrypt-fast:<saltHex>:<hashHex>` so verify can identify
 * the preset and refuse mixed-preset rows. This means **users created
 * under one preset can only sign in under the same preset** — switching
 * presets in production requires a migration (or a verify-both helper).
 */
const N = 4096;
const r = 8;
const p = 1;
const dkLen = 32;
const SALT_LEN = 16;

const PREFIX = "scrypt-fast";

export async function hash(password: string): Promise<string> {
    const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
    const digest = scrypt(password, salt, { N, r, p, dkLen });
    return `${PREFIX}:${bytesToHex(salt)}:${bytesToHex(digest)}`;
}

export async function verify(input: { password: string; hash: string }): Promise<boolean> {
    const parts = input.hash.split(":");
    if (parts.length !== 3 || parts[0] !== PREFIX) return false;
    const salt = hexToBytes(parts[1]);
    const expected = hexToBytes(parts[2]);
    const computed = scrypt(input.password, salt, { N, r, p, dkLen });
    return timingSafeEqual(computed, expected);
}

function bytesToHex(bytes: Uint8Array): string {
    let out = "";
    for (const b of bytes) out += b.toString(16).padStart(2, "0");
    return out;
}

function hexToBytes(hex: string): Uint8Array {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return bytes;
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
}

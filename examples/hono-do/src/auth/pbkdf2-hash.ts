/**
 * Native PBKDF2 password hash via Web Crypto.
 *
 *   crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations })
 *
 * Why: Web Crypto is implemented in C++ inside the Workers runtime. No JS
 * stack frames, no bundle weight from @noble/hashes (~25KB). For the same
 * security target, PBKDF2 is faster on Workers than scrypt JS — but it
 * lacks memory hardness, so it's weaker against GPU-equipped attackers at
 * identical CPU cost.
 *
 * Iteration count: **Cloudflare Workers caps PBKDF2 iterations at 100,000**
 * (NotSupportedError above that). OWASP 2023 wants 600k for SHA-256, so
 * the CF native path is below current recommendation. At 100k iters on a
 * Workers isolate, hashing takes ~10-30ms — faster than scrypt(N=4096)
 * JS (~30ms) and far faster than BA's default (~200ms). The bench page
 * compares all three head-to-head; this variant is the "fastest possible"
 * end of the spectrum at the cost of going below current OWASP guidance.
 *
 * Mitigation: pair with IP rate limit + per-account lockout + monitoring.
 * For high-security workloads, stay on the scrypt variants.
 *
 * Trade-offs vs the scrypt variants:
 *
 *   - Native code path: no JS lib, no bundle bloat, no JIT warmup.
 *   - GPU resistance: weaker than scrypt (no memory cost). For an
 *     attacker with stolen hashes + GPU farm, PBKDF2 falls faster per
 *     dollar than scrypt.
 *   - Pair with pepper (HMAC the password with a server-side secret
 *     before deriving) for defence in depth — defers the GPU attack.
 *
 * Hash format: `pbkdf2-sha256:<iters>:<saltHex>:<hashHex>`. The verify
 * step reads iters from the prefix so we can rotate cost without a
 * migration.
 */

const PREFIX = "pbkdf2-sha256";
// CF Workers PBKDF2 max iter: 100_000. Anything higher throws NotSupportedError.
const ITERATIONS = 100_000;
const SALT_LEN = 16;
const DK_LEN_BITS = 256; // 32 bytes

export async function hash(password: string): Promise<string> {
    const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
    const bits = await deriveBits(password, salt, ITERATIONS, DK_LEN_BITS);
    return `${PREFIX}:${ITERATIONS}:${bytesToHex(salt)}:${bytesToHex(new Uint8Array(bits))}`;
}

export async function verify(input: { password: string; hash: string }): Promise<boolean> {
    const parts = input.hash.split(":");
    if (parts.length !== 4 || parts[0] !== PREFIX) return false;
    const iters = parseInt(parts[1], 10);
    if (!Number.isFinite(iters) || iters < 1000 || iters > 10_000_000) return false;
    const salt = hexToBytes(parts[2]);
    const expected = hexToBytes(parts[3]);
    const bits = await deriveBits(input.password, salt, iters, expected.length * 8);
    return timingSafeEqual(new Uint8Array(bits), expected);
}

async function deriveBits(
    password: string,
    salt: Uint8Array,
    iterations: number,
    bitsLen: number
): Promise<ArrayBuffer> {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", enc.encode(password), { name: "PBKDF2" }, false, ["deriveBits"]);
    return crypto.subtle.deriveBits(
        { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
        key,
        bitsLen
    );
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

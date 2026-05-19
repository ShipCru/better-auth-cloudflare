/**
 * Password peppering wrapper.
 *
 * Before passing the user's plaintext password to the hash function, HMAC
 * it with a server-side secret (the "pepper"). The hash function never
 * sees the raw password — only HMAC(pepper, password). This means:
 *
 *   - An attacker who steals the password DB but NOT the pepper cannot
 *     run a GPU/cloud brute-force against the hashes. They must also
 *     compromise the pepper, which lives in Workers Secrets (separate
 *     blast radius from D1/KV).
 *   - The pepper rotates via versioned key id. Existing hashes keep
 *     working until they're re-hashed on next sign-in (lazy rotation).
 *
 * Pepper format inside a stored hash: prepended to the algorithm prefix
 * as `p<version>:<existing-format>`. Example:
 *   `p1:scrypt-fast:<salt>:<hash>`
 *
 * verify() reads the version, fetches the matching pepper, HMACs the
 * incoming password with it, then defers to the underlying algorithm's
 * verify(). hash() always uses the latest version.
 *
 * Without a pepper configured, the wrappers no-op and just call the
 * underlying algorithm — so existing deploys without BETTER_AUTH_PEPPER
 * keep working unchanged.
 */

export interface PepperKeyset {
    /** Current version number (1+). Used for newly-hashed passwords. */
    current: number;
    /**
     * Lookup of version → secret bytes. Must include `current`. Old
     * versions kept here so verify() can decode hashes encoded with
     * pepper keys that have since been rotated.
     */
    keys: Record<number, Uint8Array>;
}

/**
 * Build a keyset from environment secrets. Convention:
 *   BETTER_AUTH_PEPPER       = active key (hex or base64)
 *   BETTER_AUTH_PEPPER_v0..N = older keys for backwards compat
 *
 * Returns null when no pepper is configured — caller should use the
 * algorithm's hash/verify directly in that case.
 */
export function pepperKeysetFromEnv(env: Record<string, string | undefined>): PepperKeyset | null {
    const raw = env.BETTER_AUTH_PEPPER;
    if (!raw) return null;
    const keys: Record<number, Uint8Array> = {};
    keys[1] = decodeSecret(raw);
    let current = 1;
    for (const [k, v] of Object.entries(env)) {
        const m = k.match(/^BETTER_AUTH_PEPPER_v(\d+)$/);
        if (m && typeof v === "string") {
            const version = parseInt(m[1], 10);
            keys[version] = decodeSecret(v);
            if (version > current) current = version;
        }
    }
    return { current, keys };
}

function decodeSecret(s: string): Uint8Array {
    // Accept either hex or base64. Hex if it looks hex.
    if (/^[0-9a-f]+$/i.test(s) && s.length % 2 === 0) {
        const out = new Uint8Array(s.length / 2);
        for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
        return out;
    }
    // Workers-native base64 (no Node Buffer dep). atob handles standard
    // base64; the byte-by-byte conversion is portable everywhere atob is.
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

/**
 * Per-isolate cache of imported HMAC keys, keyed by pepper-version.
 * `crypto.subtle.importKey` is sync-cheap but still has overhead;
 * caching saves ~1-2ms per hash on the warm path. Keys never leave the
 * isolate (CryptoKey is opaque), and importing the same secret again
 * produces an equivalent key, so caching is correct.
 */
const importedHmacKeys = new Map<string, Promise<CryptoKey>>();

function importHmacKeyCached(pepperHex: string, raw: Uint8Array): Promise<CryptoKey> {
    let p = importedHmacKeys.get(pepperHex);
    if (p) return p;
    p = crypto.subtle.importKey("raw", raw as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    importedHmacKeys.set(pepperHex, p);
    return p;
}

function bytesToHex(b: Uint8Array): string {
    let s = "";
    for (const v of b) s += v.toString(16).padStart(2, "0");
    return s;
}

/**
 * Apply pepper to a password before passing to the underlying hash.
 * Returns the HMAC bytes as base64 (well-formed string suitable for
 * algorithm impls that expect a UTF-8 password — no null bytes).
 */
export async function peppered(password: string, pepper: Uint8Array): Promise<string> {
    const key = await importHmacKeyCached(bytesToHex(pepper), pepper);
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(password));
    return base64FromBytes(new Uint8Array(sig));
}

function base64FromBytes(b: Uint8Array): string {
    let s = "";
    for (const v of b) s += String.fromCharCode(v);
    return btoa(s);
}

/**
 * Wrap an algorithm's hash/verify pair to apply peppering with version
 * tagging. Hash format becomes `p<v>:<original-format>`. When no keyset
 * is supplied, the wrappers degrade to passthrough so existing deploys
 * are unaffected.
 */
export function withPepper(
    inner: {
        hash: (pw: string) => Promise<string>;
        verify: (i: { password: string; hash: string }) => Promise<boolean>;
    },
    keyset: PepperKeyset | null
) {
    if (!keyset) return inner;
    return {
        async hash(password: string): Promise<string> {
            const v = keyset.current;
            const pep = keyset.keys[v]!;
            const peppered_pw = await peppered(password, pep);
            const innerHash = await inner.hash(peppered_pw);
            return `p${v}:${innerHash}`;
        },
        async verify(input: { password: string; hash: string }): Promise<boolean> {
            const m = input.hash.match(/^p(\d+):(.+)$/);
            if (!m) {
                // Unpeppered legacy hash. Verify with raw password — supports
                // existing deploys that pre-date pepper rollout. New hashes
                // are always peppered.
                return inner.verify(input);
            }
            const v = parseInt(m[1], 10);
            const pep = keyset.keys[v];
            if (!pep) return false; // unknown pepper version
            const peppered_pw = await peppered(input.password, pep);
            return inner.verify({ password: peppered_pw, hash: m[2] });
        },
    };
}

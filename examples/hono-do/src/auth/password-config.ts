import * as fastHash from "./fast-hash";
import * as pbkdf2Hash from "./pbkdf2-hash";
import { pepperKeysetFromEnv, withPepper } from "./pepper";

interface InnerHash {
    hash: (p: string) => Promise<string>;
    verify: (i: { password: string; hash: string }) => Promise<boolean>;
}

/**
 * Pick a password hash strategy based on env vars. Precedence:
 *   USE_PBKDF2=1    → Web Crypto PBKDF2 (100k iters SHA-256, CF cap)
 *   USE_FAST_HASH=1 → scrypt(N=4096) via @noble/hashes
 *   (default)       → BA's built-in scrypt(N=16384)
 *
 * The chosen hash format is encoded in each stored hash's prefix so
 * verify() picks the right algorithm. A user created under one preset
 * can only sign in under that preset.
 *
 * When BETTER_AUTH_PEPPER is configured, all custom variants get
 * HMAC-peppered before the underlying hash function sees them.
 * Defends against offline GPU brute-force when the password DB leaks
 * but the pepper (held in Workers Secrets, separate blast radius)
 * doesn't. Hash format gains a `p<v>:` prefix for the pepper version
 * so rotation is possible without re-hashing existing rows immediately.
 *
 * Returns undefined when no custom strategy is selected — BA then uses
 * its built-in default. Useful for the `current` baseline variant.
 */
export function pickPasswordConfig(env?: Record<string, string | undefined>): InnerHash | undefined {
    let inner: InnerHash | undefined;
    if (env?.USE_PBKDF2 === "1") inner = { hash: pbkdf2Hash.hash, verify: pbkdf2Hash.verify };
    else if (env?.USE_FAST_HASH === "1") inner = { hash: fastHash.hash, verify: fastHash.verify };
    if (!inner) return undefined;
    const keyset = pepperKeysetFromEnv(env ?? {});
    return withPepper(inner, keyset);
}

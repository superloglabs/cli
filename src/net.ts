import dns from "node:dns";

// Some environments (notably macOS behind Tailscale's magic DNS) return only
// AAAA records from getaddrinfo, even when the host has no global IPv6 route.
// Node's fetch/undici then picks an IPv6 address and fails with EHOSTUNREACH.
// Fall back to c-ares `resolve4` first, which bypasses getaddrinfo filtering.
// biome-ignore lint/suspicious/noExplicitAny: matches Node's overloaded lookup signature
const origLookup = dns.lookup as any;

// biome-ignore lint/suspicious/noExplicitAny: matches Node's overloaded lookup signature
(dns as any).lookup = function patchedLookup(
  hostname: string,
  optsOrCb: unknown,
  maybeCb?: unknown,
) {
  const cb = (typeof optsOrCb === "function" ? optsOrCb : maybeCb) as (
    err: NodeJS.ErrnoException | null,
    address?: string | { address: string; family: number }[],
    family?: number,
  ) => void;
  const opts = (typeof optsOrCb === "function" ? {} : optsOrCb) as {
    all?: boolean;
    family?: number;
  };

  if (opts.family === 6) {
    return origLookup(hostname, opts, cb);
  }

  dns.resolve4(hostname, (err, addrs) => {
    if (!err && addrs?.length) {
      if (opts.all) {
        return cb(
          null,
          addrs.map((a) => ({ address: a, family: 4 })),
        );
      }
      return cb(null, addrs[0], 4);
    }
    origLookup(hostname, opts, cb);
  });
};

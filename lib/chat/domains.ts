/**
 * Websites allowed to show a bot (pure). People type addresses in every
 * shape ("https://www.example.com/exhibit", "Example.com"); we store the
 * bare hostname and allow it and its subdomains in the chat frame's CSP
 * frame-ancestors, so copied embed code doesn't work on other sites.
 */
const HOST = /^(?=.{1,253}$)(?!-)([a-z0-9-]{1,63}(?<!-)\.)+[a-z]{2,63}$/;

export function normaliseDomain(input: string): string | null {
  let s = input.trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  s = s
    .replace(/[/?#].*$/, "")
    .replace(/:\d+$/, "")
    .replace(/\.$/, "");
  s = s.replace(/^www\./, "");
  if (s === "localhost") return s;
  return HOST.test(s) ? s : null;
}

/**
 * CSP frame-ancestors for a bot's chat frame. The app itself is always
 * allowed (the Try page); live bots add their websites and subdomains.
 * Draft bots stay inside the app.
 */
export function frameAncestors(domains: string[], live: boolean): string {
  const list = ["'self'"];
  if (live) {
    for (const d of domains) {
      const host = normaliseDomain(d);
      if (!host) continue;
      if (host === "localhost") list.push("http://localhost:*");
      else list.push(`https://${host}`, `https://*.${host}`);
    }
  }
  return list.join(" ");
}

/**
 * Client IP behind nginx. nginx sets X-Real-IP to $remote_addr, which a client cannot forge.
 * The first X-Forwarded-For entry is whatever the client sent, so it is not trusted: nginx
 * appends the real peer address to the end, which is the only entry that can be relied on.
 *
 * Assumes the app is only reachable through nginx: on bergholm.net ufw allows only 22/2222, 80 and
 * 443, so port 3001 is not exposed. If the app were reachable directly, both headers could be forged.
 */
export function clientIp(headers: { get(name: string): string | null }): string {
  const real = headers.get("x-real-ip")?.trim();
  if (real) return real;
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const last = forwarded.split(",").pop()?.trim();
    if (last) return last;
  }
  return "unknown";
}

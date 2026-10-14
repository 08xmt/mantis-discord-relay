export function isAllowlisted(allowlist: ReadonlySet<string>, userId: string): boolean {
  if (!/^\d{17,20}$/.test(userId)) return false;
  return allowlist.has(userId);
}

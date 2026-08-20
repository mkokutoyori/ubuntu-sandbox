/**
 * Minimal freeradius `users` file parser — one `username Cleartext-Password
 * := "secret"` check-item per line (the overwhelmingly common real-world
 * case). Real freeradius's `users` grammar also supports reply-item lines
 * indented below the check item, fall-through, regex usernames, and many
 * other check-item types (`NT-Password`, `Auth-Type`, …) — out of scope
 * here, matching PRD-RADIUS §2.2's framing of this as "clients.conf, users,
 * radtest" rather than a full freeradius config-language implementation.
 */

export interface ParsedUsersEntry {
  username: string;
  password: string;
}

const USER_LINE = /^(\S+)\s+Cleartext-Password\s*:?=\s*"([^"]*)"/;

export function parseUsersFile(source: string): ParsedUsersEntry[] {
  const users: ParsedUsersEntry[] = [];
  for (const rawLine of source.split('\n')) {
    const line = rawLine.split('#')[0].trim();
    if (!line) continue;
    const m = USER_LINE.exec(line);
    if (m) users.push({ username: m[1], password: m[2] });
  }
  return users;
}

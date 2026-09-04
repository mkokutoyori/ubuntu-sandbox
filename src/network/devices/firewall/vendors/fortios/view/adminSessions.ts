import {
  ADMIN_TRANSPORT_PROTOCOL, type AdminEndpoint, type AdminSession,
} from '../../../mgmt/AdminSessionTable';

export interface AdminSessionClock {
  readonly stamp: (at: number) => string;
  readonly now: () => number;
}

function endpoint(where: AdminEndpoint): string {
  return `${where.ip}:${where.port}`;
}

function device(session: AdminSession): string {
  const local = endpoint(session.local);
  return session.localInterface.length === 0
    ? local : `${session.localInterface}:${local}`;
}

export function renderAdminSessionList(
  sessions: readonly AdminSession[], clock: AdminSessionClock,
): string {
  const rows = sessions.map(session => [
    session.username,
    ADMIN_TRANSPORT_PROTOCOL[session.transport],
    device(session),
    endpoint(session.remote),
    clock.stamp(session.since),
  ]);

  const headers = ['username', 'local', 'device', 'remote', 'started'];
  const widths = headers.map((header, column) => Math.max(
    header.length, ...rows.map(row => row[column].length)));

  const line = (cells: readonly string[]) => cells
    .map((cell, column) => (column === cells.length - 1
      ? cell : cell.padEnd(widths[column]))).join(' ');

  return [line(headers), ...rows.map(line)].join('\n');
}

export function renderAdminSessionStatus(
  session: AdminSession | undefined, clock: AdminSessionClock,
): string {
  if (!session) return 'No administrative session is open.';

  return [
    `username: ${session.username}`,
    `login local: ${ADMIN_TRANSPORT_PROTOCOL[session.transport]}`,
    `login device: ${device(session)}`,
    `login remote: ${endpoint(session.remote)}`,
    `login vdom: ${session.vdom}`,
    `login started: ${clock.stamp(session.since)}`,
    `current time: ${clock.stamp(clock.now())}`,
  ].join('\n');
}

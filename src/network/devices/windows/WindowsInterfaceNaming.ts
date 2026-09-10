export function toDisplayName(portName: string): string {
  const m = portName.match(/^eth(\d+)$/i);
  if (!m) return portName;
  return `Ethernet ${parseInt(m[1], 10)}`;
}

export function toPortName(displayName: string): string | null {
  const trimmed = displayName.trim();
  if (/^Ethernet$/i.test(trimmed)) return 'eth0';
  const m = trimmed.match(/^Ethernet\s*(\d+)$/i);
  if (m) return `eth${parseInt(m[1], 10)}`;
  return null;
}

export function formatLinkSpeedMbps(mbps: number): string {
  if (mbps >= 1000 && mbps % 1000 === 0) return `${mbps / 1000} Gbps`;
  return `${mbps} Mbps`;
}

export const LOOPBACK_IFINDEX = 1;

export function withWindowsZone(address: { toString(): string }, ifIndex: number): string {
  const bare = address.toString().replace(/%.*$/, '');
  return /^fe80:/i.test(bare) ? `${bare}%${ifIndex}` : bare;
}

export function adapterIfIndex(position: number): number {
  return LOOPBACK_IFINDEX + 1 + position;
}

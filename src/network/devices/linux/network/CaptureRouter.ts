import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { subscribeWireSegments, wireSegmentToCapturedPacket, type WireSegment } from './WireCaptureBus';
import { PacketCaptureLog } from './PacketCaptureLog';

interface HostLike {
  getPort: (name: string) => { getIPAddress: () => unknown; getCable: () => { getPortA: () => unknown; getPortB: () => unknown } | null } | undefined;
  getPorts: () => Array<{ getIPAddress: () => unknown; getCable: () => { getPortA: () => unknown; getPortB: () => unknown } | null }>;
}

interface ExecutorBearer {
  executor?: { captureLog?: PacketCaptureLog };
}

interface SwitchLike extends HostLike {
  getPortMirror?: () => {
    list: () => Array<{ id: number; sources: Map<string, { rx: boolean; tx: boolean }>; destination: string | null }>;
  };
  getPort: (name: string) => { getIPAddress: () => unknown; getCable: () => { getPortA: () => unknown; getPortB: () => unknown } | null } | undefined;
}

function asExecCapture(d: unknown): PacketCaptureLog | undefined {
  const e = (d as ExecutorBearer).executor;
  return e?.captureLog;
}

function portOwner(port: unknown): unknown {
  const equipId = (port as { getEquipmentId?: () => string }).getEquipmentId?.();
  if (!equipId) return null;
  return EquipmentRegistry.getInstance().getById(equipId);
}

function peerOf(port: { getCable: () => { getPortA: () => unknown; getPortB: () => unknown } | null }): unknown {
  const cable = port.getCable();
  if (!cable) return null;
  const a = cable.getPortA();
  const b = cable.getPortB();
  return a === port ? b : a;
}

function ipOf(port: { getIPAddress: () => unknown }): string {
  const v = port.getIPAddress();
  return v == null ? '' : String(v);
}

function findHostByIp(ip: string): unknown {
  for (const d of EquipmentRegistry.getInstance().getAll()) {
    const h = d as HostLike;
    if (typeof h.getPorts !== 'function') continue;
    for (const p of h.getPorts()) {
      if (ipOf(p) === ip) return d;
    }
  }
  return null;
}

function findSwitchPortByPeerIp(sw: SwitchLike, ip: string): { name: string; port: unknown } | null {
  const portsObj = (sw as unknown as { getPorts: () => Array<{ getName?: () => string; getCable: () => { getPortA: () => unknown; getPortB: () => unknown } | null }> }).getPorts();
  for (const p of portsObj) {
    const cable = p.getCable();
    if (!cable) continue;
    const peer = peerOf(p);
    if (!peer) continue;
    const peerIp = ipOf(peer as { getIPAddress: () => unknown });
    if (peerIp === ip) return { name: (p as { getName?: () => string }).getName?.() ?? '', port: p };
  }
  return null;
}

let installed = false;

export function ensureCaptureRouterInstalled(): void {
  if (installed) return;
  installed = true;
  subscribeWireSegments(dispatch);
}

function dispatch(seg: WireSegment): void {
  const pkt = wireSegmentToCapturedPacket(seg);

  const srcHost = findHostByIp(seg.srcIp);
  const dstHost = findHostByIp(seg.dstIp);
  asExecCapture(srcHost)?.capture(pkt);
  if (dstHost !== srcHost) asExecCapture(dstHost)?.capture(pkt);

  for (const dev of EquipmentRegistry.getInstance().getAll()) {
    const sw = dev as SwitchLike;
    const mirror = sw.getPortMirror?.();
    if (!mirror) continue;
    const sessions = mirror.list();
    if (sessions.length === 0) continue;

    const srcMatch = findSwitchPortByPeerIp(sw, seg.srcIp);
    const dstMatch = findSwitchPortByPeerIp(sw, seg.dstIp);
    if (!srcMatch && !dstMatch) continue;

    for (const s of sessions) {
      if (!s.destination) continue;
      const srcPortMatches = (m: { name: string; port: unknown } | null) => m && s.sources.has(m.name);
      const ingress = srcMatch && srcPortMatches(srcMatch) && s.sources.get(srcMatch.name)!.tx;
      const egress = dstMatch && srcPortMatches(dstMatch) && s.sources.get(dstMatch.name)!.rx;
      if (!ingress && !egress) continue;
      const destPort = sw.getPort?.(s.destination);
      if (!destPort) continue;
      const destPeer = peerOf(destPort);
      const destHost = destPeer ? portOwner(destPeer) : null;
      if (destHost && destHost !== srcHost && destHost !== dstHost) {
        asExecCapture(destHost)?.capture(pkt);
      }
    }
  }
}

export function resetCaptureRouter(): void {
  installed = false;
}

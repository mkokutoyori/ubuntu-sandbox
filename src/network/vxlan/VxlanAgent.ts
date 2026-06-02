import type { IEventBus } from '@/events/EventBus';
import {
  type VxlanConfig, type VxlanRemoteVtep, type VxlanInterface,
  type VxlanPacket, type VxlanHeader,
  createDefaultVxlanConfig, defaultInterface, defaultRemoteVtep,
  makeVtepKey, makeMacKey, isValidVni,
  UDP_PORT_VXLAN, VXLAN_FLAG_I,
} from './types';
import {
  MACAddress, IPAddress,
  type EthernetFrame, type IPv4Packet, type UDPPacket,
  IP_PROTO_UDP, ETHERTYPE_IPV4, nextIPv4Id, computeIPv4Checksum,
} from '../core/types';
import { Logger } from '../core/Logger';

export interface VxlanHost {
  readonly id: string;
  readonly name: string;
  getHostname(): string;
  getPort(name: string): import('../hardware/Port').Port | undefined;
  getPorts(): import('../hardware/Port').Port[];
  sendFrame(portName: string, frame: EthernetFrame): void;
  onVxlanDecapsulated?(vni: number, innerFrame: EthernetFrame, fromRemoteVtepIp: string): void;
}

export class VxlanAgent {
  private config: VxlanConfig = createDefaultVxlanConfig();
  private running = false;

  constructor(
    private readonly host: VxlanHost,
    private readonly getBus: () => IEventBus,
  ) {}

  start(): void { if (!this.running) this.running = true; }
  stop(): void { this.running = false; }

  getConfig(): Readonly<VxlanConfig> { return this.config; }
  setEnabled(on: boolean): void { this.config.enabled = on; }
  setLearning(on: boolean): void { this.config.learning = on; }

  ensureInterface(ifaceName: string, localVtepIp: string | null = null): VxlanInterface {
    let i = this.config.interfaces.get(ifaceName);
    if (!i) {
      i = defaultInterface(ifaceName);
      this.config.interfaces.set(ifaceName, i);
    }
    if (localVtepIp !== null) i.localVtepIp = localVtepIp;
    return i;
  }

  bindVni(ifaceName: string, vni: number, localVtepIp: string): void {
    if (!isValidVni(vni)) return;
    const i = this.ensureInterface(ifaceName, localVtepIp);
    i.vnis.add(vni);
  }

  unbindVni(ifaceName: string, vni: number): void {
    const i = this.config.interfaces.get(ifaceName);
    if (!i) return;
    i.vnis.delete(vni);
  }

  addRemoteVtep(vni: number, remoteVtepIp: string): void {
    if (!isValidVni(vni)) return;
    const key = makeVtepKey(vni, remoteVtepIp);
    if (this.config.remoteVteps.has(key)) return;
    this.config.remoteVteps.set(key, defaultRemoteVtep(vni, remoteVtepIp));
    this.getBus().publish({
      topic: 'vxlan.vtep.changed',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        vni, remoteVtepIp, added: true,
      },
    });
  }

  removeRemoteVtep(vni: number, remoteVtepIp: string): void {
    const key = makeVtepKey(vni, remoteVtepIp);
    if (!this.config.remoteVteps.has(key)) return;
    this.config.remoteVteps.delete(key);
    this.getBus().publish({
      topic: 'vxlan.vtep.changed',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        vni, remoteVtepIp, added: false,
      },
    });
  }

  listRemoteVteps(vni?: number): VxlanRemoteVtep[] {
    const all = Array.from(this.config.remoteVteps.values());
    return (vni === undefined ? all : all.filter((v) => v.vni === vni))
      .sort((a, b) => a.vni === b.vni ? a.remoteVtepIp.localeCompare(b.remoteVtepIp) : a.vni - b.vni);
  }

  listMacTable(): Array<{ vni: number; mac: string; remoteVtepIp: string; lastSeenMs: number }> {
    return Array.from(this.config.macTable.entries())
      .map(([k, v]) => ({ vni: v.vni, mac: k.split('|')[1], remoteVtepIp: v.remoteVtepIp, lastSeenMs: v.lastSeenMs }))
      .sort((a, b) => a.vni === b.vni ? a.mac.localeCompare(b.mac) : a.vni - b.vni);
  }

  encapsulateAndSend(vni: number, innerFrame: EthernetFrame): boolean {
    if (!this.config.enabled) {
      this.dropped(vni, null, 'disabled');
      return false;
    }
    if (!isValidVni(vni)) {
      this.dropped(vni, null, 'invalid-vni');
      return false;
    }
    if (!innerFrame || !innerFrame.dstMAC || !innerFrame.srcMAC) {
      this.dropped(vni, null, 'invalid-frame');
      return false;
    }
    const dstMac = innerFrame.dstMAC.toString();
    const targets = this.resolveTargets(vni, dstMac);
    if (targets.length === 0) {
      this.dropped(vni, null, 'no-vtep');
      return false;
    }
    for (const target of targets) {
      this.sendTo(vni, innerFrame, target);
    }
    return true;
  }

  handleUdp(_inPort: string, srcIp: IPAddress, udp: UDPPacket): boolean {
    if (!this.config.enabled) return false;
    if (udp.destinationPort !== this.config.port) return false;
    const payload = udp.payload as VxlanPacket | undefined;
    if (!payload || payload.type !== 'vxlan') return false;
    const vni = payload.header.vni;
    if (!isValidVni(vni)) {
      this.dropped(vni, srcIp.toString(), 'invalid-vni');
      return true;
    }
    if ((payload.header.flags & VXLAN_FLAG_I) === 0) {
      this.dropped(vni, srcIp.toString(), 'invalid-frame');
      return true;
    }
    const remoteVtepIp = srcIp.toString();
    const knownVtep = this.config.remoteVteps.get(makeVtepKey(vni, remoteVtepIp));
    if (knownVtep) {
      knownVtep.packetsIn++;
      knownVtep.lastSeenMs = Date.now();
    }
    const inner = payload.innerFrame as EthernetFrame | undefined;
    if (!inner || !inner.srcMAC || !inner.dstMAC) {
      this.dropped(vni, remoteVtepIp, 'invalid-frame');
      return true;
    }
    if (this.config.learning) {
      const macKey = makeMacKey(vni, inner.srcMAC.toString());
      const existing = this.config.macTable.get(macKey);
      if (!existing || existing.remoteVtepIp !== remoteVtepIp) {
        this.config.macTable.set(macKey, { vni, remoteVtepIp, lastSeenMs: Date.now() });
        if (knownVtep) knownVtep.remoteMacs.add(inner.srcMAC.toString().toLowerCase());
        this.getBus().publish({
          topic: 'vxlan.mac.learned',
          payload: {
            deviceId: this.host.id, hostname: this.host.getHostname(),
            vni, mac: inner.srcMAC.toString(), remoteVtepIp,
          },
        });
      } else {
        existing.lastSeenMs = Date.now();
      }
    }
    this.getBus().publish({
      topic: 'vxlan.packet.decapsulated',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        vni, innerSrcMac: inner.srcMAC.toString(), innerDstMac: inner.dstMAC.toString(),
        remoteVtepIp,
      },
    });
    Logger.info(this.host.id, 'vxlan:rx',
      `${this.host.name}: vni ${vni} decap ${inner.srcMAC} → ${inner.dstMAC} (from ${remoteVtepIp})`);
    if (this.host.onVxlanDecapsulated) {
      this.host.onVxlanDecapsulated(vni, inner, remoteVtepIp);
    }
    return true;
  }

  private resolveTargets(vni: number, dstMac: string): string[] {
    const macKey = makeMacKey(vni, dstMac);
    const known = this.config.macTable.get(macKey);
    if (known && known.vni === vni) return [known.remoteVtepIp];
    const all: string[] = [];
    for (const v of this.config.remoteVteps.values()) {
      if (v.vni === vni) all.push(v.remoteVtepIp);
    }
    return all;
  }

  private sendTo(vni: number, innerFrame: EthernetFrame, remoteVtepIp: string): void {
    const localIface = this.findLocalIfaceForVni(vni);
    if (!localIface || !localIface.localVtepIp) {
      this.dropped(vni, remoteVtepIp, 'no-source-ip');
      return;
    }
    const egress = this.resolveEgress(remoteVtepIp);
    if (!egress) {
      this.dropped(vni, remoteVtepIp, 'no-egress');
      return;
    }
    const srcIp = new IPAddress(localIface.localVtepIp);
    const header: VxlanHeader = { flags: VXLAN_FLAG_I, reserved1: 0, vni, reserved2: 0 };
    const payload: VxlanPacket = { type: 'vxlan', header, innerFrame };
    const udp: UDPPacket = {
      type: 'udp',
      sourcePort: 49152 + (vni & 0x3fff),
      destinationPort: this.config.port,
      length: 8 + 8 + 64, checksum: 0, payload,
    };
    const ipPkt: IPv4Packet = {
      type: 'ipv4', version: 4, ihl: 5, tos: 0,
      totalLength: 20 + udp.length,
      identification: nextIPv4Id(), flags: 0, fragmentOffset: 0,
      ttl: 64, protocol: IP_PROTO_UDP, headerChecksum: 0,
      sourceIP: srcIp, destinationIP: new IPAddress(remoteVtepIp),
      payload: udp,
    };
    ipPkt.headerChecksum = computeIPv4Checksum(ipPkt);
    const eth: EthernetFrame = {
      srcMAC: egress.port.getMAC(),
      dstMAC: MACAddress.broadcast(),
      etherType: ETHERTYPE_IPV4, payload: ipPkt,
    };
    this.host.sendFrame(egress.name, eth);
    const knownVtep = this.config.remoteVteps.get(makeVtepKey(vni, remoteVtepIp));
    if (knownVtep) knownVtep.packetsOut++;
    this.getBus().publish({
      topic: 'vxlan.packet.encapsulated',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        vni, innerSrcMac: innerFrame.srcMAC.toString(),
        innerDstMac: innerFrame.dstMAC.toString(),
        remoteVtepIp,
      },
    });
    Logger.info(this.host.id, 'vxlan:tx',
      `${this.host.name}: vni ${vni} encap ${innerFrame.srcMAC} → ${innerFrame.dstMAC} (to ${remoteVtepIp})`);
  }

  private findLocalIfaceForVni(vni: number): VxlanInterface | null {
    for (const i of this.config.interfaces.values()) {
      if (i.enabled && i.vnis.has(vni) && i.localVtepIp) return i;
    }
    return null;
  }

  private dropped(vni: number | null, remoteVtepIp: string | null,
                  reason: 'no-vtep' | 'no-vni' | 'no-source-ip' | 'no-egress' | 'disabled' | 'invalid-vni' | 'invalid-frame'): void {
    this.getBus().publish({
      topic: 'vxlan.packet.dropped',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        vni, remoteVtepIp, reason,
      },
    });
  }

  private resolveEgress(targetIp: string): { name: string; port: import('../hardware/Port').Port } | null {
    const target = targetIp.split('.').map(Number);
    for (const port of this.host.getPorts()) {
      const ip = port.getIPAddress();
      const mask = port.getSubnetMask();
      if (!ip || !mask) continue;
      const local = ip.toString().split('.').map(Number);
      const maskBits = mask.toString().split('.').map(Number);
      let same = true;
      for (let i = 0; i < 4; i++) {
        if ((local[i] & maskBits[i]) !== (target[i] & maskBits[i])) { same = false; break; }
      }
      if (same) return { name: port.getName(), port };
    }
    for (const port of this.host.getPorts()) {
      if (port.getIPAddress() && port.getIsUp() && port.isConnected()) {
        return { name: port.getName(), port };
      }
    }
    return null;
  }
}

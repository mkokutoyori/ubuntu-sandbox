/**
 * Rendu de `netstat` — fonction pure vivant dans la couche commande. La
 * commande façade `NetstatCommand` lit l'état de l'équipement via
 * `ctx.machine.netstat` puis délègue le formatage ici. Aucune dépendance à
 * l'exécuteur ni au module legacy des commandes réseau.
 */
import type {
  NetstatRouteView, NetstatIfaceView, NetstatSocketView,
} from '@/command-kernel/machine/types';
import {
  formatEndpoint, familyVisible, socketVisible, type ServiceResolver,
} from '../../net/socketDisplay';

export interface NetstatInputs {
  routes: readonly NetstatRouteView[] | null;
  interfaces: readonly NetstatIfaceView[] | null;
  sockets: readonly NetstatSocketView[] | null;
  isServer: boolean;
  resolveService?: ServiceResolver;
}

function cidrToMask(cidr: number): string {
  if (cidr <= 0) return '0.0.0.0';
  if (cidr >= 32) return '255.255.255.255';
  const mask = (~0 << (32 - cidr)) >>> 0;
  return [(mask >>> 24) & 0xff, (mask >>> 16) & 0xff, (mask >>> 8) & 0xff, mask & 0xff].join('.');
}

function formatNetstatLine(proto: string, local: string, remote: string, state: string, pid: string): string {
  const p   = proto.padEnd(10);
  const rq  = '0'.padStart(6);
  const sq  = '0'.padStart(6);
  const loc = local.padEnd(23);
  const rem = remote.padEnd(23);
  const st  = state.padEnd(11);
  return `${p} ${rq} ${sq} ${loc} ${rem} ${st} ${pid}`.trimEnd();
}

function renderStatistics(sockets: readonly NetstatSocketView[] | null): string {
  let tcpListen = 0;
  let tcpEstablished = 0;
  if (sockets) {
    for (const sock of sockets) {
      if (sock.protocol !== 'tcp') continue;
      if (sock.state === 'LISTEN') tcpListen++;
      else if (sock.state === 'ESTABLISHED') tcpEstablished++;
    }
  }
  return [
    'Ip:',
    '    Forwarding: 2',
    '    0 total packets received',
    '    0 forwarded',
    '    0 incoming packets discarded',
    '    0 incoming packets delivered',
    '    0 requests sent out',
    'Icmp:',
    '    0 ICMP messages received',
    '    0 input ICMP message failed',
    '    ICMP input histogram:',
    '    0 ICMP messages sent',
    '    0 ICMP messages failed',
    '    ICMP output histogram:',
    'Tcp:',
    `    ${tcpEstablished} active connection openings`,
    `    ${tcpListen} passive connection openings`,
    '    0 failed connection attempts',
    '    0 connection resets received',
    `    ${tcpEstablished} connections established`,
    '    0 segments retransmitted',
    'Udp:',
    '    0 packets received',
    '    0 packets to unknown port received',
    '    0 packet receive errors',
    '    0 packets sent',
    '    0 receive buffer errors',
    'TcpExt:',
    'IpExt:',
  ].join('\n');
}

export function renderNetstat(args: string[], inputs: NetstatInputs): string {
  const { routes, interfaces, sockets, isServer, resolveService } = inputs;
  // Expand combined flags: '-tlnp' → individual chars t,l,n,p
  const hasFlag = (ch: string): boolean =>
    args.some(a => a.startsWith('-') && !a.startsWith('--') && a.includes(ch)) ||
    args.includes(`--${ch}`);

  const routing = hasFlag('r') || args.includes('--route');
  const ifaces  = hasFlag('i') || args.includes('--interfaces');

  if (routing) {
    const header = [
      'Kernel IP routing table',
      'Destination     Gateway         Genmask         Flags   MSS Window  irtt Iface',
    ];
    const rows: string[] = [];
    if (routes) {
      for (const r of routes) {
        const dest = r.isDefault ? '0.0.0.0' : r.network;
        const gw   = r.nextHop ?? '0.0.0.0';
        const mask = cidrToMask(r.cidr);
        const flags = (r.isDefault || r.nextHop) ? 'UG' : 'U';
        rows.push(
          `${dest.padEnd(16)}${gw.padEnd(16)}${mask.padEnd(16)}${flags.padEnd(8)}0 0          0 ${r.iface}`,
        );
      }
      rows.push('127.0.0.0       0.0.0.0         255.0.0.0       U         0 0          0 lo');
    } else {
      rows.push('0.0.0.0         10.0.0.1        0.0.0.0         UG        0 0          0 eth0');
      rows.push('10.0.0.0        0.0.0.0         255.255.255.0   U         0 0          0 eth0');
      rows.push('127.0.0.0       0.0.0.0         255.0.0.0       U         0 0          0 lo');
    }
    return [...header, ...rows].join('\n');
  }

  if (ifaces) {
    const header = [
      'Kernel Interface table',
      'Iface      MTU    RX-OK RX-ERR RX-DRP RX-OVR    TX-OK TX-ERR TX-DRP TX-OVR Flg',
    ];
    const rows: string[] = [];
    if (interfaces) {
      for (const info of interfaces) {
        const mtu = String(info.mtu).padStart(7);
        const rx  = String(info.framesIn).padStart(8);
        const tx  = String(info.framesOut).padStart(9);
        const flags = info.isUp ? (info.isConnected ? 'BMRU' : 'BMU') : 'BMU';
        rows.push(`${info.name.padEnd(11)}${mtu} ${rx}      0      0 0        ${tx}      0      0      0 ${flags}`);
      }
      rows.push(`lo        65536      128      0      0 0           128      0      0      0 LRU`);
    } else {
      rows.push('eth0      1500     1024      0      0 0           512      0      0      0 BMRU');
      rows.push('lo       65536      128      0      0 0           128      0      0      0 LRU');
    }
    return [...header, ...rows].join('\n');
  }

  if (hasFlag('s') || args.includes('--statistics')) {
    return renderStatistics(sockets);
  }

  const wantTcp = hasFlag('t');
  const wantUdp = hasFlag('u');
  const showAll = !wantTcp && !wantUdp;

  const showProcesses = hasFlag('p');
  const numeric = hasFlag('n');
  const wantAll = hasFlag('a') || args.includes('--all');
  const wantListening = hasFlag('l') || args.includes('--listening');
  const want4 = hasFlag('4') || args.includes('--ipv4');
  const want6 = hasFlag('6') || args.includes('--ipv6');

  const banner = wantListening
    ? 'Active Internet connections (only servers)'
    : wantAll
      ? 'Active Internet connections (servers and established)'
      : 'Active Internet connections (w/o servers)';
  const lines = [
    banner,
    'Proto Recv-Q Send-Q Local Address           Foreign Address         State       PID/Program name',
  ];

  if (sockets) {
    for (const sock of sockets) {
      const isTcp = sock.protocol === 'tcp';
      const isUdp = sock.protocol === 'udp';
      if (!showAll && isTcp && !wantTcp) continue;
      if (!showAll && isUdp && !wantUdp) continue;
      if (!familyVisible(sock.localAddress, want4, want6)) continue;
      if (!socketVisible(sock.state, wantAll, wantListening)) continue;

      const v6 = sock.localAddress.includes(':');
      const localAddr  = formatEndpoint(sock.localAddress, sock.localPort, sock.protocol, numeric, resolveService);
      const remoteAddr = sock.state === 'LISTEN'
        ? (v6 ? ':::*' : '0.0.0.0:*')
        : formatEndpoint(sock.remoteAddress, sock.remotePort, sock.protocol, numeric, resolveService);
      const stateCol   = isTcp ? sock.state : '';
      const pidCol     = showProcesses && sock.pid ? `${sock.pid}/${sock.processName}` : '';

      lines.push(formatNetstatLine(`${sock.protocol}${v6 ? '6' : ''}`, localAddr, remoteAddr, stateCol, pidCol));
    }
  } else {
    if (wantTcp || showAll) {
      lines.push(formatNetstatLine('tcp', '0.0.0.0:22', '0.0.0.0:*', 'LISTEN', '985/sshd: /usr/sbin'));
      if (isServer) {
        lines.push(formatNetstatLine('tcp', '0.0.0.0:1521', '0.0.0.0:*', 'LISTEN', '2001/tnslsnr'));
      }
    }
    if (wantUdp || showAll) {
      lines.push(formatNetstatLine('udp', '127.0.0.53:53', '0.0.0.0:*', '', '540/systemd-resolve'));
    }
  }

  return lines.join('\n');
}

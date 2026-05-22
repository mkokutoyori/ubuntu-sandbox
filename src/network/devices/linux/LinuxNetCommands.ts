/**
 * LinuxNetCommands — ifconfig, netstat, ss, curl, wget.
 *
 * Provides realistic output matching Ubuntu/Debian conventions.
 * Network info comes from the IpNetworkContext when available.
 */

import type { IpNetworkContext } from './LinuxIpCommand';
import type { SocketTable, SocketEntry } from '../../core/SocketTable';

// ─── ifconfig ───────────────────────────────────────────────────────

export function cmdIfconfig(args: string[], ctx: IpNetworkContext | null): string {
  // Build interface list from network context
  const interfaces = buildInterfaces(ctx);
  const target = args[0];

  if (target) {
    const iface = interfaces.find(i => i.name === target);
    if (!iface) return `${target}: error fetching interface information: Device not found`;
    return formatInterface(iface);
  }

  // Show all active interfaces
  return interfaces.filter(i => i.up).map(formatInterface).join('\n');
}

interface IfaceInfo {
  name: string;
  up: boolean;
  ipv4: string;
  netmask: string;
  broadcast: string;
  ipv6: string;
  mac: string;
  mtu: number;
  rxPackets: number;
  txPackets: number;
  rxBytes: number;
  txBytes: number;
}

function buildInterfaces(ctx: IpNetworkContext | null): IfaceInfo[] {
  const lo: IfaceInfo = {
    name: 'lo', up: true, ipv4: '127.0.0.1', netmask: '255.0.0.0',
    broadcast: '0.0.0.0', ipv6: '::1', mac: '00:00:00:00:00:00', mtu: 65536,
    rxPackets: 128, txPackets: 128, rxBytes: 10240, txBytes: 10240,
  };

  if (!ctx) {
    return [lo, {
      name: 'eth0', up: true, ipv4: '10.0.0.1', netmask: '255.255.255.0',
      broadcast: '10.0.0.255', ipv6: 'fe80::1', mac: '00:00:00:00:00:01', mtu: 1500,
      rxPackets: 1024, txPackets: 512, rxBytes: 102400, txBytes: 51200,
    }];
  }

  const ifaces: IfaceInfo[] = [lo];
  const names = ctx.getInterfaceNames();
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    if (name === 'lo') continue; // already added
    const info = ctx.getInterfaceInfo(name);
    if (!info) continue;
    const ip = info.ip || '0.0.0.0';
    const cidr = info.cidr ?? 24;
    const maskBits = cidr > 0 ? (~0 << (32 - cidr)) >>> 0 : 0;
    const mask = `${(maskBits >>> 24) & 0xff}.${(maskBits >>> 16) & 0xff}.${(maskBits >>> 8) & 0xff}.${maskBits & 0xff}`;
    ifaces.push({
      name: info.name, up: info.isUp && info.isConnected, ipv4: ip, netmask: mask,
      broadcast: ip.replace(/\.\d+$/, '.255'), ipv6: `fe80::${i + 1}`,
      mac: info.mac || `00:00:00:00:00:${String(i + 1).padStart(2, '0')}`,
      mtu: info.mtu || 1500,
      rxPackets: Math.floor(Math.random() * 5000), txPackets: Math.floor(Math.random() * 3000),
      rxBytes: Math.floor(Math.random() * 500000), txBytes: Math.floor(Math.random() * 300000),
    });
  }
  return ifaces;
}

function formatInterface(i: IfaceInfo): string {
  const flags = i.up ? 'UP' : 'DOWN';
  return [
    `${i.name}: flags=4163<${flags},BROADCAST,RUNNING,MULTICAST>  mtu ${i.mtu}`,
    `        inet ${i.ipv4}  netmask ${i.netmask}  broadcast ${i.broadcast}`,
    `        inet6 ${i.ipv6}  prefixlen 64  scopeid 0x20<link>`,
    `        ether ${i.mac}  txqueuelen 1000  (Ethernet)`,
    `        RX packets ${i.rxPackets}  bytes ${i.rxBytes} (${(i.rxBytes / 1024).toFixed(1)} KiB)`,
    `        RX errors 0  dropped 0  overruns 0  frame 0`,
    `        TX packets ${i.txPackets}  bytes ${i.txBytes} (${(i.txBytes / 1024).toFixed(1)} KiB)`,
    `        TX errors 0  dropped 0 overruns 0  carrier 0  collisions 0`,
    '',
  ].join('\n');
}

// ─── netstat ────────────────────────────────────────────────────────

export function cmdNetstat(
  args: string[],
  ctx: IpNetworkContext | null,
  isServer: boolean,
  socketTable?: SocketTable | null,
): string {
  // Expand combined flags: '-tlnp' → individual chars t,l,n,p
  const hasFlag = (ch: string): boolean =>
    args.some(a => a.startsWith('-') && !a.startsWith('--') && a.includes(ch)) ||
    args.includes(`--${ch}`);

  const routing = hasFlag('r') || args.includes('--route');
  const ifaces  = hasFlag('i') || args.includes('--interfaces');

  if (routing) {
    return [
      'Kernel IP routing table',
      'Destination     Gateway         Genmask         Flags   MSS Window  irtt Iface',
      '0.0.0.0         10.0.0.1        0.0.0.0         UG        0 0          0 eth0',
      '10.0.0.0        0.0.0.0         255.255.255.0   U         0 0          0 eth0',
      '127.0.0.0       0.0.0.0         255.0.0.0       U         0 0          0 lo',
    ].join('\n');
  }

  if (ifaces) {
    return [
      'Kernel Interface table',
      'Iface      MTU    RX-OK RX-ERR RX-DRP RX-OVR    TX-OK TX-ERR TX-DRP TX-OVR Flg',
      'eth0      1500     1024      0      0 0           512      0      0      0 BMRU',
      'lo       65536      128      0      0 0           128      0      0      0 LRU',
    ].join('\n');
  }

  // Determine which protocols to show (no -t/-u → show both)
  const wantTcp = hasFlag('t');
  const wantUdp = hasFlag('u');
  const showAll = !wantTcp && !wantUdp;

  const showProcesses = hasFlag('p');

  const lines = [
    'Active Internet connections (only servers)',
    'Proto Recv-Q Send-Q Local Address           Foreign Address         State       PID/Program name',
  ];

  if (socketTable) {
    for (const sock of socketTable.getAll()) {
      const isTcp = sock.protocol === 'tcp';
      const isUdp = sock.protocol === 'udp';
      if (!showAll && isTcp && !wantTcp) continue;
      if (!showAll && isUdp && !wantUdp) continue;

      const localAddr  = `${sock.localAddress}:${sock.localPort}`;
      const remoteAddr = sock.state === 'LISTEN' ? '0.0.0.0:*' : `${sock.remoteAddress}:${sock.remotePort}`;
      const stateCol   = isTcp ? sock.state : '';
      const pidCol     = showProcesses && sock.pid ? `${sock.pid}/${sock.processName}` : '';

      lines.push(formatNetstatLine(sock.protocol, localAddr, remoteAddr, stateCol, pidCol));
    }
  } else {
    // Fallback when no socket table is wired (e.g. in test environments that
    // construct LinuxCommandExecutor directly without a device).
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

function formatNetstatLine(
  proto: string,
  local: string,
  remote: string,
  state: string,
  pid: string,
): string {
  const p   = proto.padEnd(10);
  const rq  = '0'.padStart(6);
  const sq  = '0'.padStart(6);
  const loc = local.padEnd(23);
  const rem = remote.padEnd(23);
  const st  = state.padEnd(11);
  return `${p} ${rq} ${sq} ${loc} ${rem} ${st} ${pid}`.trimEnd();
}

// ─── ss ─────────────────────────────────────────────────────────────

export function cmdSs(args: string[], isServer: boolean, socketTable?: SocketTable | null): string {
  // Expand combined flags: '-tlnp' → individual chars t,l,n,p
  const hasFlag = (ch: string): boolean =>
    args.some(a => a.startsWith('-') && !a.startsWith('--') && a.includes(ch)) ||
    args.includes(`--${ch}`);

  const wantListening = hasFlag('l') || args.includes('--listening');
  const wantTcp       = hasFlag('t') || args.includes('--tcp');
  const wantUdp       = hasFlag('u') || args.includes('--udp');
  const showProcesses = hasFlag('p') || args.includes('--processes');
  const summary       = args.includes('-s') || args.includes('--summary');
  const showAll       = !wantTcp && !wantUdp; // no proto filter → show both

  if (summary) {
    return [
      'Total: 120',
      'TCP:   8 (estab 2, closed 0, orphaned 0, timewait 0)',
      '',
      'Transport Total     IP        IPv6',
      'RAW       1         0         1',
      'UDP       4         3         1',
      'TCP       8         6         2',
      'INET      13        9         4',
      'FRAG      0         0         0',
    ].join('\n');
  }

  const lines: string[] = [];
  lines.push('State      Recv-Q  Send-Q   Local Address:Port     Peer Address:Port  Process');

  if (socketTable) {
    for (const sock of socketTable.getAll()) {
      const isTcp = sock.protocol === 'tcp';
      const isUdp = sock.protocol === 'udp';
      if (!showAll && isTcp && !wantTcp) continue;
      if (!showAll && isUdp && !wantUdp) continue;
      if (wantListening && sock.state !== 'LISTEN') continue;

      const localAddr  = `${sock.localAddress}:${sock.localPort}`;
      const remoteAddr = sock.state === 'LISTEN' ? '0.0.0.0:*' : `${sock.remoteAddress}:${sock.remotePort}`;
      const stateCol   = sock.state;
      const procCol    = showProcesses && sock.pid
        ? ` users:(("${sock.processName}",pid=${sock.pid},fd=3))`
        : '';

      lines.push(`${stateCol.padEnd(10)} 0       0        ${localAddr.padEnd(22)} ${remoteAddr.padEnd(18)}${procCol}`);
    }
  } else {
    // Fallback (no socket table)
    if (wantListening || wantTcp || showAll) {
      const proc = showProcesses ? ' users:(("sshd",pid=985,fd=3))' : '';
      lines.push(`LISTEN     0       128      0.0.0.0:22            0.0.0.0:*        ${proc}`);
      if (isServer) {
        const sp = showProcesses ? ' users:(("tnslsnr",pid=2001,fd=12))' : '';
        lines.push(`LISTEN     0       128      0.0.0.0:1521          0.0.0.0:*        ${sp}`);
      }
    }
    if (!wantListening) {
      const proc = showProcesses ? ' users:(("sshd",pid=1200,fd=4))' : '';
      lines.push(`ESTAB      0       0        127.0.0.1:22          127.0.0.1:54322  ${proc}`);
    }
  }

  return lines.join('\n');
}

// ─── arping ─────────────────────────────────────────────────────────

/**
 * `arping` — probe a host at the link layer with ARP requests.
 *
 * The simulator has no live ARP responder on this path, so a probe to an
 * unreachable / powered-off target faithfully reports zero responses. The
 * `Sent N probes (N broadcast(s))` summary line matches real `arping`.
 */
export function cmdArping(args: string[]): string {
  let count = 0;
  let target = '';
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-c') { count = parseInt(args[++i], 10) || 0; continue; }
    if (a === '-I' || a === '-i' || a === '-s' || a === '-w') { i++; continue; }
    if (!a.startsWith('-')) target = a;
  }
  if (!target) {
    return 'Usage: arping [-fqbDUAV] [-c count] [-w timeout] [-I device] destination';
  }
  const probes = count > 0 ? count : 1;
  return [
    `ARPING ${target}`,
    `Sent ${probes} probes (${probes} broadcast(s))`,
    `Received 0 response(s)`,
  ].join('\n');
}

// ─── curl ───────────────────────────────────────────────────────────

export function cmdCurl(args: string[]): string {
  const verbose = args.includes('-v') || args.includes('--verbose');
  const head = args.includes('-I') || args.includes('--head');
  const silent = args.includes('-s') || args.includes('--silent');
  const url = args.filter(a => !a.startsWith('-')).pop();

  if (!url) return 'curl: try \'curl --help\' for more information';

  // Simulated responses for common URLs
  if (url.includes('localhost') || url.includes('127.0.0.1')) {
    if (head) {
      return [
        'HTTP/1.1 200 OK',
        'Date: ' + new Date().toUTCString(),
        'Server: Oracle-Application-Server-11g',
        'Content-Length: 0',
        'Content-Type: text/html; charset=UTF-8',
        '',
      ].join('\n');
    }
    return '<html><body><h1>It works!</h1></body></html>';
  }

  // External URLs: simulated connection error (no real network)
  if (verbose) {
    return [
      `*   Trying ${url}...`,
      '* connect to host failed',
      `* Failed to connect to ${url} port 80: Connection refused`,
      `curl: (7) Failed to connect to ${url} port 80 after 0 ms: Connection refused`,
    ].join('\n');
  }

  return `curl: (6) Could not resolve host: ${url.replace(/https?:\/\//, '').split('/')[0]}`;
}

// ─── wget ───────────────────────────────────────────────────────────

export function cmdWget(args: string[]): string {
  const quiet = args.includes('-q') || args.includes('--quiet');
  const url = args.filter(a => !a.startsWith('-')).pop();

  if (!url) return 'wget: missing URL\nUsage: wget [OPTION]... [URL]...';

  const host = url.replace(/https?:\/\//, '').split('/')[0];

  if (url.includes('localhost') || url.includes('127.0.0.1')) {
    const filename = url.split('/').pop() || 'index.html';
    if (quiet) return '';
    return [
      `--${new Date().toISOString().replace('T', ' ').slice(0, 19)}--  ${url}`,
      `Resolving ${host}... 127.0.0.1`,
      `Connecting to ${host}|127.0.0.1|:80... connected.`,
      'HTTP request sent, awaiting response... 200 OK',
      'Length: 1024 (1.0K) [text/html]',
      `Saving to: '${filename}'`,
      '',
      `${filename}              100%[===================>]   1.00K  --.-KB/s    in 0s`,
      '',
      `${new Date().toISOString().replace('T', ' ').slice(0, 19)} (10.0 MB/s) - '${filename}' saved [1024/1024]`,
    ].join('\n');
  }

  return [
    `--${new Date().toISOString().replace('T', ' ').slice(0, 19)}--  ${url}`,
    `Resolving ${host}... failed: Temporary failure in name resolution.`,
    `wget: unable to resolve host address '${host}'`,
  ].join('\n');
}

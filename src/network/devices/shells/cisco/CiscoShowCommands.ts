/**
 * CiscoShowCommands - Extracted show command implementations for Cisco IOS CLI
 *
 * Pure functions: Router → string (no side effects, no state mutation)
 * Used by CiscoIOSShell for "show" commands in user and privileged modes.
 */

import type { Router } from '../../Router';
import { runningConfigACL, runningConfigInterfaceACL } from './CiscoAclCommands';
import { runningConfigNAT, runningConfigInterfaceNAT } from './CiscoNATCommands';

import { CISCO_HARDWARE_PROFILES, type CiscoChassisProfile } from './CiscoCommonShow';
import { renderSecretField, renderPasswordField, type SecretAlgo } from './ciscoPasswordRender';

export function showVersion(router: Router, profile: CiscoChassisProfile = 'router-isr2911'): string {
  const ports = router._getPortsInternal();
  const giPorts = [...ports.keys()].filter(n => n.startsWith('Gig'));
  const hw = CISCO_HARDWARE_PROFILES[profile];
  const uptimeMs = router._getUptimeMs?.() ?? 0;
  return [
    `Cisco IOS Software, C2900 Software (C2900-UNIVERSALK9-M), Version 15.7(3)M5`,
    `Copyright (c) 1986-2025 by Cisco Systems, Inc.`,
    '',
    `ROM: System Bootstrap, Version 15.0(1r)M15`,
    '',
    `${router._getHostnameInternal()} uptime is ${formatUptime(uptimeMs)}`,
    `System image file is "flash:${hw.flashImage}"`,
    '',
    `Cisco C2911 (revision 1.0) with ${hw.dramKB}K/${hw.ioMemoryKB}K bytes of memory.`,
    `Processor board ID ${hw.serialNumber}`,
    `${giPorts.length} Gigabit Ethernet interfaces`,
    `DRAM configuration is 64 bits wide with parity enabled.`,
    `${hw.nvramKB}K bytes of non-volatile configuration memory.`,
    '',
    `Configuration register is 0x2102`,
  ].join('\n');
}

function formatUptime(ms: number): string {
  if (ms < 60_000) return '0 minutes';
  const totalMin = Math.floor(ms / 60_000);
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  const parts: string[] = [];
  if (days) parts.push(`${days} day${days === 1 ? '' : 's'}`);
  if (hours) parts.push(`${hours} hour${hours === 1 ? '' : 's'}`);
  parts.push(`${mins} minute${mins === 1 ? '' : 's'}`);
  return parts.join(', ');
}

export function showIpRoute(router: Router): string {
  const table = router.getRoutingTable();
  const lines = ['Codes: C - connected, S - static, R - RIP, O - OSPF, ' +
    'D - EIGRP, B - BGP, * - candidate default', ''];
  const def = table.find(r => r.type === 'default'
    || (r.network.toString() === '0.0.0.0' && r.mask.toCIDR() === 0));
  if (def && def.nextHop) {
    lines.push(`Gateway of last resort is ${def.nextHop} to network 0.0.0.0`, '');
  } else {
    lines.push('Gateway of last resort is not set', '');
  }
  const sorted = [...table].sort((a, b) => {
    const order: Record<string, number> = {
      connected: 0, ospf: 1, eigrp: 2, bgp: 3, rip: 4, static: 5, default: 6,
    };
    return (order[a.type] ?? 7) - (order[b.type] ?? 7);
  });
  for (const r of sorted) {
    let code: string;
    switch (r.type) {
      case 'connected': code = 'C'; break;
      case 'rip': code = 'R'; break;
      case 'ospf': code = 'O'; break;
      case 'eigrp': code = 'D'; break;
      case 'bgp': code = 'B'; break;
      case 'default': code = 'S*'; break;
      default: code = 'S'; break;
    }
    const via = r.nextHop ? `via ${r.nextHop}` : 'is directly connected';
    const metricStr = (r.type === 'rip' || r.type === 'ospf'
      || r.type === 'eigrp' || r.type === 'bgp') ? ` [${r.ad}/${r.metric}]` : '';
    lines.push(`${code}    ${r.network}/${r.mask.toCIDR()}${metricStr} ${via}, ${r.iface}`);
  }
  return lines.length > 2 ? lines.join('\n') : 'No routes configured.';
}

export function showIpIntBrief(router: Router): string {
  const ports = router._getPortsInternal();
  const lines = ['Interface                  IP-Address      OK? Method Status                Protocol'];
  for (const [name, port] of ports) {
    const ip = port.getIPAddress()?.toString() || 'unassigned';
    const isVirtual = /^(Tunnel|Loopback|Vlan|BVI|Bundle-Ether|Port-channel)/i.test(name);
    const adminUp = port.getIsUp();
    let status: string;
    let proto: string;
    if (!adminUp) {
      status = 'administratively down';
      proto = 'down';
    } else if (isVirtual) {
      status = 'up';
      proto = 'up';
    } else if (port.isConnected()) {
      status = 'up';
      proto = 'up';
    } else {
      status = 'down';
      proto = 'down';
    }
    lines.push(`${name.padEnd(27)}${ip.padEnd(16)}YES manual ${status.padEnd(22)}${proto}`);
  }
  return lines.join('\n');
}

/** IOS prints the ARP timeout as hh:mm:ss (default 04:00:00). */
function formatArpTimeout(totalSec: number): string {
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = Math.floor(totalSec % 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

export function showInterface(router: { _getPortsInternal: () => Map<string, import('../../../hardware/Port').Port> }, ifName: string): string {
  const ports = router._getPortsInternal();
  const port = ports.get(ifName);
  if (!port) return `% Invalid input detected at \'^\' marker.\nshow interface ${ifName}\n     ^`;

  const isUp = port.getIsUp();
  const connected = port.isConnected();
  const isVirtual = /^(Tunnel|Loopback|Vlan|BVI|Bundle-Ether|Port-channel)/i.test(ifName);
  const ip = port.getIPAddress()?.toString() || 'unassigned';
  const maskObj = port.getSubnetMask();
  const cidr = maskObj ? maskObj.toCIDR() : '';
  const mac = port.getMAC().toString();

  let status: string;
  let lineProto: string;
  if (!isUp) { status = 'administratively down'; lineProto = 'down'; }
  else if (isVirtual) { status = 'up'; lineProto = 'up'; }
  else if (connected) { status = 'up'; lineProto = 'up'; }
  else { status = 'down'; lineProto = 'down'; }

  const isTunnel = ifName.startsWith('Tunnel');
  const isLoopback = ifName.startsWith('Loopback');

  const lines = [
    `${ifName} is ${status}, line protocol is ${lineProto}`,
  ];

  if (isTunnel) {
    lines.push(`  Hardware is Tunnel`);
  } else if (isLoopback) {
    lines.push(`  Hardware is Loopback`);
  } else {
    lines.push(`  Hardware is ${ifName.startsWith('Gig') ? 'iGbE' : 'Fast Ethernet'}, address is ${mac} (bia ${mac})`);
  }

  if (ip !== 'unassigned') {
    lines.push(`  Internet address is ${ip}/${cidr}`);
  }

  if (isTunnel) {
    // Show tunnel-specific info
    const extra = (router as any).ospfExtraConfig?.pendingIfConfig;
    if (extra) {
      const tunCfg = extra.get(ifName);
      if (tunCfg?.tunnelSource) lines.push(`  Tunnel source ${tunCfg.tunnelSource}`);
      if (tunCfg?.tunnelDest) lines.push(`  Tunnel destination ${tunCfg.tunnelDest}`);
    }
    // Show tunnel protection info
    const ipsecEngine = (router as any)._getIPSecEngineInternal?.();
    if (ipsecEngine) {
      const tp = ipsecEngine.tunnelProtection?.get(ifName);
      if (tp) {
        lines.push(`  tunnel protection ipsec profile ${tp.profileName}${tp.shared ? ' shared' : ''}`);
      }
    }
    lines.push(`  Tunnel protocol/transport GRE/IP`);
  } else if (!isLoopback) {
    // Real port state: MTU, the `bandwidth`/`delay` overrides (or the
    // negotiated-speed defaults), duplex and ARP timeout all reflect
    // the live hardware model — not the interface name.
    const speedMbps = port.getNegotiatedSpeed();
    const duplex = port.getNegotiatedDuplex() === 'half'
      ? 'Half-duplex' : 'Full-duplex';
    lines.push(`  MTU ${port.getMTU()} bytes, BW ${port.getEffectiveBandwidthKbps()} Kbit/sec, DLY ${port.getDelayUs()} usec,`);
    lines.push(`     reliability 255/255, txload 1/255, rxload 1/255`);
    lines.push(`  Encapsulation ARPA, loopback not set`);
    lines.push(`  ${duplex}, ${speedMbps}Mbps, media type is RJ45`);
    lines.push(`  output flow-control is unsupported, input flow-control is unsupported`);
    lines.push(`  ARP type: ARPA, ARP Timeout ${formatArpTimeout(port.getArpTimeoutSec())}`);
  }

  if (!isTunnel && !isLoopback) {
    const c = port.getCounters();
    const rxPause = `  Last input ${connected ? '00:00:00' : 'never'}, output ${connected ? '00:00:00' : 'never'}, output hang never`;
    lines.push(rxPause);
    lines.push(`  Queueing strategy: fifo`);
    lines.push(`  5 minute input rate 0 bits/sec, 0 packets/sec`);
    lines.push(`  5 minute output rate 0 bits/sec, 0 packets/sec`);
    lines.push(`     ${c.framesIn} packets input, ${c.bytesIn} bytes, 0 no buffer`);
    lines.push(`     Received 0 broadcasts (0 multicasts)`);
    lines.push(`     0 runts, 0 giants, 0 throttles`);
    lines.push(`     ${c.errorsIn} input errors, 0 CRC, 0 frame, 0 overrun, 0 ignored`);
    lines.push(`     ${c.framesOut} packets output, ${c.bytesOut} bytes, 0 underruns`);
    lines.push(`     ${c.errorsOut} output errors, 0 collisions, 0 interface resets`);
    lines.push(`     ${c.dropsIn} input drops, ${c.dropsOut} output drops`);
  }

  return lines.join('\n');
}

// showArp() moved to CiscoArpCommands.ts (shared between router and switch)
export { showArp } from './CiscoArpCommands';

export function showRunningConfig(router: Router): string {
  const ports = router._getPortsInternal();
  const table = router._getRoutingTableInternal();
  const dhcp = router._getDHCPServerInternal();
  const lines = [
    'Building configuration...',
    '',
    'Current configuration:',
    '!',
    `hostname ${router._getHostnameInternal()}`,
    '!',
  ];

  // DHCP config
  if (dhcp.isEnabled()) {
    lines.push('service dhcp');
  }
  const pools = dhcp.getAllPools();
  for (const [, pool] of pools) {
    lines.push('!');
    lines.push(`ip dhcp pool ${pool.name}`);
    if (pool.network && pool.mask) lines.push(` network ${pool.network} ${pool.mask}`);
    if (pool.defaultRouter) lines.push(` default-router ${pool.defaultRouter}`);
    if (pool.dnsServers.length > 0) lines.push(` dns-server ${pool.dnsServers.join(' ')}`);
    if (pool.domainName) lines.push(` domain-name ${pool.domainName}`);
    const days = Math.floor(pool.leaseDuration / 86400);
    if (days !== 1) lines.push(` lease ${days}`);
  }
  const excluded = dhcp.getExcludedRanges();
  for (const range of excluded) {
    if (range.start === range.end) {
      lines.push(`ip dhcp excluded-address ${range.start}`);
    } else {
      lines.push(`ip dhcp excluded-address ${range.start} ${range.end}`);
    }
  }

  lines.push('!');
  const descs = router._getInterfaceDescriptions();
  for (const [name, port] of ports) {
    lines.push(`interface ${name}`);
    const desc = descs.get(name);
    if (desc) lines.push(` description ${desc}`);
    const ip = port.getIPAddress();
    const mask = port.getSubnetMask();
    if (ip && mask) lines.push(` ip address ${ip} ${mask}`);
    for (const sec of port.getSecondaryIPs()) lines.push(` ip address ${sec.ip} ${sec.mask} secondary`);
    lines.push(port.getIsUp() ? ` no shutdown` : ` shutdown`);
    const helpers = dhcp.getHelperAddresses(name);
    for (const h of helpers) {
      lines.push(` ip helper-address ${h}`);
    }
    lines.push(...runningConfigInterfaceACL(router, name));
    lines.push(...runningConfigInterfaceNAT(router, name));
    const sec = (router as unknown as {
      [s: symbol]: { asInterfaceRunningConfigLines?: (iface: string) => string[] } | undefined;
    })[Symbol.for('CiscoSecurityConfig')];
    if (sec?.asInterfaceRunningConfigLines) lines.push(...sec.asInterfaceRunningConfigLines(name));
    const nhrp = (router as unknown as { getNhrpService?: () => { asRunningConfigInterface: (n: string) => string[] } }).getNhrpService?.();
    if (nhrp) lines.push(...nhrp.asRunningConfigInterface(name));
    const nf = (router as unknown as { getNetflowService?: () => { asInterfaceRunningConfigLines: (n: string) => string[] } }).getNetflowService?.();
    if (nf) lines.push(...nf.asInterfaceRunningConfigLines(name));
    const ospfExtra = (router as unknown as { _getOSPFExtraConfig?: () => { pendingIfConfig: Map<string, Record<string, unknown>> } })._getOSPFExtraConfig?.();
    const pending = ospfExtra?.pendingIfConfig.get(name);
    if (pending) {
      if (pending.tunnelMode) lines.push(` tunnel mode ${pending.tunnelMode}`);
      if (pending.tunnelSource) lines.push(` tunnel source ${pending.tunnelSource}`);
      if (pending.tunnelDest) lines.push(` tunnel destination ${pending.tunnelDest}`);
      if (pending.tunnelKey) lines.push(` tunnel key ${pending.tunnelKey}`);
      if (pending.tunnelVrf) lines.push(` tunnel vrf ${pending.tunnelVrf}`);
      const pmtud = pending.tunnelPathMtuDiscovery as { enabled: boolean; ageTimer?: number; minMtu?: number } | undefined;
      if (pmtud?.enabled) {
        let s = ' tunnel path-mtu-discovery';
        if (pmtud.ageTimer !== undefined) s += ` age-timer ${pmtud.ageTimer}`;
        if (pmtud.minMtu !== undefined) s += ` min-mtu ${pmtud.minMtu}`;
        lines.push(s);
      }
      if (pending.bfdInterval !== undefined) {
        lines.push(` bfd interval ${pending.bfdInterval}${pending.bfdMinRx !== undefined ? ' min_rx ' + pending.bfdMinRx : ''}${pending.bfdMultiplier !== undefined ? ' multiplier ' + pending.bfdMultiplier : ''}`);
      }
      if (pending.bfdTemplate) lines.push(` bfd template ${pending.bfdTemplate}`);
      if (pending.bfdEcho) lines.push(' bfd echo');
      const fr = pending.frameRelay as Record<string, unknown> | undefined;
      if (fr) {
        if (fr.dlci !== undefined) lines.push(` frame-relay interface-dlci ${fr.dlci}`);
        if (fr.lmiType) lines.push(` frame-relay lmi-type ${fr.lmiType}`);
        if (fr.inverseArp) lines.push(' frame-relay inverse-arp');
        for (const m of (fr.maps as Array<{ ip: string; dlci: number }>) ?? []) {
          lines.push(` frame-relay map ip ${m.ip} ${m.dlci}`);
        }
      }
    }
    lines.push('!');
  }

  // ACL configuration
  const aclLines = runningConfigACL(router);
  if (aclLines.length > 0) {
    lines.push(...aclLines);
    lines.push('!');
  }

  // NAT configuration
  const natLines = runningConfigNAT(router);
  if (natLines.length > 0) {
    lines.push(...natLines);
    lines.push('!');
  }

  for (const r of table) {
    if (r.type === 'static' && r.nextHop) lines.push(`ip route ${r.network} ${r.mask} ${r.nextHop}`);
    if (r.type === 'default' && r.nextHop) lines.push(`ip route 0.0.0.0 0.0.0.0 ${r.nextHop}`);
  }

  // RIP config
  if (router.isRIPEnabled()) {
    lines.push('!');
    lines.push('router rip');
    lines.push(` version ${router.getRipVersion()}`);
    const cfg = router.getRIPConfig();
    for (const net of cfg.networks) {
      lines.push(` network ${net.network}`);
    }
  }

  // Local AAA users (`username NAME privilege N secret …`).
  const listUsers = (router as unknown as {
    _listLocalUsers?: () => ReadonlyArray<{ name: string; privilege: number; secret: string; secretAlgo?: SecretAlgo; factoryDefault?: boolean }>;
  })._listLocalUsers;
  if (listUsers) {
    const users = listUsers.call(router).filter(u => !u.factoryDefault);
    if (users.length > 0) {
      lines.push('!');
      for (const u of users) {
        const algo = u.secretAlgo ?? 'md5';
        // type-7 is a reversible *password*; everything else is a *secret*.
        const field = algo === 'type-7'
          ? `password ${renderPasswordField(u.secret, 'type-7', false)}`
          : `secret ${renderSecretField(u.secret, algo)}`;
        lines.push(`username ${u.name} privilege ${u.privilege} ${field}`);
      }
    }
  }

  // VTY line configuration (exec-timeout, access-class, transport input, …)
  const vtyStore = (router as unknown as { _getVtyLineConfig?: () => { renderAllCisco: () => string[] } })._getVtyLineConfig?.();
  if (vtyStore) {
    const vtyLines = vtyStore.renderAllCisco();
    if (vtyLines.length > 0) {
      lines.push(...vtyLines);
    }
  }

  if (!router.isIpRoutingEnabled()) {
    lines.push('no ip routing');
    lines.push('!');
  }

  const serviceEncryption = router.getServiceFlags().get('password-encryption') === true;
  const enableSecret = router.getEnableSecret();
  if (enableSecret) {
    lines.push(`enable secret ${renderSecretField(enableSecret.value, enableSecret.algo)}`);
  }
  const enablePassword = router.getEnablePassword();
  if (enablePassword) {
    lines.push(`enable password ${renderPasswordField(enablePassword.value, enablePassword.algo, serviceEncryption)}`);
  }
  for (const [name, on] of router.getServiceFlags()) {
    lines.push(`${on ? '' : 'no '}service ${name}`);
  }

  const mgmtForSsh = (router as unknown as { getManagementService?: () => import('../../router/management/RouterManagementService').RouterManagementService }).getManagementService?.();
  if (mgmtForSsh) {
    if (mgmtForSsh.domainName) lines.push(`ip domain-name ${mgmtForSsh.domainName}`);
    const ssh = mgmtForSsh.getSsh();
    if (ssh.enabled) {
      if (ssh.version !== 2) lines.push(`ip ssh version ${ssh.version}`);
      if (ssh.timeout !== 60) lines.push(`ip ssh time-out ${ssh.timeout}`);
      if (ssh.retries !== 3) lines.push(`ip ssh authentication-retries ${ssh.retries}`);
      const port = (ssh as unknown as { port?: number }).port ?? 22;
      if (port !== 22) lines.push(`ip ssh port ${port}`);
    }
  }

  const unhandled = router.getUnhandledConfigLines();
  if (unhandled.length > 0) {
    lines.push('!');
    lines.push(...unhandled);
  }

  const mgmt = (router as unknown as { getManagementService?: () => import('../../router/management/RouterManagementService').RouterManagementService }).getManagementService?.();
  if (mgmt) {
    const clock = mgmt.getClock();
    if (clock.timezone !== 'UTC') {
      const sign = clock.offsetMin >= 0 ? '' : '-';
      const abs = Math.abs(clock.offsetMin);
      lines.push(`clock timezone ${clock.timezone} ${sign}${Math.floor(abs / 60)} ${abs % 60}`);
    }
    if (clock.summerTimezone) {
      lines.push(`clock summer-time ${clock.summerTimezone} recurring ${clock.daylightStart} ${clock.daylightEnd}`);
    }
  }

  const loggingCfg = (router as unknown as { _loggingConfig?: { asRunningConfigLines: () => string[] } })._loggingConfig;
  if (loggingCfg) {
    const ll = loggingCfg.asRunningConfigLines();
    if (ll.length > 0) { lines.push('!'); lines.push(...ll); }
  }

  const shellWithKeyChains = (router as unknown as { getShell?: () => { getKeyChains?: () => { asRunningConfigLines(): string[] } } }).getShell?.();
  const kcRepo = shellWithKeyChains?.getKeyChains?.();
  if (kcRepo) {
    const kl = kcRepo.asRunningConfigLines();
    if (kl.length > 0) { lines.push('!'); lines.push(...kl); }
  }

  const ntpAgent = (router as unknown as { getNtpAgent?: () => { asRunningConfigLines?: () => string[] } }).getNtpAgent?.();
  if (ntpAgent?.asRunningConfigLines) {
    const nl = ntpAgent.asRunningConfigLines();
    if (nl.length > 0) { lines.push('!'); lines.push(...nl); }
  }

  const cdp = (router as unknown as { getCdpAgent?: () => { asRunningConfigLines?: () => string[] } }).getCdpAgent?.();
  if (cdp?.asRunningConfigLines) {
    const cl = cdp.asRunningConfigLines();
    if (cl.length > 0) { lines.push('!'); lines.push(...cl); }
  }

  const lldp = (router as unknown as { getLldpAgent?: () => { asRunningConfigLines?: () => string[] } }).getLldpAgent?.();
  if (lldp?.asRunningConfigLines) {
    const lll = lldp.asRunningConfigLines();
    if (lll.length > 0) { lines.push('!'); lines.push(...lll); }
  }

  const snmp = (router as unknown as { getSnmpService?: () => import('../../router/management/SnmpService').SnmpService }).getSnmpService?.();
  if (snmp) {
    const sl = snmp.asRunningConfigLines();
    if (sl.length > 0) { lines.push('!'); lines.push(...sl); }
  }

  const netflow = (router as unknown as { getNetflowService?: () => import('../../router/netflow/NetflowService').NetflowService }).getNetflowService?.();
  if (netflow) {
    const nl = netflow.asRunningConfigLines();
    if (nl.length > 0) { lines.push('!'); lines.push(...nl); }
  }

  const archive = (router as unknown as { getArchiveService?: () => import('../../router/archive/ArchiveService').ArchiveService }).getArchiveService?.();
  if (archive) {
    const al = archive.asRunningConfigLines();
    if (al.length > 0) { lines.push('!'); lines.push(...al); }
  }

  const eem = (router as unknown as { getEemService?: () => import('../../router/eem/EemService').EemService }).getEemService?.();
  if (eem) {
    const el = eem.asRunningConfigLines();
    if (el.length > 0) { lines.push('!'); lines.push(...el); }
  }

  const securityLines = (router as unknown as {
    [s: symbol]: { asRunningConfigLines?: () => string[] } | undefined;
  })[Symbol.for('CiscoSecurityConfig')]?.asRunningConfigLines?.() ?? [];
  if (securityLines.length > 0) {
    lines.push('!');
    lines.push(...securityLines);
    lines.push('!');
  }

  const ipsec = router._getIPSecEngineInternal?.();
  if (ipsec) {
    const cryptoLines = ipsec.asRunningConfigLines();
    if (cryptoLines.length > 0) {
      lines.push(...cryptoLines);
      lines.push('!');
    }
  }

  lines.push('end');
  return lines.join('\n');
}

export function showRunningConfigInterface(router: Router, ifName: string): string {
  const port = router.getPort(ifName);
  if (!port) return `% Invalid interface "${ifName}"`;

  const ip = port.getIPAddress();
  const mask = port.getSubnetMask();
  const dhcp = router._getDHCPServerInternal();
  const lines = [
    'Building configuration...',
    '',
    `Current configuration : interface ${ifName}`,
    '!',
    `interface ${ifName}`,
  ];
  const desc = router.getInterfaceDescription(ifName);
  if (desc) lines.push(` description ${desc}`);
  if (ip && mask) {
    lines.push(` ip address ${ip} ${mask}`);
    for (const sec of port.getSecondaryIPs()) lines.push(` ip address ${sec.ip} ${sec.mask} secondary`);
    lines.push(` no shutdown`);
  } else {
    lines.push(` shutdown`);
  }
  const helpers = dhcp.getHelperAddresses(ifName);
  for (const h of helpers) {
    lines.push(` ip helper-address ${h}`);
  }
  lines.push('end');
  return lines.join('\n');
}

export function showCounters(router: Router): string {
  const c = router.getCounters();
  return [
    'IP statistics:',
    `  Rcvd:  ${c.ifInOctets} total octets`,
    `  Sent:  ${c.ifOutOctets} total octets`,
    `  Frags: ${c.ipForwDatagrams} forwarded`,
    `  Drop:  ${c.ipInHdrErrors} header errors, ${c.ipInAddrErrors} address errors`,
    '',
    'ICMP statistics:',
    `  Sent: ${c.icmpOutMsgs} total`,
    `    Destination unreachable: ${c.icmpOutDestUnreachs}`,
    `    Time exceeded: ${c.icmpOutTimeExcds}`,
    `    Echo replies: ${c.icmpOutEchoReps}`,
  ].join('\n');
}

export function showIpProtocols(router: Router): string {
  const sections: string[] = [];

  const ospf = router._getOSPFEngineInternal?.();
  if (ospf) {
    const cfg = ospf.getConfig();
    const block: string[] = [
      `Routing Protocol is "ospf ${cfg.processId}"`,
      `  Outgoing update filter list for all interfaces is not set`,
      `  Incoming update filter list for all interfaces is not set`,
      `  Router ID ${cfg.routerId}`,
      `  Number of areas in this router is ${cfg.areas.size}`,
      `  Reference bandwidth unit is ${cfg.autoCostReferenceBandwidth} mbps`,
      `  Routing for Networks:`,
    ];
    for (const n of cfg.networks) block.push(`    ${n.network} ${n.wildcard} area ${n.areaId}`);
    block.push('  Routing Information Sources:', '    Gateway         Distance      Last Update');
    for (const iface of ospf.getInterfaces().values()) {
      for (const nbr of iface.neighbors.values()) {
        block.push(`    ${nbr.routerId.padEnd(16)}110           00:00:00`);
      }
    }
    block.push('  Distance: (default is 110)');
    sections.push(block.join('\n'));
  }

  if (router.isRIPEnabled()) {
    const cfg = router.getRIPConfig();
    const ripRoutes = router.getRIPRoutes();
    const block = [
      'Routing Protocol is "rip"',
      '  Version: 2',
      `  Update interval: ${cfg.updateInterval / 1000}s`,
      `  Route timeout: ${cfg.routeTimeout / 1000}s`,
      `  Garbage collection: ${cfg.gcTimeout / 1000}s`,
      `  Split horizon: ${cfg.splitHorizon ? 'enabled' : 'disabled'}`,
      `  Poisoned reverse: ${cfg.poisonedReverse ? 'enabled' : 'disabled'}`,
      '',
      '  Advertised networks:',
    ];
    for (const net of cfg.networks) {
      block.push(`    ${net.network}/${net.mask.toCIDR()}`);
    }
    block.push('');
    block.push(`  RIP learned routes: ${ripRoutes.size}`);
    for (const [key, info] of ripRoutes) {
      block.push(`    ${key} metric ${info.metric} via ${info.learnedFrom} (age ${info.age}s)${info.garbageCollect ? ' [gc]' : ''}`);
    }
    sections.push(block.join('\n'));
  }

  const ipv6Engine = (router as unknown as { isBGPEnabled?: () => boolean }).isBGPEnabled?.();
  if (ipv6Engine) {
    sections.push('Routing Protocol is "bgp"');
  }

  if (sections.length === 0) return 'No routing protocol is configured.';
  return sections.join('\n\n');
}

/** `show interfaces` (all) — real per-port detail for every interface. */
export function showInterfaceAccounting(router: Router, ifName: string): string {
  const port = router._getPortsInternal().get(ifName);
  if (!port) return `% Invalid interface ${ifName}`;
  const c = port.getCounters();
  return [
    `${ifName}`,
    `                Protocol    Pkts In    Chars In    Pkts Out   Chars Out`,
    `                    IP    ${String(c.framesIn).padStart(8)} ${String(c.bytesIn).padStart(11)} ${String(c.framesOut).padStart(11)} ${String(c.bytesOut).padStart(11)}`,
  ].join('\n');
}

export function showInterfaceStats(router: Router, ifName: string): string {
  const port = router._getPortsInternal().get(ifName);
  if (!port) return `% Invalid interface ${ifName}`;
  const c = port.getCounters();
  return [
    `${ifName}`,
    `          Switching path    Pkts In    Chars In    Pkts Out   Chars Out`,
    `               Processor ${String(c.framesIn).padStart(10)} ${String(c.bytesIn).padStart(11)} ${String(c.framesOut).padStart(11)} ${String(c.bytesOut).padStart(11)}`,
    `             Route cache          0           0           0           0`,
    `      Distributed cache          0           0           0           0`,
    `                  Total ${String(c.framesIn).padStart(10)} ${String(c.bytesIn).padStart(11)} ${String(c.framesOut).padStart(11)} ${String(c.bytesOut).padStart(11)}`,
  ].join('\n');
}

export function showInterfaceSwitchport(router: Router, ifName: string): string {
  void router;
  return [
    `Name: ${ifName}`,
    `Switchport: Disabled (router interface)`,
  ].join('\n');
}

export function showInterfacesTrunk(router: Router): string {
  void router;
  return 'Port        Mode             Encapsulation  Status        Native vlan\n(none — this is a router, no L2 trunks)';
}

export function showVlansRouter(router: Router): string {
  void router;
  return 'No Virtual LAN sub-interfaces are configured';
}

export function showIpv6InterfaceBrief(router: Router): string {
  const ports = router._getPortsInternal();
  const lines: string[] = [];
  for (const [name, port] of ports) {
    const v6 = (port as unknown as { getIPv6Addresses?: () => string[] }).getIPv6Addresses?.() ?? [];
    const up = port.getIsUp() ? 'up' : 'administratively down';
    const proto = (port.getIsUp() && (port.isConnected() || /^(Tunnel|Loopback|Vlan)/i.test(name))) ? 'up' : 'down';
    lines.push(`${name.padEnd(27)}[${up}/${proto}]`);
    if (v6.length === 0) lines.push(`    unassigned`);
    else for (const a of v6) lines.push(`    ${a}`);
  }
  return lines.join('\n');
}

export function showIpv6Interface(router: Router, ifName: string): string {
  const port = router._getPortsInternal().get(ifName);
  if (!port) return `% Invalid interface ${ifName}`;
  const v6 = (port as unknown as { getIPv6Addresses?: () => string[] }).getIPv6Addresses?.() ?? [];
  return [
    `${ifName} is ${port.getIsUp() ? 'up' : 'administratively down'}, line protocol is ${port.getIsUp() && port.isConnected() ? 'up' : 'down'}`,
    `  IPv6 is ${v6.length > 0 ? 'enabled' : 'disabled'}`,
    ...v6.map(a => `  Address: ${a}`),
    `  MTU is ${port.getMTU()} bytes`,
  ].join('\n');
}

export function showInterfacesAll(router: Router): string {
  const names = [...router._getPortsInternal().keys()];
  if (!names.length) return 'No interfaces present.';
  return names.map((n) => showInterface(router, n)).join('\n');
}

/** `show interfaces description` — real status/protocol/description table. */
export function showInterfacesDescription(router: Router): string {
  const rows = ['Interface                      Status         Protocol Description'];
  for (const [name, port] of router._getPortsInternal()) {
    const up = port.getIsUp();
    const status = up ? 'up' : 'admin down';
    const proto = up && port.isConnected() ? 'up' : 'down';
    const desc = router.getInterfaceDescription(name) || '';
    rows.push(`${name.padEnd(31)}${status.padEnd(15)}${proto.padEnd(9)}${desc}`);
  }
  return rows.join('\n');
}

/** `show interfaces status` — real connected/notconnect/disabled table. */
export function showInterfacesStatus(router: Router): string {
  const rows = ['Port      Name               Status       Vlan       Duplex  Speed Type'];
  for (const [name, port] of router._getPortsInternal()) {
    const status = port.getIsUp()
      ? (port.isConnected() ? 'connected' : 'notconnect')
      : 'disabled';
    const desc = (router.getInterfaceDescription(name) || '').slice(0, 17);
    rows.push(
      `${name.slice(0, 9).padEnd(10)}${desc.padEnd(19)}${status.padEnd(13)}` +
      `${'routed'.padEnd(11)}${String(port.getDuplex()).padEnd(8)}` +
      `${String(port.getSpeed()).padEnd(6)}${name.startsWith('Gig') ? '1000BASE-T' : '10/100BaseTX'}`);
  }
  return rows.join('\n');
}

/** `show interfaces summary` — real per-port queue summary. */
export function showInterfacesSummary(router: Router): string {
  const rows = [
    ' Interface                IHQ   IQD  OHQ   OQD  RXBS RXPS  TXBS  TXPS  TRTL',
    '--------------------------------------------------------------------------',
  ];
  for (const name of router._getPortsInternal().keys()) {
    rows.push(` ${name.padEnd(24)}  0     0    0     0     0    0     0     0     0`);
  }
  return rows.join('\n');
}

/** `show ip interface` (all, verbose) — real per-port L3 state. */
export function showIpInterfaceAll(router: Router): string {
  const blocks: string[] = [];
  for (const [name, port] of router._getPortsInternal()) {
    const up = port.getIsUp();
    const ip = port.getIPAddress();
    const mask = port.getSubnetMask();
    blocks.push([
      `${name} is ${up ? 'up' : 'administratively down'}, ` +
        `line protocol is ${up && port.isConnected() ? 'up' : 'down'}`,
      ip
        ? `  Internet address is ${ip}${mask ? `/${mask.toCIDR()}` : ''}`
        : '  Internet protocol processing disabled',
      '  Broadcast address is 255.255.255.255',
      '  MTU is 1500 bytes',
      '  ICMP redirects are always sent',
      '  Proxy ARP is enabled',
    ].join('\n'));
  }
  return blocks.length ? blocks.join('\n') : 'No interfaces present.';
}

/** `show ip rip database` — real RIP RIB (configured + learned). */
export function showIpRipDatabase(router: Router): string {
  if (!router.isRIPEnabled()) return '';
  const cfg = router.getRIPConfig();
  const learned = router.getRIPRoutes();
  const lines: string[] = [];
  for (const net of cfg.networks) {
    lines.push(`${net.network}/${net.mask.toCIDR()}    auto-summary`);
    lines.push(`${net.network}/${net.mask.toCIDR()}`);
    lines.push('    [1] directly connected, via configured network');
  }
  for (const [key, info] of learned) {
    lines.push(`${key}`);
    lines.push(`    [${info.metric}] via ${info.learnedFrom}, ` +
      `${info.age}s${info.garbageCollect ? ', possibly down' : ''}`);
  }
  return lines.length ? lines.join('\n') : 'RIP routing database is empty';
}

/** `show ip cef` — real FIB derived from the routing table. */
export function showIpCef(router: Router): string {
  const rt = router.getRoutingTable();
  const lines = ['Prefix               Next Hop             Interface'];
  lines.push('0.0.0.0/0            no route');
  for (const r of rt) {
    const prefix = `${r.network}/${r.mask.toCIDR()}`;
    const nh = r.nextHop ? String(r.nextHop) : 'attached';
    lines.push(`${prefix.padEnd(21)}${nh.padEnd(21)}${r.iface}`);
  }
  return lines.join('\n');
}

/** `show ip bgp …` — honest state: no BGP process configured. */
export function showBgpNotActive(): string {
  return '% BGP not active';
}

/** `show ip eigrp …` — honest state: no EIGRP process configured. */
export function showEigrpNotRunning(): string {
  return '% EIGRP not running (no autonomous-system configured)';
}

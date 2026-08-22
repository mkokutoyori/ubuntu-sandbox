import type {
  OspfLsaFacts, OspfAreaFacts, OspfDatabaseFacts, OspfInterfaceFacts,
} from '../../../routing/DynamicRoutingTypes';

const SECTION_TITLE: Readonly<Record<number, string>> = Object.freeze({
  1: 'Router Link States',
  2: 'Net Link States',
  3: 'Summary Link States',
  4: 'ASBR-Summary Link States',
  5: 'AS External Link States',
});

const SECTION_HEADER: Readonly<Record<number, string>> = Object.freeze({
  1: 'Link ID         ADV Router      Age  Seq#       CkSum  Link count',
  2: 'Link ID         ADV Router      Age  Seq#       CkSum',
  3: 'Link ID         ADV Router      Age  Seq#       CkSum  Route',
  4: 'Link ID         ADV Router      Age  Seq#       CkSum',
  5: 'Link ID         ADV Router      Age  Seq#       CkSum  Route',
});

const AREA_TYPES: readonly number[] = Object.freeze([1, 2, 3, 4]);

function hex(value: number, width: number): string {
  return (value >>> 0).toString(16).padStart(width, '0');
}

function lsaRow(lsa: OspfLsaFacts): string {
  const common = lsa.linkStateId.padEnd(15)
    + `${lsa.advertisingRouter.padEnd(15)} ${String(lsa.lsAge).padStart(4)}`
    + ` 0x${hex(lsa.lsSequenceNumber, 8)} 0x${hex(lsa.checksum, 4)}`;

  if (lsa.lsType === 1) return `${common} ${lsa.linkCount ?? 0}`;
  if (lsa.lsType === 3 || lsa.lsType === 4) {
    return lsa.route === undefined ? common : `${common} ${lsa.route}`;
  }
  if (lsa.lsType === 5) {
    return `${common} ${lsa.metricType === 1 ? 'E1' : 'E2'} ${lsa.route ?? ''}`
      + ` [0x${(lsa.routeTag ?? 0).toString(16)}]`;
  }
  return common;
}

function section(title: string, header: string, lsas: readonly OspfLsaFacts[]): string[] {
  return [`                ${title}`, '', header, ...lsas.map(lsaRow), ''];
}

export function renderOspfDatabase(facts: OspfDatabaseFacts): string {
  const lines: string[] = ['', `       OSPF Router with ID (${facts.routerId})`, ''];

  for (const area of facts.areas) {
    for (const type of AREA_TYPES) {
      const lsas = area.lsas.filter(lsa => lsa.lsType === type);
      if (lsas.length === 0) continue;
      lines.push(...section(
        `${SECTION_TITLE[type]} (Area ${area.areaId})`, SECTION_HEADER[type], lsas));
    }
  }
  if (facts.external.length > 0) {
    lines.push(...section(SECTION_TITLE[5], SECTION_HEADER[5], facts.external));
  }
  return lines.join('\n');
}

export function renderOspfInterface(facts: OspfInterfaceFacts): string[] {
  const lines = [
    `${facts.name} is ${facts.up ? 'up' : 'down'}`,
    `  ifindex ${facts.ifindex}, MTU ${facts.mtu} bytes, BW ${facts.bandwidthMbit} Mbit`
    + ` <UP,BROADCAST,RUNNING,MULTICAST>`,
  ];
  if (!facts.enabled) {
    lines.push('  OSPF not enabled on this interface');
    return lines;
  }
  if (!facts.up) {
    lines.push('  OSPF is enabled, but not running on this interface');
    return lines;
  }

  lines.push(
    `  Internet Address ${facts.address ?? '0.0.0.0'}/${facts.prefixLength ?? 0},`
    + ` Broadcast ${facts.broadcast ?? '0.0.0.0'}, Area ${facts.areaId}`,
    '  MTU mismatch detection: enabled',
    `  Router ID ${facts.routerId}, Network Type ${facts.networkType},`
    + ` Cost: ${facts.cost}`,
    `  Transmit Delay is ${facts.transmitDelay} sec, State ${facts.state},`
    + ` Priority ${facts.priority}`,
  );

  if (facts.drRouterId === undefined) {
    lines.push('  No designated router on this network');
  } else {
    lines.push(
      `  Designated Router (ID) ${facts.drRouterId},`
      + ` Interface Address ${facts.drAddress ?? '0.0.0.0'}`);
  }
  if (facts.bdrRouterId === undefined) {
    lines.push('  No backup designated router on this network');
  } else {
    lines.push(
      `  Backup Designated Router (ID) ${facts.bdrRouterId},`
      + ` Interface Address ${facts.bdrAddress ?? '0.0.0.0'}`);
  }

  lines.push(
    `  Timer intervals configured, Hello ${facts.helloInterval}s,`
    + ` Dead ${facts.deadInterval}s, Wait ${facts.deadInterval}s,`
    + ` Retransmit ${facts.retransmitInterval}`,
    facts.passive
      ? '    No Hellos (Passive interface)'
      : `    Hello due in ${facts.helloInterval}.000s`,
    `  Neighbor Count is ${facts.neighbourCount},`
    + ` Adjacent neighbor count is ${facts.adjacentCount}`,
  );
  return lines;
}

export function renderOspfInterfaces(facts: readonly OspfInterfaceFacts[]): string {
  return facts.flatMap(renderOspfInterface).join('\n');
}

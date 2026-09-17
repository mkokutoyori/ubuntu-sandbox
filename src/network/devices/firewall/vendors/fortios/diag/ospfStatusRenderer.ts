import type {
  OspfStatusAreaFacts, OspfStatusFacts,
} from '../../../routing/DynamicRoutingTypes';

const AREA_INDENT = ' '.repeat(4);
const AREA_BODY_INDENT = ' '.repeat(8);
const BACKBONE_AREA = '0.0.0.0';

function checksumSum(total: number): string {
  return `0x${(total >>> 0).toString(16).toUpperCase().padStart(6, '0')}`;
}

function twoDigits(value: number): string {
  return String(value).padStart(2, '0');
}

function elapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms));
  const seconds = Math.floor(total / 1000);
  return `${twoDigits(Math.floor(seconds / 3600))}`
    + `:${twoDigits(Math.floor(seconds / 60) % 60)}`
    + `:${twoDigits(seconds % 60)}.${String(total % 1000).padStart(3, '0')}`;
}

function areaLines(area: OspfStatusAreaFacts, msSinceLastSpf: number | null): string[] {
  const title = area.areaId === BACKBONE_AREA
    ? `${area.areaId} (BACKBONE)` : area.areaId;
  const lines = [
    `${AREA_INDENT}Area ${title}`,
    `${AREA_BODY_INDENT}Number of interfaces in this area is`
      + ` ${area.activeInterfaceCount}(${area.interfaceCount})`,
    `${AREA_BODY_INDENT}Number of fully adjacent neighbors in this area is`
      + ` ${area.fullyAdjacentNeighbors}`,
  ];
  if (!area.authenticated) lines.push(`${AREA_BODY_INDENT}Area has no authentication`);
  if (msSinceLastSpf !== null) {
    lines.push(`${AREA_BODY_INDENT}SPF algorithm last executed`
      + ` ${elapsed(msSinceLastSpf)} ago`);
  }
  lines.push(
    `${AREA_BODY_INDENT}SPF algorithm executed ${area.spfRuns} times`,
    `${AREA_BODY_INDENT}Number of LSA ${area.lsaCount}.`
      + ` Checksum ${checksumSum(area.lsaChecksumSum)}`,
  );
  return lines;
}

export function renderOspfStatus(facts: OspfStatusFacts): string {
  const lines = [
    ` Routing Process "ospf 0" with ID ${facts.routerId}`,
    ' Process bound to VRF default',
    ' Conforms to RFC2328, and RFC1583Compatibility flag is disabled',
    ' Supports only single TOS(TOS0) routes',
    ' Do not support Restarting',
    ` Number of external LSA ${facts.externalLsaCount}.`
      + ` Checksum ${checksumSum(facts.externalLsaChecksumSum)}`,
    ` Number of non-default external LSA ${facts.nonDefaultExternalLsaCount}`,
    ' External LSA database is unlimited.',
    ` Number of LSA originated ${facts.lsaOriginated}`,
    ` Number of LSA received ${facts.lsaReceived}`,
    ` Number of areas attached to this router: ${facts.areas.length}`,
  ];
  for (const area of facts.areas) lines.push(...areaLines(area, facts.msSinceLastSpf));
  return lines.join('\n');
}

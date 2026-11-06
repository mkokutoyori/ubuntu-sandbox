import type { Equipment } from '@/network';
import type { LabWorkbench } from '../LabWorkbench';
import { HQ } from './plan';

const AUDIT_DIRECTORY = '/opt/audit';
const HQ_WAN = '203.0.113.1';

export async function configureAuditWorkstation(bench: LabWorkbench, pc: Equipment): Promise<void> {
  await bench.shell(pc, `sudo mkdir -p ${AUDIT_DIRECTORY}`);

  await bench.writeFile(pc, `${AUDIT_DIRECTORY}/check-web-vip.sh`, [
    '#!/bin/bash',
    'echo "Scope item 1: the published web VIP accepts HTTP and names the site"',
    `TARGET="${HQ.wanVip.web}"`,
    'curl -sS -o /tmp/audit-web.html -w "HTTP_STATUS=%{http_code}\\n" "http://$TARGET/"',
    'grep -q "Meridian Industries" /tmp/audit-web.html && echo "PASS: site identified"',
  ].join('\n'), '755');

  await bench.writeFile(pc, `${AUDIT_DIRECTORY}/check-mail-vip.sh`, [
    '#!/bin/bash',
    'echo "Scope item 2: the published mail VIP accepts SMTP on 25 and nothing else"',
    `TARGET="${HQ.wanVip.mail}"`,
    'nc -zv -w 3 "$TARGET" 25 && echo "PASS: SMTP reachable as scoped"',
    'nc -zv -w 3 "$TARGET" 22 2>&1 | grep -qi "refused\\|timed out" && echo "PASS: SSH not exposed"',
  ].join('\n'), '755');

  await bench.writeFile(pc, `${AUDIT_DIRECTORY}/check-out-of-scope.sh`, [
    '#!/bin/bash',
    'echo "Scope item 3: nothing outside the two published VIPs answers from the Internet"',
    `nc -zv -w 3 "${HQ.wanVip.web}" 1521 2>&1 | grep -qi "refused\\|timed out" && echo "PASS: database port not exposed"`,
    `ping -c 2 "${HQ.workstation}" | grep -q "100% packet loss" && echo "PASS: internal LAN not routable"`,
  ].join('\n'), '755');

  await bench.writeFile(pc, `${AUDIT_DIRECTORY}/check-mgmt-exposure.sh`, [
    '#!/bin/bash',
    'echo "Scope item 4: the firewall management plane (HTTPS GUI, SSH) must not answer from the Internet"',
    `nc -zv -w 3 "${HQ_WAN}" 443 2>&1 | grep -qi "refused\\|timed out" && echo "PASS: admin HTTPS not exposed on WAN"`,
    `nc -zv -w 3 "${HQ_WAN}" 22 2>&1 | grep -qi "refused\\|timed out" && echo "PASS: admin SSH not exposed on WAN"`,
  ].join('\n'), '755');

  await bench.writeFile(pc, `${AUDIT_DIRECTORY}/check-flood-resistance.sh`, [
    '#!/bin/bash',
    'echo "Scope item 5: a burst of echo requests at the firewall WAN address must be throttled by the DoS policy"',
    `RECEIVED=$(ping -c 120 -i 0.005 "${HQ_WAN}" | grep -o "[0-9]* received" | cut -d" " -f1)`,
    'echo "echoes answered out of 120: $RECEIVED"',
    '[ "$RECEIVED" -lt 120 ] && echo "PASS: ICMP flood throttled"',
    `curl -s -o /dev/null -w "%{http_code}\\n" "http://${HQ.wanVip.web}/" | grep -q 200 && echo "PASS: published site still served after the burst"`,
  ].join('\n'), '755');

  await bench.writeFile(pc, `${AUDIT_DIRECTORY}/run-all.sh`, [
    '#!/bin/bash',
    'for script in check-web-vip.sh check-mail-vip.sh check-out-of-scope.sh check-mgmt-exposure.sh; do',
    '  echo "== $script =="',
    `  bash "${AUDIT_DIRECTORY}/$script"`,
    'done',
  ].join('\n'), '755');
}

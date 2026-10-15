import type { CiscoRouter } from '@/network/devices/CiscoRouter';
import type { CertificateAuthority } from '@/network/pki/CertificateAuthority';
import { certToPem, pemToCsr } from '@/network/pki/pem';
import { simulationNowMs } from '@/network/core/SystemClock';
import { run } from './ezvpnClientLab';

type Plan = { steps: Array<{ kind: string; accept?: (line: string, all: string[]) => { done: boolean; body?: string }; run?: (rt: object) => Promise<void> }> };

export async function paste(router: CiscoRouter, line: string, text: string): Promise<string> {
  const shell = (router as unknown as { shell: { interactionPlanFor(l: string, ctx: object): Plan | null } }).shell;
  const plan = shell.interactionPlanFor(line, { mode: 'config', device: router });
  if (!plan) return 'NO-PLAN';
  const lines: string[] = [];
  let body = '';
  for (const entry of [...text.split('\n'), 'quit']) {
    const verdict = plan.steps[1].accept!(entry, lines);
    if (verdict.done) { body = verdict.body ?? ''; break; }
    lines.push(entry);
  }
  const printed: string[] = [];
  await plan.steps[2].run!({ values: new Map([['pasted_certificate', body]]), output: (t: string) => printed.push(t) });
  return printed.join('\n');
}

export async function manualEnroll(router: CiscoRouter, authority: CertificateAuthority, subject: string) {
  await run(router, ['crypto pki trustpoint TP', 'enrollment terminal', `subject-name ${subject}`, 'revocation-check none', 'exit']);
  const authenticated = await paste(router, 'crypto pki authenticate TP', certToPem(authority.rootCertificate));
  await router.executeCommand('enable');
  await router.executeCommand('configure terminal');
  const csrText = await router.executeCommand('crypto pki enroll TP');
  const request = pemToCsr(/-----BEGIN CERTIFICATE REQUEST-----[\s\S]*?-----END CERTIFICATE REQUEST-----/.exec(csrText)![0]);
  const issued = request ? authority.signRequest(request, { notBefore: simulationNowMs(), notAfter: simulationNowMs() + 86_400_000 }) : null;
  return { authenticated, csrText, issued };
}


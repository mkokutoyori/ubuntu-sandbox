import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

const CERTREQ_HELP = `Usage:
  CertReq -submit [Options] [RequestFileIn [CertFileOut [CertChainFileOut [FullResponseFileOut]]]]
    Submit a request to a Certification Authority.

Options:
  -template TemplateName    Certificate template to use for the request.
  -subject Subject          Subject name (e.g. "CN=host.domain.tld").
  -eku OID                  Requested Enhanced Key Usage.

  CertReq -?                Display this help.

This simplified build accepts the subject and template directly
(no PKCS#10 .req file parsing).`;

const CERTUTIL_HELP = `Usage:
  CertUtil -submit -template TemplateName -subject Subject [-eku OID]
    Submit a request to a Certification Authority.

  CertUtil -?                Display this help.

This simplified build accepts the subject and template directly
(no PKCS#10 .req file parsing).`;

interface ParsedSubmit {
  subject?: string;
  template?: string;
  eku?: string;
}

function parseSubmitArgs(args: string[]): ParsedSubmit {
  let subject: string | undefined;
  let template: string | undefined;
  let eku: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i].toLowerCase();
    if (a === '-subject' && args[i + 1]) { subject = args[++i]; continue; }
    if (a === '-template' && args[i + 1]) { template = args[++i]; continue; }
    if (a === '-eku' && args[i + 1]) { eku = args[++i]; continue; }
  }
  return { subject, template, eku };
}

/**
 * Logique partagée `certreq`/`certutil -submit` : le parsing et le formatage
 * sont portés ici ; la soumission à l'autorité et le stockage du certificat
 * émis sont la primitive device `machine.certificateServices` (absente tant
 * que le rôle AD CS n'est pas installé — d'où « RPC server is unavailable »
 * sur un poste, sans fonctionnalité serveur exposée).
 */
async function runSubmit(ctx: CommandContext, args: string[], usage: string): Promise<ExitCode> {
  if (args.some((a) => a === '-?' || a === '/?')) {
    await ctx.io.stdout.write(usage + '\n');
    return EXIT_OK;
  }
  if (args[0]?.toLowerCase() !== '-submit') {
    await ctx.io.stdout.write(usage + '\n');
    return 1;
  }

  const svc = ctx.machine.certificateServices;
  if (!svc) {
    await ctx.io.stdout.write('CertReq: The RPC server is unavailable. 0x800706ba (WIN32: 1722 RPC_S_SERVER_UNAVAILABLE)\n');
    return 1;
  }

  const { subject, template, eku } = parseSubmitArgs(args.slice(1));
  if (!subject || !template) {
    await ctx.io.stdout.write(usage + '\n');
    return 1;
  }

  const res = svc.submitRequest(subject, template, eku);
  if (!res.ok) {
    await ctx.io.stdout.write(res.message + '\n');
    return 1;
  }
  await ctx.io.stdout.write(
    `CertReq: Certificate Retrieved\nSerial Number: ${res.serialNumber}\nSubject: ${res.subject}\nIssuer: ${res.issuer}\n`,
  );
  return EXIT_OK;
}

/** `certreq -submit -template <name> -subject <CN=...>` (MS-WCCE, AD CS). */
export class CertreqCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'certreq',
    summary: 'Soumet une demande de certificat à une autorité AD CS',
    usage: CERTREQ_HELP,
    args: [{ name: 'targets', type: 'string', required: false, variadic: true, description: '-submit -template <modèle> -subject <sujet>' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'système',
    lenientOptions: true,
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const args = ctx.args.has('targets') ? ctx.args.get<string[]>('targets') : [];
    return runSubmit(ctx, args, CERTREQ_HELP);
  }
}

/** `certutil -submit …` — mêmes sémantiques que `certreq -submit` (Windows offre les deux outils). */
export class CertutilCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'certutil',
    summary: 'Soumet une demande de certificat à une autorité AD CS',
    usage: CERTUTIL_HELP,
    args: [{ name: 'targets', type: 'string', required: false, variadic: true, description: '-submit -template <modèle> -subject <sujet>' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'système',
    lenientOptions: true,
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const args = ctx.args.has('targets') ? ctx.args.get<string[]>('targets') : [];
    return runSubmit(ctx, args, CERTUTIL_HELP);
  }
}

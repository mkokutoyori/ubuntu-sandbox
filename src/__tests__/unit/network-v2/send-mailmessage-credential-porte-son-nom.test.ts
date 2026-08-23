/**
 * `Send-MailMessage -Credential` ne s'authentifiait jamais.
 *
 * Mesure : un serveur de SOUMISSION (port 587, qui exige AUTH avant
 * MAIL FROM) refuse l'envoi avec « Authentication required for mail
 * submission », alors que le script a bien construit son identifiant.
 * Deux defauts empiles, et NEUTRALISER L'UN OU L'AUTRE fait retomber le
 * cas — chacun est donc necessaire.
 *
 * (1) `New-Object System.Management.Automation.PSCredential(user, $sec)`
 * — la facon dont tout script NON interactif fabrique un identifiant —
 * ne rendait pas un identifiant. Le gestionnaire de `New-Object` posait
 * `{ UserName, Password: null }` : le mot de passe etait JETE et le
 * marqueur `PSTypeName` absent, si bien qu'`isPSCredential` repondait
 * non et que la cmdlet ignorait l'option en silence. Le seul producteur
 * d'un vrai `PSCredentialValue` etait `Get-Credential`, qui exige une
 * saisie. `New-Object` appelle desormais `makePSCredential`, le meme
 * constructeur, et lit le `SecureString` que rend `ConvertTo-SecureString`.
 *
 * (2) `$cred.GetNetworkCredential()` rend `{ userName, password }` — la
 * casse de PowerShell — et le contrat que la cmdlet traverse declare
 * `{ username, password }`, avec un `n` minuscule, que
 * `WindowsPC.sendMailMessage` lit pour appeler `authPlain`. Le nom
 * arrivait donc `undefined`. La conversion se fait a la FRONTIERE, la ou
 * les deux vocabulaires se rencontrent, plutot qu'en elargissant l'un
 * des deux : les deux casses sont reelles et chacune est juste chez elle.
 *
 * Le laboratoire a ete faux trois fois avant de mesurer quoi que ce soit,
 * et c'est ecrit ici plutot qu'efface : `submissionMode` se DEDUIT du
 * port 587 et non d'une option de configuration, et `onMessageAccepted`
 * est le QUATRIEME argument de `SmtpServer` et non un champ du second —
 * passe au mauvais endroit, il etait ignore, et « rien n'est arrive »
 * ressemblait alors a un refus correct.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { SmtpServer, SMTP_SUBMISSION_PORT } from '@/network/smtp/SmtpServer';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

beforeEach(() => { resetCounters(); resetDeviceCounters(); Logger.reset(); });

function labo() {
  const pc = new WindowsPC('windows-pc', 'PC1');
  const srv = new LinuxPC('linux-pc', 'MAIL1');
  pc.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
  srv.configureInterface('eth0', new IPAddress('10.0.1.10'), new SubnetMask('255.255.255.0'));
  new Cable('c1').connect(pc.getPort('eth0')!, srv.getPort('eth0')!);
  pc.powerOn();
  srv.powerOn();
  const recues: string[] = [];
  const server = new SmtpServer(
    srv.getTcpStack(),
    {
      hostname: 'mail.example.com',
      users: new Map([['alice', 'Wonderland1']]),
      allowPlainTextAuth: true,
    },
    SMTP_SUBMISSION_PORT,
    { onMessageAccepted: (m) => { recues.push(m.message.headers.get('Subject') ?? ''); } },
  );
  server.start();
  const ps = PowerShellSubShell.create(pc).subShell;
  return { ps, recues };
}

const run = async (ps: ReturnType<typeof labo>['ps'], line: string) =>
  (await ps.processLine(line)).output.join('\n');

const ENVOI = 'Send-MailMessage -From "a@example.com" -To "b@example.com"'
  + ' -Subject "Bonjour" -Body "Corps" -SmtpServer "10.0.1.10" -Port 587';

describe('Send-MailMessage : l identifiant porte son nom', () => {
  it('TEMOIN — sans identifiant, un serveur qui exige AUTH refuse', async () => {
    const { ps, recues } = labo();

    await run(ps, ENVOI);

    expect(recues).toHaveLength(0);
  });

  it('avec un identifiant valide, le message est accepte', async () => {
    const { ps, recues } = labo();
    await run(ps, '$sec = ConvertTo-SecureString "Wonderland1" -AsPlainText -Force');
    await run(ps, '$cred = New-Object System.Management.Automation.PSCredential("alice", $sec)');

    await run(ps, `${ENVOI} -Credential $cred`);

    expect(recues).toEqual(['Bonjour']);
  });

  it('un mauvais mot de passe est toujours refuse', async () => {
    const { ps, recues } = labo();
    await run(ps, '$sec = ConvertTo-SecureString "MauvaisMot" -AsPlainText -Force');
    await run(ps, '$cred = New-Object System.Management.Automation.PSCredential("alice", $sec)');

    await run(ps, `${ENVOI} -Credential $cred`);

    expect(recues).toHaveLength(0);
  });
});

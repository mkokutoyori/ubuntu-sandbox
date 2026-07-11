import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

export class SysteminfoCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'systeminfo',
    summary: "Affiche les informations système de l'équipement",
    usage: 'systeminfo',
    args: [],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'système',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const os = ctx.machine.os;
    const hw = ctx.machine.hardware;
    const lines: string[] = [];
    lines.push(`Host Name:                 ${ctx.machine.hostname}`);
    lines.push(`OS Name:                   ${os?.prettyName ?? 'Microsoft Windows'}`);
    lines.push(`OS Version:                ${os?.version ?? ''}`);
    lines.push('OS Manufacturer:           Microsoft Corporation');
    const memberRole = (os?.prettyName ?? '').includes('Server') ? 'Member Server' : 'Member Workstation';
    lines.push(`OS Configuration:          ${memberRole}`);
    lines.push('OS Build Type:             Multiprocessor Free');

    const bootedAt = ctx.machine.bootedAt?.() ?? null;
    if (bootedAt) {
      lines.push(`System Boot Time:          ${bootedAt.toLocaleString('en-US')}`);
    }

    if (hw) {
      lines.push(`System Manufacturer:       ${hw.manufacturer}`);
      lines.push(`System Model:              ${hw.productName}`);
      lines.push('System Type:               x64-based PC');
      const mb = (kib: number): string => `${Math.round(kib / 1024).toLocaleString('en-US')} MB`;
      lines.push(`Processor(s):              ${hw.cpu.sockets} Processor(s) Installed.`);
      lines.push(
        `                           [01]: Intel64 Family ${hw.cpu.cpuFamily} ` +
        `Model ${hw.cpu.model} Stepping ${hw.cpu.stepping} ${hw.cpu.vendor} ` +
        `~${hw.cpu.clockMhz} Mhz`,
      );
      lines.push(`BIOS Version:              ${hw.firmware.vendor} ${hw.firmware.version}, ${hw.firmware.releaseDate}`);
      lines.push(`Total Physical Memory:     ${mb(hw.memory.totalKib)}`);
      lines.push(`Available Physical Memory: ${mb(hw.memory.availableKib)}`);
      lines.push(`Virtual Memory: Max Size:  ${mb(hw.memory.totalKib + hw.memory.swapTotalKib)}`);
    }

    const interfaces = await ctx.machine.net.interfaces();
    lines.push(`Network Card(s):           ${interfaces.length} NIC(s) Installed.`);
    interfaces.forEach((iface, i) => {
      const displayName = iface.name.replace(/^eth/, 'Ethernet ');
      lines.push(`                           [${String(i + 1).padStart(2, '0')}]: Intel(R) Ethernet Connection`);
      if (iface.ip) {
        lines.push(`                                 Connection Name: ${displayName}`);
        lines.push(`                                 DHCP Enabled:    ${iface.dhcp ? 'Yes' : 'No'}`);
        lines.push('                                 IP address(es)');
        lines.push(`                                 [01]: ${iface.ip}`);
      } else {
        lines.push(`                                 Connection Name: ${displayName}`);
        lines.push('                                 Status:          Media disconnected');
      }
    });

    await ctx.io.stdout.write(lines.join('\n') + '\n');
    return EXIT_OK;
  }
}

export interface KernelBootFacts {
  procVersion: string;
  kernelRelease: string;
  cpuModel: string;
  cpuFamily: number;
  cpuModelId: number;
  cpuStepping: number;
  memTotalKib: number;
  installedKib: number;
  dmiVendor: string;
  dmiProduct: string;
  biosVersion: string;
  biosDate: string;
  rootPartition: string;
  rootFsType: string;
  adapters: ReadonlyArray<{ name: string; driver: string; busInfo: string }>;
}

export interface KernelBootMessage {
  offset: number;
  level: number;
  msg: string;
}

const KERNEL_IMAGE_KIB = {
  code: 14339,
  rwdata: 5992,
  rodata: 8384,
  init: 3168,
  bss: 796,
} as const;

export function kernelCommandLine(release: string, rootPartition: string): string {
  return `BOOT_IMAGE=/vmlinuz-${release} root=/dev/${rootPartition} ro quiet splash`;
}

function hex(n: number): string {
  return `0x${n.toString(16)}`;
}

function memoryLine(facts: KernelBootFacts): string {
  const image = Object.values(KERNEL_IMAGE_KIB).reduce((a, b) => a + b, 0);
  const available = Math.max(0, facts.memTotalKib - image);
  const installed = Math.max(facts.installedKib, facts.memTotalKib);
  const reserved = installed - facts.memTotalKib;
  const k = KERNEL_IMAGE_KIB;
  return `Memory: ${available}K/${installed}K available `
    + `(${k.code}K kernel code, ${k.rwdata}K rwdata, ${k.rodata}K rodata, `
    + `${k.init}K init, ${k.bss}K bss, ${reserved}K reserved, 0K cma-reserved)`;
}

export function kernelBootMessages(facts: KernelBootFacts): KernelBootMessage[] {
  const messages: KernelBootMessage[] = [
    { offset: 0, level: 5, msg: facts.procVersion },
    { offset: 0, level: 6, msg: `Command line: ${kernelCommandLine(facts.kernelRelease, facts.rootPartition)}` },
    { offset: 0.010000, level: 6, msg: `DMI: ${facts.dmiVendor} ${facts.dmiProduct}, BIOS ${facts.biosVersion} ${facts.biosDate}` },
    { offset: 0.050000, level: 6, msg: memoryLine(facts) },
    { offset: 0.100000, level: 6, msg: 'PCI: Using configuration type 1 for base access' },
    { offset: 0.110000, level: 6, msg: 'pci 0000:00:01.0: PIIX/ICH IDE controller' },
    {
      offset: 0.200000, level: 6,
      msg: `smpboot: CPU0: ${facts.cpuModel} (family: ${hex(facts.cpuFamily)}, `
        + `model: ${hex(facts.cpuModelId)}, stepping: ${hex(facts.cpuStepping)})`,
    },
    { offset: 0.300000, level: 6, msg: 'NET: Registered PF_INET protocol family' },
    { offset: 0.310000, level: 6, msg: 'NET: Registered PF_INET6 protocol family' },
    { offset: 0.400000, level: 6, msg: 'usbcore: registered new interface driver usbfs' },
    { offset: 0.410000, level: 6, msg: 'usbcore: registered new interface driver hub' },
  ];

  const drivers = new Set(facts.adapters.map((a) => a.driver));
  let offset = 0.500000;
  for (const driver of drivers) {
    messages.push({ offset, level: 6, msg: `${driver}: Intel(R) PRO/1000 Network Driver` });
    offset += 0.001;
  }
  for (const nic of facts.adapters) {
    messages.push({
      offset, level: 6,
      msg: `${nic.driver} ${nic.busInfo} ${nic.name}: (PCI:33MHz:32-bit) link up`,
    });
    offset += 0.001;
  }

  messages.push(
    {
      offset: 1.000000, level: 6,
      msg: `${facts.rootFsType.toUpperCase()}-fs (${facts.rootPartition}): mounted filesystem with ordered data mode. Opts: (null)`,
    },
    {
      offset: 1.200000, level: 6,
      msg: `${facts.rootFsType.toUpperCase()}-fs (${facts.rootPartition}): re-mounted. Opts: errors=remount-ro`,
    },
  );

  return messages.sort((a, b) => a.offset - b.offset);
}

export function defaultKernelBootFacts(): KernelBootFacts {
  return {
    procVersion: 'Linux version 5.15.0-130-generic (buildd@lcy02-amd64-001) '
      + '(gcc (Ubuntu 11.4.0-1ubuntu1~22.04) 11.4.0, GNU ld (GNU Binutils for Ubuntu) 2.38) '
      + '#140-Ubuntu SMP Wed Apr 16 12:00:00 UTC 2025',
    kernelRelease: '5.15.0-130-generic',
    cpuModel: 'Intel(R) Xeon(R) CPU E5-2686 v4 @ 2.30GHz',
    cpuFamily: 6,
    cpuModelId: 79,
    cpuStepping: 1,
    memTotalKib: 3981312,
    installedKib: 4194304,
    dmiVendor: 'QEMU',
    dmiProduct: 'Standard PC (i440FX + PIIX, 1996)',
    biosVersion: '1.16.0-1',
    biosDate: '04/01/2014',
    rootPartition: 'sda1',
    rootFsType: 'ext4',
    adapters: [{ name: 'eth0', driver: 'e1000', busInfo: '0000:00:03.0' }],
  };
}

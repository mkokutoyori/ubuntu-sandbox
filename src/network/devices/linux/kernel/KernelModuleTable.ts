/**
 * Les modules du noyau — ce que `lsmod` liste et `modinfo` décrit.
 *
 * Il n'existait aucune notion de module dans le simulateur, et c'est ce
 * qui rendait `lsmod` impossible à écrire honnêtement : une liste en dur
 * ne décrirait aucun état, et aucun `modprobe` ne pourrait la changer.
 * Cette table est donc un vrai petit modèle plutôt qu'un texte figé —
 * elle a une source, elle se charge et se décharge, et le compteur
 * d'utilisation reflète les dépendances déclarées.
 *
 * La table de départ est **dérivée du matériel de la machine**, pas
 * inventée : le pilote réseau vient du modèle de la carte, `ext4` du
 * système de fichiers monté. Un module qu'aucun matériel ne justifie n'a
 * rien à faire dans un `lsmod`, et en mettre un serait exactement la
 * fausseté qu'on cherche à éviter.
 *
 * Ce qui n'est PAS modélisé : le module ne *fait* rien. Décharger `ext4`
 * ne démonte aucun système de fichiers, et charger un module absent de la
 * table échoue — il n'existe pas d'arbre `/lib/modules` peuplé derrière.
 * `rmmod` refuse d'ailleurs un module dont le compteur d'utilisation
 * n'est pas nul, ce qui est la seule règle de dépendance réellement
 * appliquée ici, et c'est celle qui se voit.
 */

export interface KernelModule {
  name: string;
  /** Taille en octets, comme la 2ᵉ colonne de `lsmod`. */
  size: number;
  /** Modules qui dépendent de celui-ci — la 4ᵉ colonne de `lsmod`. */
  usedBy: string[];
  description: string;
  license: string;
  author?: string;
  /** Modules dont celui-ci dépend (`depends:` de `modinfo`). */
  depends: string[];
  /** Chemin dans `/lib/modules/<release>/kernel/...`. */
  path: string;
  /** `modinfo` n'affiche `parm:` que pour les modules qui en ont. */
  parms?: string[];
}

interface ModuleSeed {
  name: string;
  size: number;
  description: string;
  license: string;
  author?: string;
  depends?: string[];
  path: string;
  parms?: string[];
}

/**
 * Le socle commun à toute machine simulée : la pile de fichiers, le
 * chiffrement de disque et les modules utilitaires qu'Ubuntu charge au
 * démarrage. Rien de spécifique au matériel ici.
 */
const BASE_MODULES: readonly ModuleSeed[] = [
  {
    name: 'ext4', size: 970752, license: 'GPL',
    description: 'Fourth Extended Filesystem',
    author: 'Remy Card, Stephen Tweedie, Andrew Morton, Andreas Dilger, Theodore Ts\'o and others',
    depends: ['mbcache', 'jbd2', 'crc32c_generic'],
    path: 'kernel/fs/ext4/ext4.ko',
  },
  {
    name: 'jbd2', size: 143360, license: 'GPL',
    description: 'Generic filesystem journal-writing module',
    depends: ['crc32c_generic'],
    path: 'kernel/fs/jbd2/jbd2.ko',
  },
  { name: 'mbcache', size: 16384, license: 'GPL', description: 'Meta block cache (for extended attributes)', path: 'kernel/fs/mbcache.ko' },
  { name: 'crc32c_generic', size: 12288, license: 'GPL', description: 'CRC32c (Castagnoli) calculations wrapper for lib/crc32c', path: 'kernel/crypto/crc32c_generic.ko' },
  {
    name: 'dm_mod', size: 188416, license: 'GPL',
    description: 'device-mapper driver',
    author: 'Joe Thornber <dm-devel@redhat.com>',
    path: 'kernel/drivers/md/dm-mod.ko',
    parms: ['major:The major number of the device mapper (uint)'],
  },
  {
    name: 'overlay', size: 176128, license: 'GPL',
    description: 'Overlay filesystem',
    author: 'Miklos Szeredi <miklos@szeredi.hu>',
    path: 'kernel/fs/overlayfs/overlay.ko',
  },
  {
    name: 'br_netfilter', size: 32768, license: 'GPL',
    description: 'Linux ethernet netfilter firewall bridge',
    depends: ['bridge'],
    path: 'kernel/net/bridge/br_netfilter.ko',
  },
  {
    name: 'bridge', size: 311296, license: 'GPL',
    description: 'Ethernet bridge driver',
    depends: ['stp', 'llc'],
    path: 'kernel/net/bridge/bridge.ko',
  },
  { name: 'stp', size: 12288, license: 'GPL', description: '802.1d Ethernet Spanning Tree Protocol', depends: ['llc'], path: 'kernel/net/802/stp.ko' },
  { name: 'llc', size: 16384, license: 'GPL', description: 'LLC layer 2 (802.2) driver', path: 'kernel/net/llc/llc.ko' },
  {
    name: '8021q', size: 40960, license: 'GPL',
    description: '802.1Q/802.1ad VLAN Layer 8/802.1Q support',
    author: 'Ben Greear <greearb@candelatech.com>',
    depends: ['garp', 'mrp'],
    path: 'kernel/net/8021q/8021q.ko',
  },
  { name: 'garp', size: 20480, license: 'GPL', description: 'GARP Applicant', depends: ['stp'], path: 'kernel/net/802/garp.ko' },
  { name: 'mrp', size: 20480, license: 'GPL', description: 'MRP Applicant', path: 'kernel/net/802/mrp.ko' },
  {
    name: 'nf_conntrack', size: 176128, license: 'GPL',
    description: 'Netfilter connection tracking',
    path: 'kernel/net/netfilter/nf_conntrack.ko',
    parms: ['tstamp:Enable connection tracking flow timestamping. (bool)', 'acct:Enable connection tracking flow accounting. (bool)'],
  },
  {
    name: 'ip_tables', size: 32768, license: 'GPL',
    description: 'IPv4 packet filter',
    depends: ['x_tables'],
    path: 'kernel/net/ipv4/netfilter/ip_tables.ko',
  },
  { name: 'x_tables', size: 65536, license: 'GPL', description: '{ip,ip6,arp,eb}_tables backend module', path: 'kernel/net/netfilter/x_tables.ko' },
];

/**
 * Le pilote de la carte réseau. Le nom vient du modèle décrit par
 * `NetworkAdapter`, comme `lspci -k` le rapporte déjà — les deux vues
 * doivent nommer le même pilote.
 */
/**
 * Les modules que cette image peut REELLEMENT charger.
 *
 * La table decrit ce que la machine sait faire, pas un catalogue de
 * noms : `dummy` y figure parce que `ip link add … type dummy` cree une
 * vraie interface derriere, et il y figure seul pour cette raison. Un
 * `modprobe` d'autre chose echoue comme sur une machine dont
 * `/lib/modules` ne contient pas le fichier — ce qui est litteralement
 * le cas ici.
 */
const CHARGEABLES: readonly ModuleSeed[] = [
  {
    name: 'bonding', size: 200704, license: 'GPL',
    description: 'Ethernet Channel Bonding Driver',
    author: 'Thomas Davis, tadavis@lbl.gov and many others',
    path: 'kernel/drivers/net/bonding/bonding.ko',
    parms: [
      'max_bonds:Max number of bonded devices (int)',
      'mode:Mode of operation; 0 for balance-rr, 1 for active-backup, 2 for balance-xor, 3 for broadcast, 4 for 802.3ad, 5 for balance-tlb, 6 for balance-alb (charp)',
      'miimon:Link check interval in milliseconds (int)',
      'lacp_rate:LACPDU tx rate to request from 802.3ad partner; 0 for slow, 1 for fast (charp)',
      'xmit_hash_policy:balance-alb, balance-tlb, balance-xor, 802.3ad hashing method (charp)',
    ],
  },
  {
    name: 'dummy', size: 12288, license: 'GPL',
    description: 'Dummy network driver',
    author: 'Nick Holloway <alfie@dcs.warwick.ac.uk>',
    path: 'kernel/drivers/net/dummy.ko',
    parms: ['numdummies:Number of dummy pseudo devices (int)'],
  },
];

function nicModule(driver: string): ModuleSeed {
  const descriptions: Record<string, string> = {
    e1000: 'Intel(R) PRO/1000 Network Driver',
    e1000e: 'Intel(R) PRO/1000 Network Driver',
    igb: 'Intel(R) Gigabit Ethernet Network Driver',
    ixgbe: 'Intel(R) 10GbE PCI Express Network Driver',
    virtio_net: 'Virtio network driver',
    r8169: 'RealTek RTL-8169 Gigabit Ethernet driver',
    tg3: 'Broadcom Tigon3 ethernet driver',
  };
  return {
    name: driver,
    size: 262144,
    license: 'GPL',
    description: descriptions[driver] ?? `${driver} network driver`,
    author: 'Intel Corporation, <linux.nics@intel.com>',
    path: `kernel/drivers/net/ethernet/${driver}.ko`,
    parms: ['debug:Debug level (0=none,...,16=all) (int)'],
  };
}

export class KernelModuleTable {
  private readonly modules = new Map<string, KernelModule>();

  /** `driver` est le pilote de la carte réseau de la machine. */
  constructor(driver = 'e1000', private readonly release = '5.15.0-91-generic') {
    for (const seed of [...BASE_MODULES, nicModule(driver)]) this.insert(seed);
    this.recomputeUsedBy();
  }

  private insert(seed: ModuleSeed): void {
    this.modules.set(seed.name, {
      name: seed.name,
      size: seed.size,
      usedBy: [],
      description: seed.description,
      license: seed.license,
      author: seed.author,
      depends: seed.depends ?? [],
      path: seed.path,
      parms: seed.parms,
    });
  }

  /**
   * La 3ᵉ colonne de `lsmod` (« Used by ») est l'inverse des dépendances
   * déclarées, pas une donnée à part : la dériver garantit qu'elle ne
   * peut pas contredire la colonne suivante.
   */
  private recomputeUsedBy(): void {
    for (const m of this.modules.values()) m.usedBy = [];
    for (const m of this.modules.values()) {
      for (const dep of m.depends) {
        this.modules.get(dep)?.usedBy.push(m.name);
      }
    }
    for (const m of this.modules.values()) m.usedBy.sort();
  }

  list(): KernelModule[] {
    return [...this.modules.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): KernelModule | undefined {
    return this.modules.get(name.replace(/-/g, '_'));
  }

  has(name: string): boolean {
    return this.get(name) !== undefined;
  }

  /**
   * `modinfo` lit `/lib/modules`, pas la liste des modules CHARGES : un
   * module que l'image porte se decrit sans `modprobe` prealable.
   */
  describe(name: string): KernelModule | undefined {
    const canonique = name.replace(/-/g, '_');
    const charge = this.get(name);
    if (charge) return charge;
    const seed = CHARGEABLES.find((m) => m.name === canonique);
    return seed ? { ...seed, depends: seed.depends ?? [], usedBy: [] } : undefined;
  }

  /** `/lib/modules/<release>/<path>` — ce que `modinfo` met en `filename:`. */
  filenameOf(m: KernelModule): string {
    return `/lib/modules/${this.release}/${m.path}`;
  }

  /**
   * `modprobe` : charge un module que cette image porte vraiment.
   *
   * Charger un module deja charge est un succes silencieux, comme sur
   * une vraie machine — c'est ce qui rend `modprobe` idempotent et donc
   * utilisable dans un script de demarrage.
   */
  load(name: string): { ok: boolean; error?: string } {
    const canonique = name.replace(/-/g, '_');
    if (this.modules.has(canonique)) return { ok: true };
    const seed = CHARGEABLES.find((m) => m.name === canonique);
    if (!seed) {
      return {
        ok: false,
        error: `modprobe: FATAL: Module ${name} not found in directory /lib/modules/${this.release}`,
      };
    }
    this.insert(seed);
    this.recomputeUsedBy();
    return { ok: true };
  }

  /**
   * `rmmod` : refuse tant qu'un autre module s'en sert, comme le vrai
   * noyau — c'est la seule contrainte de dépendance réellement appliquée,
   * et c'est celle qui se voit.
   */
  remove(name: string): { ok: boolean; error?: string } {
    const m = this.get(name);
    if (!m) return { ok: false, error: `rmmod: ERROR: Module ${name} is not currently loaded` };
    if (m.usedBy.length > 0) {
      return { ok: false, error: `rmmod: ERROR: Module ${m.name} is in use by: ${m.usedBy.join(' ')}` };
    }
    this.modules.delete(m.name);
    this.recomputeUsedBy();
    return { ok: true };
  }

  /** Le contenu de `/proc/modules`, dont `lsmod` n'est qu'une mise en forme. */
  toProcModules(): string {
    return this.list().map((m) => {
      const used = m.usedBy.length > 0 ? m.usedBy.join(',') : '-';
      return `${m.name} ${m.size} ${m.usedBy.length} ${used}, Live 0x0000000000000000`;
    }).join('\n') + '\n';
  }
}

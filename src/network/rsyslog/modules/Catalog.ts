import type { ModuleCatalog } from '../engine/Loader';
import type { EngineModule, ParserModuleDefinition } from '../engine/Modules';
import { imklog } from './Imklog';
import { imtcp } from './Imtcp';
import { immark } from './Immark';
import { impstats } from './Impstats';
import { imuxsock } from './Imuxsock';
import { imudp } from './Imudp';
import { omdiscard } from './Omdiscard';
import { omfile } from './Omfile';
import { omfwd } from './Omfwd';
import { omusrmsg } from './Omusrmsg';

const PARSER_MODULES: readonly ParserModuleDefinition[] = [
  { kind: 'parser', name: 'pmrfc3164', cnfName: 'rsyslog.rfc3164', builtin: true },
  { kind: 'parser', name: 'pmrfc5424', cnfName: 'rsyslog.rfc5424', builtin: true },
];

export class BuiltinModuleCatalog implements ModuleCatalog {
  private readonly modules = new Map<string, EngineModule>();

  constructor(
    private readonly directory: string,
    private readonly fileExistsAt: (path: string) => boolean,
    additional: readonly EngineModule[] = [],
  ) {
    for (const module of [omfile, omfwd, omusrmsg, omdiscard, imudp, imtcp, imuxsock, imklog, immark, impstats, ...PARSER_MODULES, ...additional]) this.modules.set(module.name, module);
  }

  find(cnfName: string): EngineModule | undefined {
    return this.modules.get(cnfName);
  }

  moduleDirectory(): string {
    return this.directory;
  }

  fileExists(name: string): boolean {
    return this.fileExistsAt(name.startsWith('/') ? name : `${this.directory.replace(/\/?$/, '/')}${name}`);
  }
}

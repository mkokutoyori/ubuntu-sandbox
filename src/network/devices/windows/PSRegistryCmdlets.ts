import { PSRegistryProvider, isRegistryPath } from './PSRegistryProvider';

export interface PSRegistryContext {
  registry: PSRegistryProvider;
}

export function psGetItemProperty(ctx: PSRegistryContext, args: string[]): string {
  let path = '', name = '';
  for (let i = 0; i < args.length; i++) {
    const al = args[i].toLowerCase();
    if ((al === '-path' || al === '-literalpath') && args[i + 1]) { path = args[++i].replace(/^["']|["']$/g, ''); }
    else if (al === '-name' && args[i + 1]) { name = args[++i].replace(/^["']|["']$/g, ''); }
    else if (!args[i].startsWith('-') && !path) { path = args[i].replace(/^["']|["']$/g, ''); }
    else if (!args[i].startsWith('-') && path && !name) { name = args[i].replace(/^["']|["']$/g, ''); }
  }
  if (!path) return "Get-ItemProperty : Cannot bind argument to parameter 'Path' because it is an empty string.";
  if (!isRegistryPath(path)) return `Get-ItemProperty : Cannot find path '${path}' because it does not exist.`;
  return ctx.registry.getItemProperty(path, name || undefined);
}

export function psSetItemProperty(ctx: PSRegistryContext, args: string[]): string {
  let path = '', name = '', value: string | number = '';
  for (let i = 0; i < args.length; i++) {
    const al = args[i].toLowerCase();
    if ((al === '-path' || al === '-literalpath') && args[i + 1]) { path = args[++i].replace(/^["']|["']$/g, ''); }
    else if (al === '-name' && args[i + 1]) { name = args[++i].replace(/^["']|["']$/g, ''); }
    else if (al === '-value' && args[i + 1]) {
      const raw = args[++i].replace(/^["']|["']$/g, '');
      value = /^-?\d+$/.test(raw) ? Number(raw) : raw;
    }
  }
  if (!path) return "Set-ItemProperty : Cannot bind argument to parameter 'Path' because it is an empty string.";
  if (!isRegistryPath(path)) return `Set-ItemProperty : Cannot find path '${path}' because it does not exist.`;
  return ctx.registry.setItemProperty(path, name, value);
}

export function psRemoveItemProperty(ctx: PSRegistryContext, args: string[]): string {
  let path = '', name = '';
  for (let i = 0; i < args.length; i++) {
    const a = args[i].toLowerCase();
    if (a === '-path' && args[i + 1]) { path = args[++i].replace(/^["']|["']$/g, ''); }
    else if (a === '-name' && args[i + 1]) { name = args[++i].replace(/^["']|["']$/g, ''); }
  }
  if (!path) return "Remove-ItemProperty : Cannot bind argument to parameter 'Path' because it is an empty string.";
  if (!isRegistryPath(path)) return `Remove-ItemProperty : Cannot find path '${path}' because it does not exist.`;
  return ctx.registry.removeItemProperty(path, name);
}

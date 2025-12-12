/**
 * PowerShell Cmdlets Implementation
 */

import {
  PSValue, psString, psInt, psFloat, psBool, psNull, psArray, psHashtable, psDateTime,
  psValueToString, WindowsFileNode
} from '../types';
import { PSContext } from './interpreter';

interface CmdletResult {
  objects: PSValue[];
  exitCode: number;
  newPath?: string;
}

interface ParsedArgs {
  positional: PSValue[];
  named: Map<string, PSValue>;
}

type CmdletFunction = (args: ParsedArgs, context: PSContext, pipelineInput: PSValue[]) => CmdletResult;

const cmdlets: Map<string, CmdletFunction> = new Map();

// Register cmdlet
function registerCmdlet(name: string, fn: CmdletFunction): void {
  cmdlets.set(name.toLowerCase(), fn);
}

// Execute cmdlet
export function executeCmdlet(
  name: string,
  args: ParsedArgs,
  context: PSContext,
  pipelineInput: PSValue[]
): CmdletResult {
  const cmdlet = cmdlets.get(name.toLowerCase());
  if (!cmdlet) {
    return {
      objects: [psString(`${name}: The term '${name}' is not recognized as a cmdlet, function, script file, or operable program.`)],
      exitCode: 1,
    };
  }

  return cmdlet(args, context, pipelineInput);
}

// Helper to create file object
function createFileObject(node: WindowsFileNode, path: string): PSValue {
  const props = new Map<string, PSValue>();
  props.set('Name', psString(node.name));
  props.set('FullName', psString(path));
  props.set('Length', psInt(node.size));
  props.set('LastWriteTime', psDateTime(node.modified));
  props.set('CreationTime', psDateTime(node.created));
  props.set('LastAccessTime', psDateTime(node.accessed));
  props.set('Mode', psString(
    (node.type === 'directory' ? 'd' : '-') +
    (node.attributes.archive ? 'a' : '-') +
    (node.attributes.readonly ? 'r' : '-') +
    (node.attributes.hidden ? 'h' : '-') +
    (node.attributes.system ? 's' : '-')
  ));
  props.set('PSIsContainer', psBool(node.type === 'directory'));

  return {
    type: 'psobject',
    typeName: node.type === 'directory' ? 'System.IO.DirectoryInfo' : 'System.IO.FileInfo',
    properties: props,
    methods: new Map(),
  };
}

// ==================== File System Cmdlets ====================

registerCmdlet('Get-ChildItem', (args, context, input) => {
  const path = args.positional[0]
    ? psValueToString(args.positional[0])
    : context.state.currentPath;

  const recurse = args.named.get('recurse') || args.named.get('r');
  const force = args.named.get('force');
  const file = args.named.get('file');
  const directory = args.named.get('directory');
  const name = args.named.get('name');

  const fullPath = context.fs.resolvePath(path, context.state.currentPath);
  const node = context.fs.getNode(fullPath);

  if (!node) {
    return { objects: [psString(`Get-ChildItem: Cannot find path '${path}' because it does not exist.`)], exitCode: 1 };
  }

  if (node.type !== 'directory') {
    return { objects: [createFileObject(node, fullPath)], exitCode: 0 };
  }

  const objects: PSValue[] = [];

  function listDir(dirNode: WindowsFileNode, dirPath: string): void {
    if (!dirNode.children) return;

    dirNode.children.forEach((child, childName) => {
      // Skip hidden unless -Force
      if (child.attributes.hidden && !force) return;

      // Filter by type
      if (file && child.type !== 'file') return;
      if (directory && child.type !== 'directory') return;

      const childPath = dirPath.endsWith('\\') ? dirPath + childName : dirPath + '\\' + childName;

      if (name) {
        objects.push(psString(childName));
      } else {
        objects.push(createFileObject(child, childPath));
      }

      if (recurse && child.type === 'directory') {
        listDir(child, childPath);
      }
    });
  }

  listDir(node, fullPath);

  return { objects, exitCode: 0 };
});

registerCmdlet('Get-Location', (args, context, input) => {
  const pathObj: PSValue = {
    type: 'psobject',
    typeName: 'System.Management.Automation.PathInfo',
    properties: new Map([
      ['Path', psString(context.state.currentPath)],
      ['Drive', psString(context.state.currentPath.substring(0, 2))],
      ['Provider', psString('Microsoft.PowerShell.Core\\FileSystem')],
    ]),
    methods: new Map(),
  };
  return { objects: [pathObj], exitCode: 0 };
});

registerCmdlet('Set-Location', (args, context, input) => {
  const path = args.positional[0]
    ? psValueToString(args.positional[0])
    : args.named.get('path')
      ? psValueToString(args.named.get('path')!)
      : context.env.USERPROFILE || 'C:\\Users\\User';

  const fullPath = context.fs.resolvePath(path, context.state.currentPath);
  const node = context.fs.getNode(fullPath);

  if (!node) {
    return {
      objects: [psString(`Set-Location: Cannot find path '${path}' because it does not exist.`)],
      exitCode: 1,
    };
  }

  if (node.type !== 'directory') {
    return {
      objects: [psString(`Set-Location: A positional parameter cannot be found that accepts argument '${path}'.`)],
      exitCode: 1,
    };
  }

  context.variables.set('PWD', psString(fullPath));
  return { objects: [], exitCode: 0, newPath: fullPath };
});

registerCmdlet('Get-Content', (args, context, input) => {
  const path = args.positional[0] ? psValueToString(args.positional[0]) : null;

  if (!path) {
    return { objects: [psString('Get-Content: Cannot process argument because the value of argument "path" is null.')], exitCode: 1 };
  }

  const fullPath = context.fs.resolvePath(path, context.state.currentPath);
  const node = context.fs.getNode(fullPath);

  if (!node) {
    return { objects: [psString(`Get-Content: Cannot find path '${path}' because it does not exist.`)], exitCode: 1 };
  }

  if (node.type === 'directory') {
    return { objects: [psString('Get-Content: Access to the path is denied.')], exitCode: 1 };
  }

  const lines = (node.content || '').split(/\r?\n/).map(line => psString(line));
  return { objects: lines, exitCode: 0 };
});

registerCmdlet('Set-Content', (args, context, input) => {
  const path = args.positional[0] ? psValueToString(args.positional[0]) : null;
  const value = args.named.get('value') || (args.positional.length > 1 ? args.positional[1] : null);

  if (!path) {
    return { objects: [psString('Set-Content: Cannot process argument because the value of argument "path" is null.')], exitCode: 1 };
  }

  const content = value ? psValueToString(value) : input.map(v => psValueToString(v)).join('\r\n');
  const fullPath = context.fs.resolvePath(path, context.state.currentPath);

  if (context.fs.exists(fullPath)) {
    context.fs.updateFile(fullPath, content);
  } else {
    context.fs.createNode(fullPath, 'file', content);
  }

  return { objects: [], exitCode: 0 };
});

registerCmdlet('Add-Content', (args, context, input) => {
  const path = args.positional[0] ? psValueToString(args.positional[0]) : null;
  const value = args.named.get('value') || (args.positional.length > 1 ? args.positional[1] : null);

  if (!path) {
    return { objects: [psString('Add-Content: Cannot process argument because the value of argument "path" is null.')], exitCode: 1 };
  }

  const newContent = value ? psValueToString(value) : input.map(v => psValueToString(v)).join('\r\n');
  const fullPath = context.fs.resolvePath(path, context.state.currentPath);
  const node = context.fs.getNode(fullPath);

  if (node) {
    context.fs.updateFile(fullPath, (node.content || '') + '\r\n' + newContent);
  } else {
    context.fs.createNode(fullPath, 'file', newContent);
  }

  return { objects: [], exitCode: 0 };
});

registerCmdlet('New-Item', (args, context, input) => {
  const path = args.positional[0] ? psValueToString(args.positional[0]) : null;
  const itemType = args.named.get('itemtype') || args.named.get('type');
  const value = args.named.get('value');

  if (!path) {
    return { objects: [psString('New-Item: Cannot process argument because the value of argument "path" is null.')], exitCode: 1 };
  }

  const fullPath = context.fs.resolvePath(path, context.state.currentPath);
  const isDir = itemType && psValueToString(itemType).toLowerCase() === 'directory';

  if (context.fs.exists(fullPath)) {
    return { objects: [psString(`New-Item: An item with the specified name '${path}' already exists.`)], exitCode: 1 };
  }

  if (isDir) {
    context.fs.createNode(fullPath, 'directory');
  } else {
    const content = value ? psValueToString(value) : '';
    context.fs.createNode(fullPath, 'file', content);
  }

  const node = context.fs.getNode(fullPath)!;
  return { objects: [createFileObject(node, fullPath)], exitCode: 0 };
});

registerCmdlet('Remove-Item', (args, context, input) => {
  const paths = args.positional.map(p => psValueToString(p));
  const recurse = args.named.get('recurse') || args.named.get('r');
  const force = args.named.get('force');

  if (paths.length === 0) {
    return { objects: [psString('Remove-Item: Cannot process argument because the value of argument "path" is null.')], exitCode: 1 };
  }

  for (const path of paths) {
    const fullPath = context.fs.resolvePath(path, context.state.currentPath);
    const node = context.fs.getNode(fullPath);

    if (!node) {
      return { objects: [psString(`Remove-Item: Cannot find path '${path}' because it does not exist.`)], exitCode: 1 };
    }

    if (node.type === 'directory' && node.children && node.children.size > 0 && !recurse) {
      return { objects: [psString(`Remove-Item: The item at '${path}' has children and the Recurse parameter was not specified.`)], exitCode: 1 };
    }

    const success = context.fs.deleteNode(fullPath, !!recurse);
    if (!success) {
      return { objects: [psString(`Remove-Item: Cannot remove item '${path}'.`)], exitCode: 1 };
    }
  }

  return { objects: [], exitCode: 0 };
});

registerCmdlet('Copy-Item', (args, context, input) => {
  const source = args.positional[0] ? psValueToString(args.positional[0]) : null;
  const dest = args.positional[1] ? psValueToString(args.positional[1]) : null;

  if (!source || !dest) {
    return { objects: [psString('Copy-Item: Missing required arguments.')], exitCode: 1 };
  }

  const srcPath = context.fs.resolvePath(source, context.state.currentPath);
  let destPath = context.fs.resolvePath(dest, context.state.currentPath);

  const destNode = context.fs.getNode(destPath);
  if (destNode && destNode.type === 'directory') {
    const srcNode = context.fs.getNode(srcPath);
    if (srcNode) {
      destPath = destPath + '\\' + srcNode.name;
    }
  }

  const success = context.fs.copyNode(srcPath, destPath);
  if (!success) {
    return { objects: [psString(`Copy-Item: Cannot copy item '${source}'.`)], exitCode: 1 };
  }

  return { objects: [], exitCode: 0 };
});

registerCmdlet('Move-Item', (args, context, input) => {
  const source = args.positional[0] ? psValueToString(args.positional[0]) : null;
  const dest = args.positional[1] ? psValueToString(args.positional[1]) : null;

  if (!source || !dest) {
    return { objects: [psString('Move-Item: Missing required arguments.')], exitCode: 1 };
  }

  const srcPath = context.fs.resolvePath(source, context.state.currentPath);
  let destPath = context.fs.resolvePath(dest, context.state.currentPath);

  const destNode = context.fs.getNode(destPath);
  if (destNode && destNode.type === 'directory') {
    const srcNode = context.fs.getNode(srcPath);
    if (srcNode) {
      destPath = destPath + '\\' + srcNode.name;
    }
  }

  const success = context.fs.moveNode(srcPath, destPath);
  if (!success) {
    return { objects: [psString(`Move-Item: Cannot move item '${source}'.`)], exitCode: 1 };
  }

  return { objects: [], exitCode: 0 };
});

registerCmdlet('Rename-Item', (args, context, input) => {
  const path = args.positional[0] ? psValueToString(args.positional[0]) : null;
  const newName = args.positional[1] ? psValueToString(args.positional[1]) : null;

  if (!path || !newName) {
    return { objects: [psString('Rename-Item: Missing required arguments.')], exitCode: 1 };
  }

  const srcPath = context.fs.resolvePath(path, context.state.currentPath);
  const lastSlash = srcPath.lastIndexOf('\\');
  const parentPath = srcPath.substring(0, lastSlash);
  const destPath = parentPath + '\\' + newName;

  const success = context.fs.moveNode(srcPath, destPath);
  if (!success) {
    return { objects: [psString(`Rename-Item: Cannot rename item '${path}'.`)], exitCode: 1 };
  }

  return { objects: [], exitCode: 0 };
});

registerCmdlet('Test-Path', (args, context, input) => {
  const path = args.positional[0] ? psValueToString(args.positional[0]) : null;

  if (!path) {
    return { objects: [psBool(false)], exitCode: 0 };
  }

  const fullPath = context.fs.resolvePath(path, context.state.currentPath);
  return { objects: [psBool(context.fs.exists(fullPath))], exitCode: 0 };
});

// ==================== Output Cmdlets ====================

registerCmdlet('Write-Output', (args, context, input) => {
  const objects = args.positional.length > 0 ? args.positional : input;
  return { objects, exitCode: 0 };
});

registerCmdlet('Write-Host', (args, context, input) => {
  const message = args.positional.map(p => psValueToString(p)).join(' ');
  return { objects: [psString(message)], exitCode: 0 };
});

registerCmdlet('Write-Error', (args, context, input) => {
  const message = args.positional[0] ? psValueToString(args.positional[0]) : '';
  return { objects: [psString(`Write-Error: ${message}`)], exitCode: 1 };
});

registerCmdlet('Write-Warning', (args, context, input) => {
  const message = args.positional[0] ? psValueToString(args.positional[0]) : '';
  return { objects: [psString(`WARNING: ${message}`)], exitCode: 0 };
});

registerCmdlet('Write-Verbose', (args, context, input) => {
  return { objects: [], exitCode: 0 };
});

registerCmdlet('Write-Debug', (args, context, input) => {
  return { objects: [], exitCode: 0 };
});

registerCmdlet('Clear-Host', (args, context, input) => {
  // This is handled specially in the terminal
  return { objects: [psString('\x1b[2J\x1b[H')], exitCode: 0 };
});

registerCmdlet('Out-Host', (args, context, input) => {
  return { objects: input, exitCode: 0 };
});

registerCmdlet('Out-Null', (args, context, input) => {
  return { objects: [], exitCode: 0 };
});

registerCmdlet('Out-File', (args, context, input) => {
  const path = args.positional[0] ? psValueToString(args.positional[0]) : null;
  const append = args.named.get('append');

  if (!path) {
    return { objects: [psString('Out-File: Missing path argument.')], exitCode: 1 };
  }

  const content = input.map(v => psValueToString(v)).join('\r\n');
  const fullPath = context.fs.resolvePath(path, context.state.currentPath);

  if (append && context.fs.exists(fullPath)) {
    const node = context.fs.getNode(fullPath);
    if (node) {
      context.fs.updateFile(fullPath, (node.content || '') + '\r\n' + content);
    }
  } else {
    if (context.fs.exists(fullPath)) {
      context.fs.updateFile(fullPath, content);
    } else {
      context.fs.createNode(fullPath, 'file', content);
    }
  }

  return { objects: [], exitCode: 0 };
});

// ==================== Object Cmdlets ====================

registerCmdlet('Select-Object', (args, context, input) => {
  const first = args.named.get('first');
  const last = args.named.get('last');
  const skip = args.named.get('skip');
  const properties = args.positional;

  let result = [...input];

  if (skip) {
    const skipCount = skip.type === 'int' ? skip.value : parseInt(psValueToString(skip));
    result = result.slice(skipCount);
  }

  if (first) {
    const count = first.type === 'int' ? first.value : parseInt(psValueToString(first));
    result = result.slice(0, count);
  }

  if (last) {
    const count = last.type === 'int' ? last.value : parseInt(psValueToString(last));
    result = result.slice(-count);
  }

  if (properties.length > 0) {
    result = result.map(obj => {
      if (obj.type === 'psobject') {
        const newProps = new Map<string, PSValue>();
        for (const prop of properties) {
          const propName = psValueToString(prop);
          const value = obj.properties.get(propName) || obj.properties.get(propName.charAt(0).toUpperCase() + propName.slice(1));
          if (value) {
            newProps.set(propName, value);
          }
        }
        return { ...obj, properties: newProps };
      }
      return obj;
    });
  }

  return { objects: result, exitCode: 0 };
});

registerCmdlet('Where-Object', (args, context, input) => {
  const property = args.named.get('property') || args.positional[0];
  const eq = args.named.get('eq');
  const ne = args.named.get('ne');
  const like = args.named.get('like');
  const match = args.named.get('match');

  if (!property) {
    return { objects: input, exitCode: 0 };
  }

  const propName = psValueToString(property);

  const result = input.filter(obj => {
    let value: PSValue = psNull();

    if (obj.type === 'psobject') {
      value = obj.properties.get(propName) ||
              obj.properties.get(propName.charAt(0).toUpperCase() + propName.slice(1)) ||
              psNull();
    }

    const strValue = psValueToString(value);

    if (eq) {
      return strValue === psValueToString(eq);
    }
    if (ne) {
      return strValue !== psValueToString(ne);
    }
    if (like) {
      const pattern = psValueToString(like).replace(/\*/g, '.*').replace(/\?/g, '.');
      return new RegExp(`^${pattern}$`, 'i').test(strValue);
    }
    if (match) {
      return new RegExp(psValueToString(match), 'i').test(strValue);
    }

    return true;
  });

  return { objects: result, exitCode: 0 };
});

registerCmdlet('Sort-Object', (args, context, input) => {
  const property = args.positional[0];
  const descending = args.named.get('descending');

  const result = [...input].sort((a, b) => {
    let aVal = '', bVal = '';

    if (property) {
      const propName = psValueToString(property);
      if (a.type === 'psobject') {
        aVal = psValueToString(a.properties.get(propName) || psNull());
      }
      if (b.type === 'psobject') {
        bVal = psValueToString(b.properties.get(propName) || psNull());
      }
    } else {
      aVal = psValueToString(a);
      bVal = psValueToString(b);
    }

    const cmp = aVal.localeCompare(bVal);
    return descending ? -cmp : cmp;
  });

  return { objects: result, exitCode: 0 };
});

registerCmdlet('ForEach-Object', (args, context, input) => {
  const memberName = args.named.get('membername');
  const process = args.named.get('process');

  if (memberName) {
    const name = psValueToString(memberName);
    const result = input.map(obj => {
      if (obj.type === 'psobject') {
        return obj.properties.get(name) || psNull();
      }
      return psNull();
    });
    return { objects: result, exitCode: 0 };
  }

  return { objects: input, exitCode: 0 };
});

registerCmdlet('Measure-Object', (args, context, input) => {
  const property = args.positional[0];
  const sum = args.named.get('sum');
  const average = args.named.get('average');
  const maximum = args.named.get('maximum');
  const minimum = args.named.get('minimum');

  let count = 0;
  let total = 0;
  let max = -Infinity;
  let min = Infinity;

  for (const obj of input) {
    let value: number | null = null;

    if (property) {
      const propName = psValueToString(property);
      if (obj.type === 'psobject') {
        const propValue = obj.properties.get(propName);
        if (propValue && (propValue.type === 'int' || propValue.type === 'double')) {
          value = propValue.value;
        }
      }
    } else if (obj.type === 'int' || obj.type === 'double') {
      value = obj.value;
    }

    count++;
    if (value !== null) {
      total += value;
      max = Math.max(max, value);
      min = Math.min(min, value);
    }
  }

  const props = new Map<string, PSValue>();
  props.set('Count', psInt(count));

  if (sum) props.set('Sum', psFloat(total));
  if (average) props.set('Average', psFloat(count > 0 ? total / count : 0));
  if (maximum) props.set('Maximum', psFloat(max === -Infinity ? 0 : max));
  if (minimum) props.set('Minimum', psFloat(min === Infinity ? 0 : min));

  return {
    objects: [{
      type: 'psobject',
      typeName: 'Microsoft.PowerShell.Commands.GenericMeasureInfo',
      properties: props,
      methods: new Map(),
    }],
    exitCode: 0,
  };
});

registerCmdlet('Group-Object', (args, context, input) => {
  const property = args.positional[0];

  const groups = new Map<string, PSValue[]>();

  for (const obj of input) {
    let key = '';

    if (property) {
      const propName = psValueToString(property);
      if (obj.type === 'psobject') {
        key = psValueToString(obj.properties.get(propName) || psNull());
      }
    } else {
      key = psValueToString(obj);
    }

    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key)!.push(obj);
  }

  const result: PSValue[] = [];
  groups.forEach((members, name) => {
    const props = new Map<string, PSValue>();
    props.set('Count', psInt(members.length));
    props.set('Name', psString(name));
    props.set('Group', psArray(members));
    result.push({
      type: 'psobject',
      typeName: 'Microsoft.PowerShell.Commands.GroupInfo',
      properties: props,
      methods: new Map(),
    });
  });

  return { objects: result, exitCode: 0 };
});

// ==================== String Cmdlets ====================

registerCmdlet('Select-String', (args, context, input) => {
  const pattern = args.positional[0] ? psValueToString(args.positional[0]) : '';
  const path = args.named.get('path');
  const caseSensitive = args.named.get('casesensitive');

  const flags = caseSensitive ? '' : 'i';
  const regex = new RegExp(pattern, flags);
  const results: PSValue[] = [];

  const searchContent = (content: string, fileName: string): void => {
    const lines = content.split(/\r?\n/);
    lines.forEach((line, index) => {
      if (regex.test(line)) {
        const props = new Map<string, PSValue>();
        props.set('Path', psString(fileName));
        props.set('LineNumber', psInt(index + 1));
        props.set('Line', psString(line));
        props.set('Pattern', psString(pattern));
        results.push({
          type: 'psobject',
          typeName: 'Microsoft.PowerShell.Commands.MatchInfo',
          properties: props,
          methods: new Map(),
        });
      }
    });
  };

  if (path) {
    const filePath = context.fs.resolvePath(psValueToString(path), context.state.currentPath);
    const node = context.fs.getNode(filePath);
    if (node && node.type === 'file') {
      searchContent(node.content || '', filePath);
    }
  } else {
    for (const obj of input) {
      searchContent(psValueToString(obj), 'stdin');
    }
  }

  return { objects: results, exitCode: 0 };
});

// ==================== Variable Cmdlets ====================

registerCmdlet('Get-Variable', (args, context, input) => {
  const name = args.positional[0] ? psValueToString(args.positional[0]) : null;

  if (name) {
    const value = context.variables.get(name);
    if (value === undefined) {
      return { objects: [psString(`Get-Variable: Cannot find a variable with the name '${name}'.`)], exitCode: 1 };
    }

    const props = new Map<string, PSValue>();
    props.set('Name', psString(name));
    props.set('Value', value);

    return {
      objects: [{
        type: 'psobject',
        typeName: 'System.Management.Automation.PSVariable',
        properties: props,
        methods: new Map(),
      }],
      exitCode: 0,
    };
  }

  const results: PSValue[] = [];
  context.variables.forEach((value, name) => {
    const props = new Map<string, PSValue>();
    props.set('Name', psString(name));
    props.set('Value', value);
    results.push({
      type: 'psobject',
      typeName: 'System.Management.Automation.PSVariable',
      properties: props,
      methods: new Map(),
    });
  });

  return { objects: results, exitCode: 0 };
});

registerCmdlet('Set-Variable', (args, context, input) => {
  const name = args.positional[0] ? psValueToString(args.positional[0]) : null;
  const value = args.positional[1] || args.named.get('value');

  if (!name) {
    return { objects: [psString('Set-Variable: Cannot bind argument to parameter \'Name\' because it is null.')], exitCode: 1 };
  }

  context.variables.set(name, value || psNull());
  return { objects: [], exitCode: 0 };
});

registerCmdlet('Remove-Variable', (args, context, input) => {
  const name = args.positional[0] ? psValueToString(args.positional[0]) : null;

  if (!name) {
    return { objects: [psString('Remove-Variable: Cannot bind argument to parameter \'Name\' because it is null.')], exitCode: 1 };
  }

  context.variables.delete(name);
  return { objects: [], exitCode: 0 };
});

// ==================== Help and Info Cmdlets ====================

registerCmdlet('Get-Help', (args, context, input) => {
  const cmdletName = args.positional[0] ? psValueToString(args.positional[0]) : null;

  if (!cmdletName) {
    return {
      objects: [psString(`
TOPIC
    Windows PowerShell Help System

SHORT DESCRIPTION
    Displays help about Windows PowerShell cmdlets and concepts.

LONG DESCRIPTION
    Windows PowerShell Help describes Windows PowerShell cmdlets,
    functions, scripts, and modules, and explains concepts, including
    the elements of the Windows PowerShell language.

    To display the help topic for a cmdlet, type:
        Get-Help <cmdlet-name>

EXAMPLES:
    Get-Help Get-ChildItem
    Get-Help Get-Process
    Get-Help about_*
`)],
      exitCode: 0,
    };
  }

  // Simple help for common cmdlets
  const helpTexts: Record<string, string> = {
    'get-childitem': `
NAME
    Get-ChildItem

SYNOPSIS
    Gets the items and child items in one or more specified locations.

SYNTAX
    Get-ChildItem [[-Path] <string[]>] [-Recurse] [-Force] [-Name]
        [-File] [-Directory] [<CommonParameters>]

ALIASES
    gci, ls, dir

EXAMPLES
    Get-ChildItem
    Get-ChildItem -Path C:\\Windows -Recurse
    ls -Force
`,
    'set-location': `
NAME
    Set-Location

SYNOPSIS
    Sets the current working location to a specified location.

SYNTAX
    Set-Location [[-Path] <string>] [<CommonParameters>]

ALIASES
    sl, cd, chdir

EXAMPLES
    Set-Location C:\\Windows
    cd ..
    sl ~
`,
  };

  const help = helpTexts[cmdletName.toLowerCase()];
  if (help) {
    return { objects: [psString(help)], exitCode: 0 };
  }

  return { objects: [psString(`Get-Help: No help found for '${cmdletName}'.`)], exitCode: 0 };
});

registerCmdlet('Get-Command', (args, context, input) => {
  const name = args.positional[0] ? psValueToString(args.positional[0]) : null;

  const allCmdlets = Array.from(cmdlets.keys());

  if (name) {
    const pattern = name.replace(/\*/g, '.*').replace(/\?/g, '.');
    const regex = new RegExp(`^${pattern}$`, 'i');
    const matches = allCmdlets.filter(c => regex.test(c));

    const results: PSValue[] = matches.map(cmd => {
      const props = new Map<string, PSValue>();
      props.set('Name', psString(cmd));
      props.set('CommandType', psString('Cmdlet'));
      return {
        type: 'psobject',
        typeName: 'System.Management.Automation.CmdletInfo',
        properties: props,
        methods: new Map(),
      };
    });

    return { objects: results, exitCode: 0 };
  }

  const results: PSValue[] = allCmdlets.map(cmd => {
    const props = new Map<string, PSValue>();
    props.set('Name', psString(cmd));
    props.set('CommandType', psString('Cmdlet'));
    return {
      type: 'psobject',
      typeName: 'System.Management.Automation.CmdletInfo',
      properties: props,
      methods: new Map(),
    };
  });

  return { objects: results, exitCode: 0 };
});

registerCmdlet('Get-Alias', (args, context, input) => {
  const name = args.positional[0] ? psValueToString(args.positional[0]) : null;

  if (name) {
    const definition = context.aliases.get(name.toLowerCase());
    if (!definition) {
      return { objects: [psString(`Get-Alias: Cannot find alias '${name}'.`)], exitCode: 1 };
    }

    const props = new Map<string, PSValue>();
    props.set('Name', psString(name));
    props.set('Definition', psString(definition));

    return {
      objects: [{
        type: 'psobject',
        typeName: 'System.Management.Automation.AliasInfo',
        properties: props,
        methods: new Map(),
      }],
      exitCode: 0,
    };
  }

  const results: PSValue[] = [];
  context.aliases.forEach((def, alias) => {
    const props = new Map<string, PSValue>();
    props.set('Name', psString(alias));
    props.set('Definition', psString(def));
    results.push({
      type: 'psobject',
      typeName: 'System.Management.Automation.AliasInfo',
      properties: props,
      methods: new Map(),
    });
  });

  return { objects: results, exitCode: 0 };
});

registerCmdlet('Get-History', (args, context, input) => {
  const results: PSValue[] = context.state.history.map((cmd, idx) => {
    const props = new Map<string, PSValue>();
    props.set('Id', psInt(idx + 1));
    props.set('CommandLine', psString(cmd));
    return {
      type: 'psobject',
      typeName: 'Microsoft.PowerShell.Commands.HistoryInfo',
      properties: props,
      methods: new Map(),
    };
  });

  return { objects: results, exitCode: 0 };
});

// ==================== Date/Time Cmdlets ====================

registerCmdlet('Get-Date', (args, context, input) => {
  const format = args.named.get('format');
  const date = new Date();

  if (format) {
    // Simple format strings
    const formatStr = psValueToString(format);
    let result = formatStr;
    result = result.replace(/yyyy/g, String(date.getFullYear()));
    result = result.replace(/MM/g, String(date.getMonth() + 1).padStart(2, '0'));
    result = result.replace(/dd/g, String(date.getDate()).padStart(2, '0'));
    result = result.replace(/HH/g, String(date.getHours()).padStart(2, '0'));
    result = result.replace(/mm/g, String(date.getMinutes()).padStart(2, '0'));
    result = result.replace(/ss/g, String(date.getSeconds()).padStart(2, '0'));

    return { objects: [psString(result)], exitCode: 0 };
  }

  return { objects: [psDateTime(date)], exitCode: 0 };
});

// ==================== Process Cmdlets (Simulated) ====================

registerCmdlet('Get-Process', (args, context, input) => {
  const name = args.positional[0] ? psValueToString(args.positional[0]) : null;

  const processes = [
    { name: 'System', pid: 4, cpu: 0.1, memory: 144 },
    { name: 'csrss', pid: 476, cpu: 0.5, memory: 4096 },
    { name: 'services', pid: 680, cpu: 0.2, memory: 8704 },
    { name: 'svchost', pid: 792, cpu: 1.0, memory: 17408 },
    { name: 'dwm', pid: 1056, cpu: 2.5, memory: 65536 },
    { name: 'explorer', pid: 1256, cpu: 1.5, memory: 98304 },
    { name: 'powershell', pid: 2048, cpu: 0.3, memory: 65536 },
  ];

  let filtered = processes;
  if (name) {
    const pattern = name.replace(/\*/g, '.*').replace(/\?/g, '.');
    const regex = new RegExp(`^${pattern}$`, 'i');
    filtered = processes.filter(p => regex.test(p.name));
  }

  const results: PSValue[] = filtered.map(proc => {
    const props = new Map<string, PSValue>();
    props.set('Id', psInt(proc.pid));
    props.set('ProcessName', psString(proc.name));
    props.set('CPU', psFloat(proc.cpu));
    props.set('WorkingSet64', psInt(proc.memory * 1024));
    props.set('Name', psString(proc.name));
    return {
      type: 'psobject',
      typeName: 'System.Diagnostics.Process',
      properties: props,
      methods: new Map(),
    };
  });

  return { objects: results, exitCode: 0 };
});

registerCmdlet('Stop-Process', (args, context, input) => {
  const id = args.named.get('id');
  const name = args.named.get('name');

  if (!id && !name) {
    return { objects: [psString('Stop-Process: Cannot process command because of missing mandatory parameters.')], exitCode: 1 };
  }

  return { objects: [psString('Process stopped.')], exitCode: 0 };
});

// Format Cmdlets
registerCmdlet('Format-Table', (args, context, input) => {
  if (input.length === 0) return { objects: [], exitCode: 0 };

  const properties = args.positional;

  // Get all property names
  let headers: string[] = [];
  if (properties.length > 0) {
    headers = properties.map(p => psValueToString(p));
  } else if (input[0].type === 'psobject') {
    headers = Array.from(input[0].properties.keys());
  }

  if (headers.length === 0) {
    return { objects: input.map(o => psString(psValueToString(o))), exitCode: 0 };
  }

  // Build table
  const colWidths: number[] = headers.map(h => h.length);

  const rows = input.map(obj => {
    const row: string[] = [];
    headers.forEach((header, i) => {
      let value = '';
      if (obj.type === 'psobject') {
        const propValue = obj.properties.get(header) || obj.properties.get(header.charAt(0).toUpperCase() + header.slice(1));
        value = propValue ? psValueToString(propValue) : '';
      } else {
        value = psValueToString(obj);
      }
      colWidths[i] = Math.max(colWidths[i], value.length);
      row.push(value);
    });
    return row;
  });

  // Format output
  let output = '\r\n';
  output += headers.map((h, i) => h.padEnd(colWidths[i])).join(' ') + '\r\n';
  output += headers.map((_, i) => '-'.repeat(colWidths[i])).join(' ') + '\r\n';

  for (const row of rows) {
    output += row.map((cell, i) => cell.padEnd(colWidths[i])).join(' ') + '\r\n';
  }

  return { objects: [psString(output)], exitCode: 0 };
});

registerCmdlet('Format-List', (args, context, input) => {
  let output = '\r\n';

  for (const obj of input) {
    if (obj.type === 'psobject') {
      obj.properties.forEach((value, key) => {
        output += `${key} : ${psValueToString(value)}\r\n`;
      });
      output += '\r\n';
    } else {
      output += psValueToString(obj) + '\r\n';
    }
  }

  return { objects: [psString(output)], exitCode: 0 };
});

registerCmdlet('Format-Wide', (args, context, input) => {
  const property = args.positional[0];
  const column = args.named.get('column');
  const cols = column?.type === 'int' ? column.value : 4;

  const values = input.map(obj => {
    if (property && obj.type === 'psobject') {
      const propName = psValueToString(property);
      return psValueToString(obj.properties.get(propName) || psNull());
    }
    return psValueToString(obj);
  });

  const maxLen = Math.max(...values.map(v => v.length), 10);
  const colWidth = maxLen + 2;

  let output = '\r\n';
  for (let i = 0; i < values.length; i += cols) {
    output += values.slice(i, i + cols).map(v => v.padEnd(colWidth)).join('') + '\r\n';
  }

  return { objects: [psString(output)], exitCode: 0 };
});

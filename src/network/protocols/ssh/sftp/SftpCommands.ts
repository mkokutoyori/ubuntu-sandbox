/**
 * Concrete SFTP command implementations.
 *
 * Each command depends only on the role interface it actually needs
 * (Interface Segregation). Tests can substitute minimal fakes.
 *
 * Reference: DESIGN-SSH-SFTP.md sections 8.2 + 9.1.
 */

import { type Result, err, ok, propagateErr } from '../Result';
import type {
  ISftpCommand,
  SftpCommandContext,
  SftpRequestPayload,
} from './ISftpCommand';
import type { SftpDirEntry, SftpFileAttrs } from './ISftpFileSystem';

const requirePath = (req: SftpRequestPayload): Result<string> =>
  req.path !== undefined
    ? ok(req.path)
    : err({ kind: 'INVALID_ARGUMENT', message: `${req.op}: missing path` });

export class SftpGetCommand implements ISftpCommand<{ content: string }> {
  readonly op = 'get';
  execute(
    req: SftpRequestPayload,
    ctx: SftpCommandContext,
  ): Result<{ content: string }> {
    const p = requirePath(req);
    if (!p.ok) return propagateErr(p);
    const path = ctx.vfs.normalizePath(p.value, ctx.cwd);
    const stat = ctx.vfs.stat(path);
    if (!stat.ok) return propagateErr(stat);
    const content = ctx.vfs.readFile(path);
    if (!content.ok) return propagateErr(content);
    return ok({ content: content.value });
  }
}

export class SftpPutCommand implements ISftpCommand<void> {
  readonly op = 'put';
  execute(req: SftpRequestPayload, ctx: SftpCommandContext): Result<void> {
    const p = requirePath(req);
    if (!p.ok) return propagateErr(p);
    if (req.content === undefined) {
      return err({ kind: 'INVALID_ARGUMENT', message: 'put: missing content' });
    }
    const path = ctx.vfs.normalizePath(p.value, ctx.cwd);
    return ctx.vfs.writeFile(path, req.content);
  }
}

export class SftpLsCommand
  implements ISftpCommand<{ entries: readonly SftpDirEntry[] }>
{
  readonly op = 'ls';
  execute(
    req: SftpRequestPayload,
    ctx: SftpCommandContext,
  ): Result<{ entries: readonly SftpDirEntry[] }> {
    const target = ctx.vfs.normalizePath(req.path ?? '.', ctx.cwd);
    const entries = ctx.vfs.listDirectory(target);
    if (!entries.ok) return propagateErr(entries);
    return ok({ entries: entries.value });
  }
}

export class SftpMkdirCommand implements ISftpCommand<void> {
  readonly op = 'mkdir';
  execute(req: SftpRequestPayload, ctx: SftpCommandContext): Result<void> {
    const p = requirePath(req);
    if (!p.ok) return propagateErr(p);
    const path = ctx.vfs.normalizePath(p.value, ctx.cwd);
    const parent = path.replace(/\/[^/]+\/?$/, '') || '/';
    if (!ctx.vfs.exists(parent)) {
      return err({
        kind: 'IO_ERROR',
        message: `mkdir ${path}: parent ${parent} does not exist`,
      });
    }
    return ctx.vfs.mkdir(path);
  }
}

export class SftpRmCommand implements ISftpCommand<void> {
  readonly op = 'rm';
  execute(req: SftpRequestPayload, ctx: SftpCommandContext): Result<void> {
    const p = requirePath(req);
    if (!p.ok) return propagateErr(p);
    const path = ctx.vfs.normalizePath(p.value, ctx.cwd);
    return ctx.vfs.deleteFile(path);
  }
}

export class SftpRmdirCommand implements ISftpCommand<void> {
  readonly op = 'rmdir';
  execute(req: SftpRequestPayload, ctx: SftpCommandContext): Result<void> {
    const p = requirePath(req);
    if (!p.ok) return propagateErr(p);
    const path = ctx.vfs.normalizePath(p.value, ctx.cwd);
    return ctx.vfs.rmdir(path);
  }
}

export class SftpRenameCommand implements ISftpCommand<void> {
  readonly op = 'rename';
  execute(req: SftpRequestPayload, ctx: SftpCommandContext): Result<void> {
    if (req.src === undefined || req.dst === undefined) {
      return err({
        kind: 'INVALID_ARGUMENT',
        message: 'rename: missing src or dst',
      });
    }
    const src = ctx.vfs.normalizePath(req.src, ctx.cwd);
    const dst = ctx.vfs.normalizePath(req.dst, ctx.cwd);
    if (ctx.vfs.exists(dst)) {
      return err({
        kind: 'IO_ERROR',
        message: `rename: destination ${dst} already exists`,
      });
    }
    return ctx.vfs.rename(src, dst);
  }
}

export class SftpChmodCommand implements ISftpCommand<void> {
  readonly op = 'chmod';
  execute(req: SftpRequestPayload, ctx: SftpCommandContext): Result<void> {
    const p = requirePath(req);
    if (!p.ok) return propagateErr(p);
    if (req.mode === undefined) {
      return err({ kind: 'INVALID_ARGUMENT', message: 'chmod: missing mode' });
    }
    const path = ctx.vfs.normalizePath(p.value, ctx.cwd);
    return ctx.vfs.setPermissions(path, req.mode);
  }
}

export class SftpChownCommand implements ISftpCommand<void> {
  readonly op = 'chown';
  execute(req: SftpRequestPayload, ctx: SftpCommandContext): Result<void> {
    const p = requirePath(req);
    if (!p.ok) return propagateErr(p);
    if (req.uid === undefined || req.gid === undefined) {
      return err({
        kind: 'INVALID_ARGUMENT',
        message: 'chown: missing uid/gid',
      });
    }
    const path = ctx.vfs.normalizePath(p.value, ctx.cwd);
    return ctx.vfs.setOwner(path, req.uid, req.gid);
  }
}

export class SftpStatCommand implements ISftpCommand<SftpFileAttrs> {
  readonly op = 'stat';
  execute(
    req: SftpRequestPayload,
    ctx: SftpCommandContext,
  ): Result<SftpFileAttrs> {
    const p = requirePath(req);
    if (!p.ok) return propagateErr(p);
    const path = ctx.vfs.normalizePath(p.value, ctx.cwd);
    return ctx.vfs.stat(path);
  }
}

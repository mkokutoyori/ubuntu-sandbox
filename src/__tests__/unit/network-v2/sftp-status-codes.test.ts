/**
 * SftpStatusCodes — real SSH_FX_* status table + Result/SshError
 * correspondence (draft-ietf-secsh-filexfer §7/§9.1, PRD-FTP-SFTP.md
 * §2.1.15/P15).
 */
import { describe, it, expect } from 'vitest';
import { SSH_FX, okStatus, statusFromError } from '@/network/protocols/ssh/sftp/SftpStatusCodes';
import type { SshError } from '@/network/protocols/ssh/Result';

describe('SftpStatusCodes', () => {
  it('okStatus() is SSH_FX_OK', () => {
    expect(okStatus()).toEqual({ code: SSH_FX.OK, message: 'OK' });
  });

  it('maps PERMISSION_DENIED to SSH_FX_PERMISSION_DENIED', () => {
    const error: SshError = { kind: 'PERMISSION_DENIED', path: '/etc/shadow', operation: 'read' };
    expect(statusFromError(error)).toEqual({ code: SSH_FX.PERMISSION_DENIED, message: 'Permission denied.' });
  });

  it('maps UNKNOWN_OP to SSH_FX_OP_UNSUPPORTED', () => {
    const error: SshError = { kind: 'UNKNOWN_OP', op: 'frobnicate' };
    expect(statusFromError(error)).toEqual({ code: SSH_FX.OP_UNSUPPORTED, message: 'Unsupported operation: frobnicate' });
  });

  it('maps an IO_ERROR mentioning "no such"/"not found" to SSH_FX_NO_SUCH_FILE', () => {
    expect(statusFromError({ kind: 'IO_ERROR', message: 'ghost.txt: no such file' }).code).toBe(SSH_FX.NO_SUCH_FILE);
    expect(statusFromError({ kind: 'IO_ERROR', message: 'ghost.txt: not found' }).code).toBe(SSH_FX.NO_SUCH_FILE);
  });

  it('maps any other IO_ERROR to SSH_FX_FAILURE', () => {
    const error: SshError = { kind: 'IO_ERROR', message: 'disk quota exceeded' };
    expect(statusFromError(error)).toEqual({ code: SSH_FX.FAILURE, message: 'disk quota exceeded' });
  });

  it('maps INVALID_ARGUMENT to SSH_FX_BAD_MESSAGE', () => {
    const error: SshError = { kind: 'INVALID_ARGUMENT', message: 'put: missing content' };
    expect(statusFromError(error)).toEqual({ code: SSH_FX.BAD_MESSAGE, message: 'put: missing content' });
  });

  it('maps every remaining SshError kind (not surfaced by the SFTP layer) to SSH_FX_FAILURE', () => {
    const errors: SshError[] = [
      { kind: 'HOST_KEY_CHANGED', host: 'h', expected: 'a', got: 'b' },
      { kind: 'HOST_KEY_REJECTED', host: 'h', fingerprint: 'f' },
      { kind: 'AUTH_FAILED', user: 'u', attemptsLeft: 0 },
      { kind: 'CONNECTION_REFUSED', host: 'h', port: 22 },
      { kind: 'NOT_AUTHENTICATED' },
      { kind: 'CHANNEL_ERROR', channelId: 1, message: 'closed' },
    ];
    for (const error of errors) {
      expect(statusFromError(error)).toEqual({ code: SSH_FX.FAILURE, message: 'Failure.' });
    }
  });
});

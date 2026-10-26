import { openDescriptors, type DescriptorSources, type OpenDescriptor } from './FileDescriptorTable';

export interface ProcessLinkSubject {
  readonly pid: number;
  readonly uid: number;
  readonly exe: string;
  readonly cwd: string;
}

export interface ProcessLinkSources {
  subject(pid: number): ProcessLinkSubject | undefined;
  descriptorSources(pid: number): DescriptorSources;
  resolveExecutable(name: string): string | null;
}

export function cwdLinkOf(sources: ProcessLinkSources, pid: number): string | null {
  return sources.subject(pid)?.cwd ?? null;
}

export function rootLinkOf(sources: ProcessLinkSources, pid: number): string | null {
  return sources.subject(pid) === undefined ? null : '/';
}

export function exeLinkOf(sources: ProcessLinkSources, pid: number): string | null {
  const subject = sources.subject(pid);
  if (subject === undefined || subject.exe === '') return null;
  return subject.exe.startsWith('/') ? subject.exe : sources.resolveExecutable(subject.exe.replace(/^-/, ''));
}

export function descriptorsOf(sources: ProcessLinkSources, pid: number): OpenDescriptor[] {
  return sources.subject(pid) === undefined ? [] : openDescriptors(sources.descriptorSources(pid));
}

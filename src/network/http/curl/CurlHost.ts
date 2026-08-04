import type { TcpStack } from '@/network/tcp/TcpStack';
import type { X509Certificate } from '@/network/pki/X509Certificate';

export interface CurlHost {
  resolveHostname(name: string): Promise<string | null>;
  tcpStack(): TcpStack;
  trustAnchors(): readonly X509Certificate[];
  writeFile(target: string, content: string): boolean;
}

import https from 'node:https';
import tls from 'node:tls';
import { createHash } from 'node:crypto';
import type { PeerInput } from '../../src/shared/federation.js';
import { MAX_BYTES } from './protocol.js';

export class PeerError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}
/** Verify the out-of-band certificate pin BEFORE handing the socket to HTTP (and its token). */
export function peerRequest(
  peer: PeerInput,
  route: string,
  signal?: AbortSignal,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const agent = new https.Agent({ keepAlive: false, maxSockets: 1 });
    agent.createConnection = (options, callback) => {
      const socket = tls.connect({
        host: options.host ?? undefined,
        port: Number(options.port),
        servername: options.servername,
        rejectUnauthorized: false,
        minVersion: 'TLSv1.2',
      });
      socket.setTimeout(5000, () => socket.destroy(new PeerError(408, 'TLS handshake timed out')));
      let handedOff = false;
      socket.once('error', (e) => {
        if (!handedOff) {
          handedOff = true;
          callback?.(e, socket);
        }
      });
      socket.once('secureConnect', () => {
        const cert = socket.getPeerCertificate();
        const pin = cert.raw && createHash('sha256').update(cert.raw).digest('hex');
        if (
          pin !== peer.fingerprint ||
          Date.parse(cert.valid_to) < Date.now() ||
          Date.parse(cert.valid_from) > Date.now()
        ) {
          socket.destroy(new PeerError(403, 'Certificate identity changed or expired'));
          return;
        }
        handedOff = true;
        callback?.(null, socket);
      });
      // Async callback: returning the socket here would let HTTP write before pin verification.
      return undefined as unknown as tls.TLSSocket;
    };
    const request = https.request(
      new URL(route, peer.endpoint),
      {
        agent,
        method: 'GET',
        headers: { Authorization: `Bearer ${peer.token}`, Accept: 'application/json' },
        signal,
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          request.destroy(
            new PeerError(response.statusCode ?? 500, `Peer response ${response.statusCode}`),
          );
          return;
        }
        let size = 0;
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BYTES) request.destroy(new PeerError(413, 'Peer response exceeds limit'));
          else chunks.push(chunk);
        });
        response.once('error', () => reject(new PeerError(0, 'Peer connection interrupted')));
        response.once('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch {
            reject(new PeerError(400, 'Invalid peer response'));
          }
        });
      },
    );
    const timer = setTimeout(
      () => request.destroy(new PeerError(408, 'Peer request timed out')),
      5000,
    );
    request.once('error', (e) =>
      reject(e instanceof PeerError ? e : new PeerError(0, 'Peer connection unavailable')),
    );
    request.once('close', () => {
      clearTimeout(timer);
      agent.destroy();
    });
    request.end();
  });
}

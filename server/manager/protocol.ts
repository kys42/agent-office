import net from 'node:net';
import { readFile } from 'node:fs/promises';
export interface Connection {
  socket: string;
  token: string;
}
export async function request(
  connection: Connection,
  command: string,
  args: unknown = {},
): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(connection.socket);
    socket.setEncoding('utf8');
    let buffer = '';
    const fail = (error: Error) => {
      socket.destroy();
      reject(error);
    };
    socket.setTimeout(50_000, () => fail(new Error('Office connection timed out.')));
    socket.on('error', fail);
    socket.on('connect', () =>
      socket.write(JSON.stringify({ token: connection.token, command, args }) + '\n'),
    );
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      if (buffer.length > 4_000_000) return fail(new Error('Office response too large.'));
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      try {
        const result = JSON.parse(buffer.slice(0, end));
        socket.end();
        if (result.error) reject(new Error(result.error));
        else resolve(result.result);
      } catch (e) {
        fail(e as Error);
      }
    });
    socket.on('end', () => {
      if (!buffer.includes('\n')) reject(new Error('Office disconnected.'));
    });
  });
}
export const readConnection = async (file: string): Promise<Connection> =>
  JSON.parse(await readFile(file, 'utf8'));

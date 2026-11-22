'use strict';

/**
 * @file ftp-dependency.test.js
 * @description Exercise get-uri's real FTP listing fallback and download against
 * an owned loopback peer, guarding the scoped basic-ftp security override.
 */
const net = require('node:net');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const runChild = promisify(execFile);
const ftpPath = require.resolve('basic-ftp', { paths: [require.resolve('get-uri')] });
const { getUri } = require('get-uri');

const payload = 'Synthetic proxy configuration.\n';
const sockets = new Set();
const servers = new Set();
const commands = [];
let controlServer;
let listingFacts = '';
beforeEach(() => { listingFacts = ''; });

/** Track every owned socket so failed assertions cannot leave listeners behind. */
const track = socket => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
  return socket;
};

/** Start a server on an ephemeral loopback port. */
const listen = server => new Promise((resolve, reject) => {
  servers.add(server);
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});

beforeAll(async () => {
  controlServer = net.createServer(socket => {
    track(socket);
    socket.write('220 Fixture FTP ready\r\n');
    let buffer = '';
    let dataSocket;
    /** Respond only to the protocol surface consumed by get-uri/basic-ftp. */
    const respond = async line => {
      const command = line.split(' ')[0];
      commands.push(command);
      if (command === 'USER') socket.write(line === 'USER fixture-crlf' ? '331 Password required\r\n' : '230 Anonymous fixture session\r\n');
      else if (command === 'PASS') socket.write('230 Authenticated fixture session\r\n');
      else if (command === 'REST') socket.write('350 Resume accepted\r\n');
      else if (command === 'FEAT') socket.write('211 End\r\n');
      else if (command === 'MDTM') socket.write('500 Use directory listing\r\n');
      else if (command === 'EPSV') {
        let accept;
        dataSocket = new Promise(resolve => { accept = resolve; });
        const passive = net.createServer(peer => accept(track(peer)));
        await listen(passive);
        socket.write(`229 Entering Extended Passive Mode (|||${passive.address().port}|)\r\n`);
      } else if (command === 'LIST' || command === 'RETR') {
        socket.write('150 Opening data connection\r\n');
        const peer = await dataSocket;
        const data = command === 'LIST'
          ? `${listingFacts}type=file;size=${Buffer.byteLength(payload)};modify=20260615090000; proxy.pac\r\n`
          : payload;
        peer.end(data, () => socket.write('226 Transfer complete\r\n'));
      } else if (command === 'QUIT') socket.end('221 Goodbye\r\n');
      else socket.write('200 OK\r\n');
    };
    socket.on('data', chunk => {
      buffer += chunk.toString();
      let end;
      while ((end = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        respond(line).catch(error => socket.destroy(error));
      }
    });
  });
  await listen(controlServer);
});

afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  await Promise.all([...servers].map(server => new Promise(resolve => server.close(resolve))));
});

test('get-uri falls back to LIST metadata and downloads through the patched FTP client', async () => {
  const stream = await getUri(`ftp://127.0.0.1:${controlServer.address().port}/proxy.pac`);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  expect(Buffer.concat(chunks).toString()).toBe(payload);
  expect(stream.lastModified).toBeInstanceOf(Date);
  expect(stream.lastModified.getUTCFullYear()).toBe(2026);
  expect(commands).toEqual(expect.arrayContaining(['MDTM', 'LIST', 'RETR']));
});

/** Reproduce server-controlled inherited fact names through get-uri's actual listing fallback. */
test('MLSD inherited fact names cannot crash a real listing fallback and download', async () => {
  listingFacts = '__proto__=synthetic;constructor=synthetic;';
  const stream = await getUri(`ftp://127.0.0.1:${controlServer.address().port}/proxy.pac`);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  expect(Buffer.concat(chunks).toString()).toBe(payload);
  expect(stream.lastModified).toBeInstanceOf(Date);
});

/** Isolate uncaught socket-callback crashes in a child; a patched client must reject normally. */
test.each(['password', 'resume'])('control characters in %s reject without terminating the process', async operation => {
  const source = `
    const assert = require('node:assert/strict');
    const { Writable } = require('node:stream');
    const { Client } = require(process.argv[1]);
    const client = new Client(3000);
    (async () => {
      try {
        if (process.argv[2] === 'password') {
          await assert.rejects(client.access({ host: '127.0.0.1', port: Number(process.argv[3]), user: 'fixture-crlf', password: 'synthetic\\r\\nvalue' }), /control characters/i);
        } else {
          await client.access({ host: '127.0.0.1', port: Number(process.argv[3]) });
          const output = new Writable({ write(chunk, encoding, done) { done(); } });
          await assert.rejects(client.downloadTo(output, 'synthetic\\r\\npath', 1), /control characters/i);
        }
        console.log('SAFE_REJECTION');
      } finally { client.close(); }
    })().catch(() => { process.exitCode = 1; });
  `;
  const { stdout } = await runChild(process.execPath, ['-e', source, ftpPath, operation, String(controlServer.address().port)], { timeout: 8000 });
  expect(stdout.trim()).toBe('SAFE_REJECTION');
});

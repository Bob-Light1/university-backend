'use strict';

/** @file body-parser-dependency.test.js @description Compressed trailing bytes must neither crash the server nor strand the HTTP request. */
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);

test.each(['gzip', 'deflate'])('%s trailing bytes leave the server healthy and preserve the decoded JSON', async encoding => {
  const script = `
    const assert = require('node:assert/strict');
    const http = require('node:http');
    const zlib = require('node:zlib');
    const parser = require('express').json();
    const trailing = Buffer.alloc(1024, 88);
    const compressed = zlib[${JSON.stringify(encoding)} === 'gzip' ? 'gzipSync' : 'deflateSync']('{"synthetic":true}');
    const first = Buffer.concat([compressed, Buffer.from([0])]);
    let client;
    const server = http.createServer((request, response) => {
      if (request.method === 'GET') { response.end('healthy'); return; }
      parser(request, response, error => {
        assert.ifError(error);
        request.on('end', () => response.end(JSON.stringify(request.body)));
        client.end(trailing);
      });
    });
    server.listen(0, '127.0.0.1', async () => {
      const port = server.address().port;
      try {
        await new Promise((resolve, reject) => {
          client = http.request({ host: '127.0.0.1', port, method: 'POST', agent: false,
            headers: { 'Content-Type': 'application/json', 'Content-Encoding': ${JSON.stringify(encoding)},
              'Content-Length': first.length + trailing.length } }, response => {
            let body = '';
            response.on('data', chunk => { body += chunk; });
            response.on('end', () => {
              try { assert.equal(response.statusCode, 200); assert.deepEqual(JSON.parse(body), { synthetic: true }); resolve(); }
              catch (error) { reject(error); }
            });
          });
          client.on('error', reject);
          client.setTimeout(3000, () => client.destroy(new Error('Compressed request did not finish')));
          client.write(first);
        });
        const health = await fetch('http://127.0.0.1:' + port, { signal: AbortSignal.timeout(3000) });
        assert.equal(await health.text(), 'healthy');
        console.log('Compressed request completed; server remains healthy');
      } catch (error) { console.error(error); process.exitCode = 1; }
      finally { server.close(); server.closeAllConnections(); }
    });
  `;
  const result = await run(process.execPath, ['-e', script], {
    cwd: require('node:path').resolve(__dirname, '../..'), timeout: 10000,
  });
  expect(result.stdout).toContain('Compressed request completed; server remains healthy');
});

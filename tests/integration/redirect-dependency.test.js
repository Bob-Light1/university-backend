'use strict';

/** @file redirect-dependency.test.js @description Real loopback credential stripping through the patched redirect dependency. */
const nativeHttp = require('node:http');
const { http } = require('follow-redirects');
let source;
let destination;

/** Listen only on loopback and reject immediately on an owned listener failure. */
const listen = (server) => new Promise((resolve, reject) => {
  server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
});

beforeAll(async () => {
  destination = nativeHttp.createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(request.headers));
  });
  await listen(destination);
  source = nativeHttp.createServer((_request, response) => {
    response.writeHead(302, { Location: `http://127.0.0.1:${destination.address().port}/destination` }); response.end();
  });
  await listen(source);
});
afterAll(async () => Promise.all([source, destination].map((server) => new Promise((resolve) => server.close(resolve)))));

/** Follow a cross-host redirect and read the actual destination's received headers. */
const redirected = (headers, sensitiveHeaders) => new Promise((resolve, reject) => {
  const request = http.get(`http://localhost:${source.address().port}/source`, { family: 4, headers, sensitiveHeaders }, (response) => {
    let body = ''; response.on('data', (chunk) => { body += chunk; });
    response.on('end', () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } });
  });
  request.on('error', reject);
});

test('array-form headers strip credentials while preserving an ordinary header across hosts', async () => {
  const headers = await redirected(['Authorization', 'synthetic-auth', 'Cookie', 'synthetic-cookie', 'X-Ordinary', 'keep']);
  expect(headers.authorization).toBeUndefined(); expect(headers.cookie).toBeUndefined(); expect(headers['x-ordinary']).toBe('keep');
});

test('custom sensitive header names containing regular-expression characters are stripped', async () => {
  const headers = await redirected({ 'X^Private': 'synthetic-secret', 'X|Private': 'synthetic-secret', 'X-Ordinary': 'keep' }, ['X^Private', 'X|Private']);
  expect(headers['x^private']).toBeUndefined(); expect(headers['x|private']).toBeUndefined(); expect(headers['x-ordinary']).toBe('keep');
});

'use strict';
/** @file ai.gateway-stream.test.js
 * @description A real HTTP disconnect must abort the AI gateway's upstream stream.
 */
const express = require('express');
const http = require('node:http');
const { once } = require('node:events');

jest.mock('../../modules/ai/ai.service', () => ({ forward: jest.fn() }));
jest.mock('../../modules/settings', () => ({ service: { getPreferredLanguage: jest.fn(async () => 'en') } }));
const aiService = require('../../modules/ai/ai.service');
const { chat } = require('../../modules/ai/ai.controller');

it('aborts the upstream after the completed POST request loses its response connection', async () => {
  let streamController;
  const body = new ReadableStream({ start(controller) {
    streamController = controller;
    controller.enqueue(new TextEncoder().encode('event: delta\ndata: {"text":"first token"}\n\n'));
  } });
  let aborted;
  const signal = new Promise(resolve => { aborted = resolve; });
  const abort = jest.fn(() => { aborted(); streamController.close(); });
  aiService.forward.mockResolvedValue({ response: new Response(body, {
    headers: { 'content-type': 'text/event-stream' },
  }), abort });
  const app = express(); app.use(express.json());
  app.post('/chat', (req, res, next) => {
    req.user = { id: 'synthetic-user', role: 'CAMPUS_MANAGER' };
    req.aiCampusId = 'synthetic-campus'; req.aiEntitlement = {};
    next();
  }, chat);
  const server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const client = new AbortController();
  let timer;
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Synthetic cancellation regression' }), signal: client.signal,
    });
    expect(response.status).toBe(200);
    expect(new TextDecoder().decode((await response.body.getReader().read()).value)).toContain('first token');
    client.abort();
    const observed = await Promise.race([signal.then(() => true),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), 1000); })]);
    expect(observed).toBe(true);
    expect(abort).toHaveBeenCalledTimes(1);
  } finally {
    clearTimeout(timer); client.abort();
    if (!abort.mock.calls.length) streamController.close();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
});

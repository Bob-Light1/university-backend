'use strict';
/** @file ai.frontend-stream.test.js
 * @description Execute the actual SPA chat transport to verify terminal SSE behavior.
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { TextDecoder, TextEncoder } = require('node:util');
const file = path.resolve(__dirname, '../../../frontend/src/services/aiService.js');

/** Load the consumer transport with browser adapters, without copying its parser. */
function load(reader) {
  const source = fs.readFileSync(file, 'utf8').replace(/^import .*;$/gm, '').replace(/\bexport /g, '');
  const fetch = jest.fn(async () => ({ ok: true, headers: { get: () => 'text/event-stream' },
    body: { getReader: () => reader } }));
  const { streamAiChat } = vm.runInNewContext(`${source}\n;({ streamAiChat });`, {
    fetch, AbortController, TextDecoder, URLSearchParams, API_BASE_URL: '/api',
    getAccessToken: async () => 'synthetic-token', api: {},
  }, { filename: file });
  return { streamAiChat, fetch };
}

/** Supply event bytes followed by EOF. */
function finiteReader(events) {
  let sent = false;
  return { read: async () => {
    if (sent) return { done: true };
    sent = true;
    return { done: false, value: new TextEncoder().encode(events) };
  } };
}

(fs.existsSync(file) ? describe : describe.skip)('SPA AI SSE lifecycle', () => {
  test('citation source types mirror the server-owned contract', () => {
    const constants = path.resolve(path.dirname(file), '../components/ai/aiConstants.js');
    const source = fs.readFileSync(constants, 'utf8').replace(/\bexport /g, '');
    const mirrored = vm.runInNewContext(`${source}\n;AI_SOURCE_TYPES;`, {}, { filename: constants });
    expect({ ...mirrored }).toEqual(require('../../shared/constants/ai.constants').AI_SOURCE_TYPES);
  });

  test.each([
    ['empty stream', ''],
    ['metadata only', 'event: message_start\ndata: {"conversationId":"owned"}\n\n'],
    ['partial answer', 'event: delta\ndata: {"text":"Partial"}\n\n'],
  ])('%s reports unfinished generation instead of leaving the UI busy', async (_label, events) => {
    const { streamAiChat } = load(finiteReader(events));
    const onError = jest.fn(), onDone = jest.fn();
    await streamAiChat({ message: 'Synthetic question' }, { onError, onDone }).finished;
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'STREAM' }));
    expect(onDone).not.toHaveBeenCalled();
  });

  test.each([
    ['done', 'event: done\ndata: {"usage":{"tokensOut":1}}\n\n', 1, 0],
    ['error', 'event: error\ndata: {"code":"UPSTREAM_TIMEOUT","message":"Synthetic timeout"}\n\n', 0, 1],
  ])('%s remains the only terminal outcome', async (_label, events, doneCount, errorCount) => {
    const { streamAiChat } = load(finiteReader(events));
    const onError = jest.fn(), onDone = jest.fn();
    await streamAiChat({ message: 'Synthetic question' }, { onError, onDone }).finished;
    expect(onDone).toHaveBeenCalledTimes(doneCount);
    expect(onError).toHaveBeenCalledTimes(errorCount);
  });

  test('an explicit stop cancels the pending read without an error banner', async () => {
    let rejectRead;
    const reader = { read: () => new Promise((_resolve, reject) => { rejectRead = reject; }) };
    const { streamAiChat, fetch } = load(reader);
    const onError = jest.fn(), onDone = jest.fn();
    const stream = streamAiChat({ message: 'Synthetic question' }, { onError, onDone });
    await new Promise(resolve => setImmediate(resolve));
    const signal = fetch.mock.calls[0][1].signal;
    signal.addEventListener('abort', () => rejectRead(Object.assign(new Error('Stopped'), { name: 'AbortError' })));
    stream.abort();
    await stream.finished;
    expect(signal.aborted).toBe(true);
    expect(onError).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });
});

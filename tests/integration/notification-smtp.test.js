'use strict';
/**
 * @file notification-smtp.test.js
 * @description Exercise the actual Nodemailer notification channel against an owned
 * loopback SMTP peer. No external delivery, credentials, or mocked transport.
 */
const net = require('node:net');
const config = require('../../shared/configs/general.config');
const channel = require('../../modules/notification/channels/email.channel');

let server;
let originalSmtp;
let originalEmail;
let rejectRecipient = false;
const messages = [];
const sockets = new Set();

beforeAll(async () => {
  originalSmtp = config.notification.smtp;
  originalEmail = config.email;
  server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.write('220 fixture.test ESMTP\r\n');
    let buffer = '';
    let inData = false;
    let message = [];
    socket.on('data', chunk => {
      buffer += chunk.toString();
      let end;
      while ((end = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        if (inData) {
          if (line !== '.') { message.push(line); continue; }
          messages.push(message.join('\r\n')); message = []; inData = false;
          socket.write('250 queued\r\n');
        } else if (/^EHLO /.test(line)) socket.write('250-fixture.test\r\n250 AUTH PLAIN\r\n');
        else if (/^AUTH /.test(line)) socket.write('235 authenticated\r\n');
        else if (/^RCPT TO:/.test(line) && rejectRecipient) socket.write('550 recipient rejected\r\n');
        else if (line === 'DATA') { inData = true; socket.write('354 end with dot\r\n'); }
        else if (line === 'QUIT') socket.end('221 bye\r\n');
        else socket.write('250 OK\r\n');
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  config.notification.smtp = { host: '127.0.0.1', port: server.address().port,
    secure: false, user: 'fixture', password: 'local-only-synthetic' };
  config.email = { from: 'sender@fixture.test', fromName: 'Fixture ERP' };
  channel._reset();
});
afterAll(async () => {
  channel._reset();
  config.notification.smtp = originalSmtp; config.email = originalEmail;
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => server.close(resolve));
});

test('real SMTP transport sends UTF-8 content with the configured sender', async () => {
  expect(channel.isConfigured()).toBe(true);
  await expect(channel.send({ to: 'recipient@fixture.test', subject: 'Fixture receipt', body: 'Payment received — merci.' })).resolves.toEqual({ ok: true });
  expect(messages).toHaveLength(1);
  expect(messages[0]).toContain('From: Fixture ERP <sender@fixture.test>');
  expect(messages[0]).toContain('To: recipient@fixture.test');
  expect(messages[0]).toContain('Subject: Fixture receipt');
  expect(messages[0]).toContain('charset=utf-8');
  expect(messages[0]).toMatch(/Payment received|UGF5bWVudCByZWNlaXZlZA/);
});
test('SMTP rejection reaches the caller so retry policy can act', async () => {
  rejectRecipient = true;
  await expect(channel.send({ to: 'rejected@fixture.test', subject: 'Fixture rejection', body: 'Synthetic.' })).rejects.toMatchObject({ code: 'EENVELOPE', responseCode: 550 });
  expect(messages).toHaveLength(1);
});

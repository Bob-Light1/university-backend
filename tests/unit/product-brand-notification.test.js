'use strict';

/**
 * @file product-brand-notification.test.js
 * @description Brand labels never invent an email sender or inject notification HTML.
 */
const mockSend = jest.fn().mockResolvedValue({});
jest.mock('resend', () => ({ Resend: jest.fn().mockImplementation(() => ({ emails: { send: mockSend } })) }), { virtual: true });
jest.mock('../../modules/public-portal/public-portal.repository', () => ({}));
const { sendWinnerEmail } = require('../../modules/public-portal/notification.service');
const originalEnv = { ...process.env };
beforeEach(() => { mockSend.mockClear(); process.env.RESEND_API_KEY = 'synthetic-test-key'; });
afterEach(() => { process.env = { ...originalEnv }; });

test('a configured API key without an explicit sender skips delivery', async () => {
  delete process.env.RESEND_FROM_EMAIL;
  const result = await sendWinnerEmail({ toEmail: 'winner@example.test', brandName: 'Example' });
  expect(result).toBe(false);
  expect(mockSend).not.toHaveBeenCalled();
});

test('custom brand is rendered as text and sender is preserved', async () => {
  process.env.RESEND_FROM_EMAIL = 'notifications@example.test';
  await sendWinnerEmail({ toEmail: 'winner@example.test', firstName: 'Example', rank: '1', brandName: 'Atlas <Academy>', period: '2026-09', lang: 'en' });
  const message = mockSend.mock.calls[0][0];
  expect(message.from).toBe('notifications@example.test');
  expect(message.subject).toContain('Atlas <Academy>');
  expect(message.html).toContain('Atlas &lt;Academy&gt;');
  expect(message.html).not.toContain('<Academy>');
});

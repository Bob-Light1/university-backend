'use strict';

/** @file admission-files.test.js @description Real PDF/image normalization and HTTP download regressions. */
jest.mock('../../modules/document/services/document.storage.local', () => ({
  name: 'local', put: jest.fn(), remove: jest.fn().mockResolvedValue(true),
  openStream: jest.fn(() => require('node:stream').Readable.from(Buffer.from('synthetic private bytes'))),
}));
jest.mock('../../shared/utils/storage-provider', () => ({ STORAGE_PROVIDER: { LOCAL: 'local', CLOUDINARY: 'cloudinary' }, resolveStorageProvider: () => 'local' }));
const request = require('supertest');
const express = require('express');
const sharp = require('sharp');
const { PDFDocument } = require('pdf-lib');
const service = require('../../modules/document/services/admission-storage.service');

test('normalizes a real JPEG and rejects malformed image content instead of keeping it', async () => {
  const bytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: 'white' } }).jpeg().toBuffer();
  const normalized = await service.normalizeAdmissionFile({ buffer: bytes, mimetype: 'image/jpeg', originalname: 'synthetic.jpg' });
  expect((await sharp(normalized.buffer).metadata()).format).toBe('jpeg');
  await expect(service.normalizeAdmissionFile({ buffer: Buffer.from([0xff, 0xd8, 0xff, 1]), mimetype: 'image/jpeg' })).rejects.toMatchObject({ statusCode: 422 });
});

test('normalizes passive PDFs and refuses active dictionaries and malformed data', async () => {
  const pdf = await PDFDocument.create(); pdf.addPage();
  const passive = await service.normalizeAdmissionFile({ buffer: Buffer.from(await pdf.save()), mimetype: 'application/pdf', originalname: 'synthetic.pdf' });
  expect((await PDFDocument.load(passive.buffer)).getPageCount()).toBe(1);
  pdf.addJavaScript('synthetic', 'app.alert("synthetic")');
  await expect(service.normalizeAdmissionFile({ buffer: Buffer.from(await pdf.save()), mimetype: 'application/pdf' })).rejects.toMatchObject({ statusCode: 422 });
  await expect(service.normalizeAdmissionFile({ buffer: Buffer.from('%PDF-invalid'), mimetype: 'application/pdf' })).rejects.toMatchObject({ statusCode: 422 });
});

test('repairs browser multipart UTF-8 filenames without corrupting native Unicode or Latin-1 names', async () => {
  const pdf = await PDFDocument.create(); pdf.addPage(); const buffer = Buffer.from(await pdf.save());
  for (const originalname of ['学籍.pdf', Buffer.from('学籍.pdf', 'utf8').toString('latin1')]) {
    expect((await service.normalizeAdmissionFile({ buffer, originalname, mimetype: 'application/pdf' })).originalName).toBe('学籍.pdf');
  }
  expect((await service.normalizeAdmissionFile({ buffer, originalname: 'élève.pdf', mimetype: 'application/pdf' })).originalName).toBe('élève.pdf');
});

test('private HTTP downloads retain Unicode filenames and disallow browser caching', async () => {
  const app = express();
  app.get('/file', async (_req, res, next) => {
    try { await service.streamAdmissionFile({ schoolCampus: 'campus-a', fileName: 'synthetic.pdf', originalName: '学籍.pdf' }, res); } catch (error) { next(error); }
  });
  const response = await request(app).get('/file');
  expect(response.status).toBe(200);
  expect(response.headers['cache-control']).toBe('private, no-store');
  expect(response.headers['content-disposition']).toContain("filename*=UTF-8''" + encodeURIComponent('学籍.pdf'));
  expect(response.headers['content-type']).toContain('application/pdf');
});

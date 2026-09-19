'use strict';

/**
 * @file product-brand.test.js
 * @description Deployment brand behavior, real workbook metadata and public URL validation.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ExcelJS = require('exceljs');
const ExportService = require('../../shared/services/export.service');
const { getProductName, getPortalBrandName } = require('../../shared/configs/brand.config');
const originalEnv = { ...process.env };

afterEach(() => { process.env = { ...originalEnv }; });

test('default product and existing establishment overrides remain distinct', () => {
  delete process.env.PRODUCT_BRAND_NAME;
  delete process.env.BRAND_NAME;
  delete process.env.NEXT_PUBLIC_BRAND_NAME;
  expect(getProductName()).toBe('Wewigo');
  process.env.PRODUCT_BRAND_NAME = '  Atlas Education  ';
  expect(getProductName()).toBe('Atlas Education');
  expect(getPortalBrandName()).toBe('Atlas Education');
  process.env.NEXT_PUBLIC_BRAND_NAME = 'Campus Example';
  expect(getPortalBrandName()).toBe('Campus Example');
  process.env.BRAND_NAME = 'Institution Example';
  expect(getPortalBrandName()).toBe('Institution Example');
  expect(getProductName()).toBe('Atlas Education');
});

test('a real XLSX carries the configured software identity without changing its data', async () => {
  process.env.PRODUCT_BRAND_NAME = 'Atlas Education';
  const service = new ExportService({}, { name: 'Record', columns: [{ header: 'Reference', key: 'reference' }] });
  jest.spyOn(service, 'buildFilter').mockReturnValue({});
  jest.spyOn(service, 'fetchEntities').mockResolvedValue([{ reference: 'SYNTHETIC-001' }]);
  const result = await service.exportToExcel({}, {});
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(result.data);
  expect(workbook.creator).toBe('Atlas Education');
  expect(workbook.worksheets[0].getCell('A2').value).toBe('SYNTHETIC-001');
});

/** Execute the actual sibling frontend resolver, replacing only its bundler syntax. */
function loadPublicBrand() {
  const file = path.resolve(__dirname, '../../../frontend/src/config/brand.js');
  const source = fs.readFileSync(file, 'utf8').replace('import.meta.env', '({})').replace(/export /g, '');
  return vm.runInNewContext(`${source}\n({ resolveBrand, publicUrl });`, { URL });
}

test('public brand resolves booking, mail and the no-contact case without unsafe links', () => {
  const { resolveBrand, publicUrl } = loadPublicBrand();
  expect(resolveBrand().name).toBe('Wewigo');
  expect(resolveBrand().salesHref).toBe('');
  expect(resolveBrand({ VITE_SALES_EMAIL: 'sales@example.test' }).salesHref).toBe('mailto:sales@example.test');
  expect(resolveBrand({ VITE_SALES_URL: 'https://example.test/demo', VITE_SALES_EMAIL: 'sales@example.test' }).salesHref).toBe('https://example.test/demo');
  expect(resolveBrand({ VITE_SALES_URL: 'javascript:alert(1)', VITE_SALES_EMAIL: 'x@example.test?bcc=other' }).salesHref).toBe('');
  expect(resolveBrand({ VITE_BRAND_NAME: '  Atlas  ', VITE_BRAND_LOGO_URL: '/atlas.svg' }).name).toBe('Atlas');
  expect(publicUrl('https://user:password@example.test')).toBe('');
  expect(publicUrl('//example.test/logo.svg', true)).toBe('');
  expect(publicUrl('/logo.svg', true)).toBe('/logo.svg');
});

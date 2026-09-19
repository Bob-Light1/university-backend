'use strict';

/**
 * @file product-brand.test.js
 * @description Backend deployment brand precedence, fallbacks and real workbook metadata.
 */
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

test.each(['', '   ', undefined])('blank product brand %p uses the default identity', (value) => {
  if (value === undefined) delete process.env.PRODUCT_BRAND_NAME;
  else process.env.PRODUCT_BRAND_NAME = value;
  delete process.env.BRAND_NAME;
  delete process.env.NEXT_PUBLIC_BRAND_NAME;
  expect(getProductName()).toBe('Wewigo');
  expect(getPortalBrandName()).toBe('Wewigo');
});

test('blank establishment overrides fall through to the next configured identity', () => {
  process.env.PRODUCT_BRAND_NAME = '  Atlas Education  ';
  process.env.BRAND_NAME = '   ';
  process.env.NEXT_PUBLIC_BRAND_NAME = '  Campus Example  ';
  expect(getPortalBrandName()).toBe('Campus Example');
  process.env.NEXT_PUBLIC_BRAND_NAME = '   ';
  expect(getPortalBrandName()).toBe('Atlas Education');
  expect(getProductName()).toBe('Atlas Education');
});

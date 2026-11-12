// Builds the PDFs the end-to-end test opens. Run by tests/run.mjs.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { PDFDocument, PDFName, PDFHexString, StandardFonts, rgb } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const createQpdf = require('@neslinesli93/qpdf-wasm');
const { dropTables } = await import('../src/sfnt.js');

const nanum = () => dropTables(new Uint8Array(readFileSync(require.resolve('@expo-google-fonts/nanum-gothic/400Regular/NanumGothic_400Regular.ttf'))), ['GPOS', 'GSUB']);

export async function qpdf(args, input) {
  const q = await createQpdf({ locateFile: () => require.resolve('@neslinesli93/qpdf-wasm/dist/qpdf.wasm'), print() {}, printErr() {} });
  q.FS.writeFile('/in.pdf', input);
  const code = q.callMain([...args, '/in.pdf', '/out.pdf']);
  if (code !== 0 && code !== 3) throw new Error(`qpdf ${args.join(' ')} failed: ${code}`);
  return q.FS.readFile('/out.pdf');
}

/** A two-page contract with form fields, a bookmark and document info. */
async function formsPdf() {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  doc.setTitle('Test Contract');
  doc.setAuthor('Fixture');
  const ko = await doc.embedFont(nanum(), { subset: false });
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const p1 = doc.addPage([595, 842]);
  p1.drawText('계약서 테스트', { x: 60, y: 770, size: 26, font: ko });
  p1.drawText('이름:', { x: 60, y: 700, size: 14, font: ko });
  p1.drawText('동의:', { x: 60, y: 650, size: 14, font: ko });
  p1.drawText('구분:', { x: 60, y: 600, size: 14, font: ko });
  p1.drawText('지역:', { x: 60, y: 550, size: 14, font: ko });
  p1.drawText('서명:', { x: 60, y: 300, size: 14, font: ko });
  const form = doc.getForm();
  form.createTextField('name').addToPage(p1, { x: 120, y: 692, width: 220, height: 26 });
  form.createCheckBox('agree').addToPage(p1, { x: 120, y: 645, width: 18, height: 18 });
  const radio = form.createRadioGroup('kind');
  radio.addOptionToPage('person', p1, { x: 120, y: 595, width: 16, height: 16 });
  radio.addOptionToPage('company', p1, { x: 200, y: 595, width: 16, height: 16 });
  const dd = form.createDropdown('city');
  dd.addOptions(['Seoul', 'Busan', 'Daegu']);
  dd.addToPage(p1, { x: 120, y: 542, width: 140, height: 24 });

  const p2 = doc.addPage([595, 842]);
  p2.drawText('The quick brown fox jumps over the lazy dog.', { x: 60, y: 760, size: 16, font: helv });
  p2.drawText('Second line for highlighting tests.', { x: 60, y: 735, size: 16, font: helv });
  p2.drawText('한글 검색 문장입니다', { x: 60, y: 700, size: 16, font: ko });

  // One bookmark pointing at page 2.
  const ctx = doc.context;
  const outlinesRef = ctx.nextRef();
  const itemRef = ctx.nextRef();
  ctx.assign(itemRef, ctx.obj({ Title: PDFHexString.fromText('둘째 쪽'), Parent: outlinesRef, Dest: [p2.ref, 'XYZ', null, null, null] }));
  ctx.assign(outlinesRef, ctx.obj({ Type: 'Outlines', First: itemRef, Last: itemRef, Count: 1 }));
  doc.catalog.set(PDFName.of('Outlines'), outlinesRef);
  return doc.save();
}

/** Three pages whose MediaBox and Resources are inherited from the page tree root. */
async function inheritPdf() {
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.HelveticaBold);
  const labels = ['PAGE-ONE', 'PAGE-TWO-SECRET', 'PAGE-THREE'];
  for (const label of labels) {
    const p = doc.addPage([400, 300]);
    p.drawText(label, { x: 40, y: 140, size: 28, font: helv, color: rgb(0, 0, 0) });
  }
  const saved = await doc.save({ useObjectStreams: false });
  const d2 = await PDFDocument.load(saved);
  const root = d2.catalog.Pages();
  const pages = d2.getPages();
  const res = pages[0].node.get(PDFName.of('Resources'));
  root.set(PDFName.of('MediaBox'), pages[0].node.get(PDFName.of('MediaBox')));
  root.set(PDFName.of('Resources'), d2.context.lookup(res));
  for (const p of pages) {
    p.node.delete(PDFName.of('MediaBox'));
    // Pages 2 and 3 keep their own resources so the inherited one is only used by page 1.
    if (p === pages[0]) p.node.delete(PDFName.of('Resources'));
  }
  return d2.save({ useObjectStreams: false });
}

async function simplePdf(text) {
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const p = doc.addPage([400, 300]);
  p.drawText(text, { x: 40, y: 150, size: 22, font: helv });
  return doc.save();
}

/** An image-only page (like a scan): no text layer. */
async function scanPdf(browser) {
  const page = await browser.newPage();
  const png = await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 1240;
    c.height = 600;
    const g = c.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = '#111';
    g.font = '64px sans-serif';
    g.fillText('INVOICE NUMBER 12345', 60, 160);
    g.fillText('Total amount due', 60, 300);
    g.fillText('Thank you', 60, 440);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    return [...new Uint8Array(await blob.arrayBuffer())];
  });
  await page.close();
  const doc = await PDFDocument.create();
  const img = await doc.embedPng(new Uint8Array(png));
  const p = doc.addPage([595, 288]);
  p.drawImage(img, { x: 0, y: 0, width: 595, height: 288 });
  return doc.save();
}

export async function buildFixtures(dir, browser) {
  mkdirSync(dir, { recursive: true });
  const files = {
    forms: await formsPdf(),
    inherit: await inheritPdf(),
    extra: await simplePdf('Appended page'),
    scan: await scanPdf(browser),
  };
  files.encrypted = await qpdf(['--encrypt', '1234', 'owner-pw', '256', '--'], await simplePdf('Locked content'));
  files.restricted = await qpdf(['--encrypt', '', 'owner-pw', '256', '--print=none', '--modify=none', '--'], await simplePdf('Restricted content'));
  const paths = {};
  for (const [k, v] of Object.entries(files)) {
    paths[k] = join(dir, `${k}.pdf`);
    writeFileSync(paths[k], v);
  }
  return paths;
}

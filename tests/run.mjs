// End-to-end test: drives the built app in a phone-sized browser with touch,
// saves the result and checks the saved PDF with pdf-lib and PDF.js.
//
//   npm run build && npm test
//
// Needs Playwright with Chromium (`npm i -D playwright && npx playwright install chromium`
// if it is not already available). Screenshots go to test-results/.
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFixtures, qpdf } from './fixtures.mjs';
import { serve } from './server.mjs';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');
const { PDFDocument, PDFName } = require('pdf-lib');
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'test-results');
mkdirSync(out, { recursive: true });

let failures = 0;
const check = (cond, msg) => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`);
  if (!cond) failures++;
};
const step = (name) => console.log(`\n▶ ${name}`);

const { server, url } = await serve(join(root, 'dist'));
const browser = await chromium.launch();
const fx = await buildFixtures(join(out, 'fixtures'), browser);

const pdfText = async (bytes) => {
  const doc = await pdfjs.getDocument({ data: bytes.slice(), standardFontDataUrl: join(root, 'node_modules/pdfjs-dist/standard_fonts/') }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const p = await doc.getPage(i);
    const tc = await p.getTextContent();
    pages.push({
      text: tc.items.map((it) => it.str).join(' '),
      annots: await p.getAnnotations(),
      ops: (await p.getOperatorList()).fnArray,
    });
  }
  return pages;
};

const ctx = await browser.newContext({ ...devices['iPhone 13'], acceptDownloads: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => { errors.push(e.message); console.log(`    [pageerror] ${e.message}`); });
page.on('console', (m) => { if (m.type() === 'error') { errors.push(m.text()); console.log(`    [console] ${m.text()}`); } });
const cdp = await ctx.newCDPSession(page);
const app = () => page.evaluate(() => {
  const { state } = window.__pdfEditor;
  return { scale: state.scale, current: state.current, pages: state.pages.map((p) => ({ src: p.src, rotation: p.rotation, ann: p.annotations.map((a) => ({ type: a.type, kind: a.kind, text: a.text, quads: a.quads?.length })), ocr: p.ocr?.words.length })) };
});
const shot = (name) => page.screenshot({ path: join(out, `${name}.png`) });
const button = (name) => page.getByRole('button', { name, exact: true });
const sheetButton = (name) => page.locator('.sheet-wrap.open .sheet').getByRole('button', { name, exact: true });

/** Screen position of a point given in PDF points from the page's top-left, scrolled into view. */
async function pagePoint(index, x, y) {
  const s = (await app()).scale;
  await page.evaluate(({ index, y, s }) => {
    const v = document.getElementById('viewer');
    const el = document.querySelectorAll('.page')[index];
    v.scrollTop = el.offsetTop + y * s - v.clientHeight / 2;
  }, { index, y, s });
  await page.waitForTimeout(100);
  const box = await page.locator('.page').nth(index).boundingBox();
  return { x: box.x + x * s, y: box.y + y * s };
}
/** Waits (up to 10 s) for a condition evaluated in the page. */
const until = (fn) => page.waitForFunction(fn, null, { timeout: 10_000 }).then(() => true, () => false);
const sheetOpen = async () => {
  await page.waitForSelector('.sheet-wrap.open');
  await page.waitForTimeout(300); // slide-in animation
};
async function touch(type, points) {
  await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map((p, i) => ({ x: p.x, y: p.y, id: i })) });
}
async function touchDrag(from, to, steps = 12) {
  await touch('touchStart', [from]);
  for (let i = 1; i <= steps; i++) await touch('touchMove', [{ x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps }]);
  await touch('touchEnd', []);
}
async function tap(p) {
  await page.touchscreen.tap(p.x, p.y);
}
async function gotoPage(n) {
  await page.locator('#page-pill').click();
  await page.locator('.sheet-wrap.open input').fill(String(n));
  await sheetButton('이동').click();
  await page.waitForTimeout(300);
}
async function download(trigger) {
  const [dl] = await Promise.all([page.waitForEvent('download'), trigger()]);
  return new Uint8Array(readFileSync(await dl.path()));
}
async function saveViaMenu() {
  await page.locator('#btn-share').click();
  return download(() => page.locator('.menu-item[data-value="download"]').click());
}
const waitIdle = () => page.waitForSelector('#busy', { state: 'hidden', timeout: 180_000 });

try {
  // -------------------------------------------------------------------------
  step('PDF 열기 (입력 칸 있는 계약서)');
  await page.goto(`${url}?debug`);
  await page.evaluate(() => indexedDB.deleteDatabase('pdf-editor'));
  await page.reload();
  await page.setInputFiles('#file-open', fx.forms);
  await page.waitForSelector('.page-canvas');
  await page.waitForSelector('.annotationLayer input[type=text]');
  check((await app()).pages.length === 2, '2쪽이 열림');
  await shot('01-phone-open');

  step('입력 칸 채우기');
  await page.locator('.annotationLayer input[type=text]').first().fill('홍길동 Hong');
  await page.locator('.annotationLayer input[type=checkbox]').first().check();
  await page.locator('.annotationLayer input[type=radio]').nth(1).check();
  await page.locator('.annotationLayer select').first().selectOption('Busan');
  await page.locator('.annotationLayer input[type=text]').first().blur();

  step('텍스트 추가 (터치)');
  await button('편집').click();
  await page.locator('[data-tool="text"]').click();
  await tap(await pagePoint(0, 120, 400));
  await page.waitForSelector('.text-editor');
  await page.keyboard.type('테스트 글자');
  await page.keyboard.press('Escape');
  check((await app()).pages[0].ann.some((a) => a.type === 'text' && a.text === '테스트 글자'), '텍스트 개체가 생김');

  step('기존 글자 수정');
  await page.locator('[data-tool="edittext"]').click();
  await tap(await pagePoint(0, 80, 66));
  await page.waitForSelector('.text-editor');
  await page.keyboard.type('수정된 제목');
  await page.keyboard.press('Escape');
  const edited = (await app()).pages[0].ann;
  check(edited.some((a) => a.kind === 'whiteout') && edited.some((a) => a.text === '수정된 제목'), '원래 글자를 가리고 새 글자를 씀');

  step('펜 그리기 (손가락)');
  await page.locator('[data-tool="ink"]').click();
  await touchDrag(await pagePoint(0, 300, 600), await pagePoint(0, 450, 650));
  check((await app()).pages[0].ann.some((a) => a.type === 'ink'), '펜 선이 그려짐');

  step('두 손가락 확대');
  const before = (await app()).scale;
  const c = await pagePoint(0, 300, 300);
  await touch('touchStart', [{ x: c.x - 40, y: c.y }, { x: c.x + 40, y: c.y }]);
  for (let i = 1; i <= 10; i++) await touch('touchMove', [{ x: c.x - 40 - i * 8, y: c.y }, { x: c.x + 40 + i * 8, y: c.y }]);
  await touch('touchEnd', []);
  await page.waitForTimeout(300);
  const after = (await app()).scale;
  check(after > before * 1.5, `확대됨 (${before.toFixed(2)} → ${after.toFixed(2)})`);
  check((await app()).pages[0].ann.filter((a) => a.type === 'ink').length === 1, '확대 중에 선이 그려지지 않음');
  await button('보기').click();
  await page.getByRole('button', { name: /폭 맞춤/ }).click();

  step('서명 그리기');
  await gotoPage(1);
  await button('서명').click();
  await page.getByRole('button', { name: /서명 그리기/ }).click();
  await sheetOpen();
  const pad = await page.locator('.sign-canvas').boundingBox();
  await page.mouse.move(pad.x + 30, pad.y + 120);
  await page.mouse.down();
  for (let i = 0; i <= 20; i++) await page.mouse.move(pad.x + 30 + i * 12, pad.y + 120 + Math.sin(i / 2) * 40);
  await page.mouse.up();
  await sheetButton('서명 넣기').click();
  check(await until(() => window.__pdfEditor.state.pages.some((p) => p.annotations.some((a) => a.kind === 'signature'))), '서명이 페이지에 들어감');

  step('도장 만들기');
  await page.getByRole('button', { name: /도장 만들기/ }).click();
  await sheetOpen();
  await page.locator('.stamp-form input.field').fill('홍길동');
  await page.waitForTimeout(200);
  await shot('02-stamp-maker');
  await sheetButton('도장 넣기').click();
  check(await until(() => window.__pdfEditor.state.pages.some((p) => p.annotations.some((a) => a.kind === 'stamp'))), '도장이 페이지에 들어감');
  check(await until(() => document.querySelectorAll('.lib-item').length === 2), '서명·도장이 보관함에 저장됨');
  await shot('03-phone-signed');

  step('형광펜 · 밑줄 · 메모 (2쪽)');
  await gotoPage(2);
  await button('주석').click();
  await page.locator('[data-tool="highlight"]').click();
  const hlFrom = await pagePoint(1, 62, 76), hlTo = await pagePoint(1, 200, 78);
  await page.mouse.move(hlFrom.x, hlFrom.y);
  await page.mouse.down();
  await page.mouse.move(hlTo.x, hlTo.y, { steps: 8 });
  await page.mouse.up();
  await page.locator('[data-tool="underline"]').click();
  const ulFrom = await pagePoint(1, 62, 101), ulTo = await pagePoint(1, 250, 103);
  await page.mouse.move(ulFrom.x, ulFrom.y);
  await page.mouse.down();
  await page.mouse.move(ulTo.x, ulTo.y, { steps: 8 });
  await page.mouse.up();
  await page.locator('[data-tool="note"]').click();
  await tap(await pagePoint(1, 480, 90));
  await sheetOpen();
  await page.locator('.sheet-wrap.open textarea').fill('메모 내용 확인');
  await sheetButton('저장').click();
  const p2 = (await app()).pages[1].ann;
  check(p2.some((a) => a.kind === 'highlight' && a.quads === 1), '형광펜이 글자 줄에 맞춰짐');
  check(p2.some((a) => a.kind === 'underline'), '밑줄이 생김');
  check(p2.some((a) => a.type === 'note' && a.text === '메모 내용 확인'), '메모가 생김');
  await shot('04-phone-comments');

  step('검색');
  await page.locator('#btn-search').click();
  await page.locator('#search-input').fill('quick');
  await page.waitForFunction(() => document.getElementById('search-count').textContent === '1 / 1');
  check(true, '"quick" 1건');
  await page.locator('#search-input').fill('검색 문장');
  await page.waitForFunction(() => document.getElementById('search-count').textContent === '1 / 1');
  check(true, '띄어쓰기를 무시하고 한글 "검색 문장" 1건');
  await shot('05-phone-search');
  await page.locator('#search-close').click();

  step('자동 저장 → 새로고침 → 이어서 하기');
  await page.waitForTimeout(1200);
  const snapshot = await app();
  await page.reload();
  await page.waitForSelector('#restore-card:not([hidden])');
  await shot('06-phone-restore');
  await page.getByRole('button', { name: '이어서 하기' }).click();
  await page.waitForSelector('.annotationLayer input[type=text]');
  const restored = await app();
  check(JSON.stringify(restored.pages.map((p) => p.ann)) === JSON.stringify(snapshot.pages.map((p) => p.ann)), '편집 내용이 그대로 복원됨');
  check(await page.locator('.annotationLayer input[type=text]').first().inputValue() === '홍길동 Hong', '입력 칸 값도 복원됨');
  check(await page.locator('#doc-title').evaluate((el) => el.classList.contains('dirty')), '저장 안 된 상태로 표시됨');

  step('페이지 작업: 빈 페이지, 회전, PDF 추가, 순서 변경');
  await button('페이지').click();
  await gotoPage(2);
  await page.locator('#toolbar').getByRole('button', { name: '빈 페이지' }).click();
  await page.locator('#toolbar').getByRole('button', { name: '오른쪽 회전' }).click();
  await page.setInputFiles('#file-append', fx.extra);
  await page.waitForFunction(() => window.__pdfEditor.state.pages.length === 4);
  await page.locator('#toolbar').getByRole('button', { name: '페이지 목록' }).click();
  await page.waitForTimeout(300);
  await shot('07-phone-pages');
  // Long-press the last thumbnail and drag it before the third.
  const thumbs = page.locator('.thumb');
  const last = await thumbs.nth(3).boundingBox();
  const third = await thumbs.nth(2).boundingBox();
  await page.mouse.move(last.x + last.width / 2, last.y + last.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(450);
  await page.mouse.move(third.x + 6, third.y + third.height / 2, { steps: 6 });
  await page.mouse.up();
  await page.locator('#panel-close').click();
  const order = (await app()).pages;
  check(order.length === 4 && order[2].src === 1 && order[3].src === null && order[3].rotation === 90, '추가한 PDF가 3쪽으로, 회전된 빈 페이지가 4쪽으로 이동');

  step('저장 (다운로드)');
  const saved = await saveViaMenu();
  check(saved.length > 1000, `저장 파일 ${saved.length} bytes`);
  check(!(await page.locator('#doc-title').evaluate((el) => el.classList.contains('dirty'))), '저장 후 "저장 안 됨" 표시가 사라짐');

  step('저장된 PDF 검사 (pdf-lib)');
  check(new TextDecoder().decode(saved.subarray(0, 8)).startsWith('%PDF-1.7'), 'PDF 1.7 형식');
  const doc = await PDFDocument.load(saved);
  check(doc.getPageCount() === 4, '4쪽');
  check(doc.getPage(3).getRotation().angle === 90, '4쪽 회전 90°');
  check(doc.getTitle() === 'Test Contract', '문서 제목(정보) 유지');
  check(!!doc.catalog.get(PDFName.of('Outlines')), '책갈피 유지');
  const form = doc.getForm();
  check(form.getTextField('name').getText() === '홍길동 Hong', '이름 칸 = 홍길동 Hong');
  check(form.getCheckBox('agree').isChecked(), '동의 체크됨');
  check(form.getRadioGroup('kind').getSelected() === 'company', '구분 = company');
  check(form.getDropdown('city').getSelected()[0] === 'Busan', '지역 = Busan');

  step('저장된 PDF 검사 (PDF.js)');
  const pages = await pdfText(saved);
  check(pages[0].text.includes('테스트 글자'), '1쪽에 추가한 글자가 실제 텍스트로 들어감');
  check(pages[0].text.includes('수정된 제목'), '1쪽에 고친 제목이 들어감');
  const imgs = pages[0].ops.filter((op) => op === pdfjs.OPS.paintImageXObject).length;
  check(imgs >= 2, `1쪽에 서명·도장 이미지 ${imgs}개`);
  const kinds = pages[1].annots.map((a) => a.subtype);
  check(kinds.includes('Highlight') && kinds.includes('Underline') && kinds.includes('Text'), `2쪽 표준 주석: ${kinds.join(', ')}`);
  check(pages[1].annots.find((a) => a.subtype === 'Text')?.contentsObj?.str === '메모 내용 확인', '메모 내용이 주석에 저장됨');
  check(pages[2].text.includes('Appended page'), '3쪽 = 추가한 PDF');

  step('저장한 PDF 다시 열기');
  await page.setInputFiles('#file-open', { name: 'saved.pdf', mimeType: 'application/pdf', buffer: Buffer.from(saved) });
  await page.waitForSelector('.annotationLayer input[type=text]');
  check(await page.locator('.annotationLayer input[type=text]').first().inputValue() === '홍길동 Hong', '다시 열어도 입력 칸 값 유지');
  check((await app()).pages.length === 4, '다시 열어도 4쪽');
  await shot('08-phone-reopened');

  // -------------------------------------------------------------------------
  step('비밀번호 PDF');
  await page.setInputFiles('#file-open', fx.encrypted);
  await page.locator('.sheet-wrap.open input[type=password]').fill('wrong');
  await sheetButton('열기').click();
  await page.waitForSelector('.sheet-wrap.open .field-label:has-text("틀렸습니다")', { timeout: 15000 });
  check(true, '틀린 비밀번호 안내');
  await page.locator('.sheet-wrap.open input[type=password]').fill('1234');
  await sheetButton('열기').click();
  await page.waitForFunction(() => document.getElementById('doc-title').textContent === 'encrypted.pdf');
  await page.waitForSelector('.page-canvas');
  const unlocked = await saveViaMenu();
  const unlockedDoc = await PDFDocument.load(unlocked);
  check(!unlockedDoc.isEncrypted, '저장 파일은 암호 없음');
  check((await pdfText(unlocked))[0].text.includes('Locked content'), '내용 유지');

  step('편집 제한 PDF (열기 비밀번호 없음)');
  await page.setInputFiles('#file-open', fx.restricted);
  await page.waitForFunction(() => document.getElementById('doc-title').textContent === 'restricted.pdf');
  check(await page.locator('.sheet-wrap.open').count() === 0, '비밀번호 없이 열림');

  step('페이지 삭제 · 순서 변경 (상속 속성 문서)');
  await page.setInputFiles('#file-open', fx.inherit);
  await page.waitForFunction(() => document.getElementById('doc-title').textContent === 'inherit.pdf');
  await button('페이지').click();
  await gotoPage(2);
  await page.locator('#toolbar').getByRole('button', { name: '페이지 삭제' }).click();
  await gotoPage(2);
  await page.locator('#toolbar').getByRole('button', { name: '페이지 목록' }).click();
  await page.locator('#panel-actions').getByRole('button', { name: /앞으로/ }).click();
  await page.locator('#panel-close').click();
  const trimmed = await saveViaMenu();
  const trimmedPages = await pdfText(trimmed);
  check(trimmedPages.map((p) => p.text.trim()).join(',') === 'PAGE-THREE,PAGE-ONE', `순서: ${trimmedPages.map((p) => p.text.trim()).join(', ')}`);
  const tdoc = await PDFDocument.load(trimmed);
  check(tdoc.getPages().every((p) => p.getWidth() === 400 && p.getHeight() === 300), '물려받던 페이지 크기 유지');
  const raw = new TextDecoder('latin1').decode(await qpdf(['--stream-data=uncompress', '--object-streams=disable'], trimmed));
  check(!raw.includes('PAGE-TWO-SECRET'), '삭제한 페이지 내용이 파일에서 제거됨');

  step('문자 인식 (OCR)');
  await page.setInputFiles('#file-open', fx.scan);
  await page.waitForFunction(() => document.getElementById('doc-title').textContent === 'scan.pdf');
  await page.waitForSelector('.page-canvas');
  await page.locator('#btn-menu').click();
  await page.locator('.menu-item[data-value="ocr"]').click();
  await sheetButton('시작').click();
  await page.waitForTimeout(500);
  await waitIdle();
  const words = (await app()).pages[0].ocr || 0;
  check(words >= 5, `인식한 단어 ${words}개`);
  await page.locator('#btn-search').click();
  await page.locator('#search-input').fill('invoice');
  await page.waitForFunction(() => document.getElementById('search-count').textContent === '1 / 1', null, { timeout: 10000 }).catch(() => {});
  check(await page.locator('#search-count').textContent() === '1 / 1', '인식한 글자로 검색됨');
  await shot('09-phone-ocr');
  await page.locator('#search-close').click();
  const ocrPdf = await saveViaMenu();
  const ocrText = (await pdfText(ocrPdf))[0].text;
  check(/INVOICE/i.test(ocrText) && /12345/.test(ocrText), `저장 PDF에 숨은 글자 층: "${ocrText.slice(0, 60)}"`);

  // -------------------------------------------------------------------------
  step('iPad 화면');
  for (const [name, device] of [['10-ipad-portrait', devices['iPad Pro 11']], ['11-ipad-landscape', devices['iPad Pro 11 landscape']]]) {
    const c2 = await browser.newContext({ ...device });
    const p = await c2.newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(`${url}?debug`);
    await p.setInputFiles('#file-open', fx.forms);
    await p.waitForSelector('.page-canvas');
    await p.waitForTimeout(800);
    await p.screenshot({ path: join(out, `${name}.png`) });
    await c2.close();
  }
  check(true, 'iPad 세로·가로 화면 캡처');

  step('오류 없음');
  check(errors.length === 0, errors.length ? `오류: ${errors.join(' | ')}` : '브라우저 오류 없음');
} catch (err) {
  failures++;
  console.error(err);
  await shot('error').catch(() => {});
} finally {
  await browser.close();
  server.close();
}

console.log(failures ? `\n✗ ${failures}개 실패` : '\n✓ 모든 검사 통과');
process.exit(failures ? 1 : 0);

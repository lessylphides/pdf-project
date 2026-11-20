// Font substitution and metrics for HWP layout.
//
// HWP documents name fonts that are usually not available (휴먼명조, HY헤드라인M,
// 함초롬바탕 …). Each is mapped to a bundled open font of the same kind:
//   명조/바탕 계열 → 나눔명조,  고딕/돋움/굴림 계열 → 나눔고딕,
// with the weight taken from the font name (헤드라인, 견고딕 → extra bold) and
// the bold attribute. Korean glyphs are full width in all of these fonts, so
// line breaks and positions stay close to the original.
import fontkit from '@pdf-lib/fontkit';
import { dropTables } from '../sfnt.js';

export const FONT_FILES = {
  'gothic-400': '@expo-google-fonts/nanum-gothic/400Regular/NanumGothic_400Regular.ttf',
  'gothic-700': '@expo-google-fonts/nanum-gothic/700Bold/NanumGothic_700Bold.ttf',
  'gothic-800': '@expo-google-fonts/nanum-gothic/800ExtraBold/NanumGothic_800ExtraBold.ttf',
  'myeongjo-400': '@expo-google-fonts/nanum-myeongjo/400Regular/NanumMyeongjo_400Regular.ttf',
  'myeongjo-700': '@expo-google-fonts/nanum-myeongjo/700Bold/NanumMyeongjo_700Bold.ttf',
  'myeongjo-800': '@expo-google-fonts/nanum-myeongjo/800ExtraBold/NanumMyeongjo_800ExtraBold.ttf',
};

const SERIF = /명조|바탕|batang|myeongjo|궁서|gungsuh|serif|times|georgia|garamond|함초롬바탕|신명조|그래픽/i;
const HEAVY = /헤드라인|견고딕|견명조|견출|태고딕|태명조|굵은|black|heavy|extrabold|ultra/i;

/** Font family and weight used for a face name and bold flag. */
export function substitute(name = '', bold = false) {
  const family = SERIF.test(name) && !/sans/i.test(name) ? 'myeongjo' : 'gothic';
  let weight = HEAVY.test(name) ? 800 : 400;
  if (bold) weight = weight === 800 ? 800 : 700;
  return `${family}-${weight}`;
}

/**
 * Loads the font files a document needs and answers width queries.
 * `load(key)` returns the TTF bytes for a FONT_FILES key.
 */
export class FontSet {
  constructor(load) {
    this.load = load;
    this.fonts = new Map(); // key -> { bytes, font, unitsPerEm }
    this.widthCache = new Map();
  }

  async ensure(keys) {
    await Promise.all([...keys].filter((k) => !this.fonts.has(k)).map(async (k) => {
      // fontkit cannot parse the layout tables of these fonts; see sfnt.js.
      const bytes = dropTables(new Uint8Array(await this.load(k)), ['GPOS', 'GSUB']);
      const font = fontkit.create(bytes);
      this.fonts.set(k, { bytes, font, unitsPerEm: font.unitsPerEm });
    }));
  }

  has(key, ch) {
    const f = this.fonts.get(key);
    return !!f && f.font.hasGlyphForCodePoint(ch.codePointAt(0));
  }

  /** Advance width in em. */
  advance(key, ch) {
    const ck = `${key}\u0000${ch}`;
    let w = this.widthCache.get(ck);
    if (w === undefined) {
      const f = this.fonts.get(key);
      const g = f.font.glyphForCodePoint(ch.codePointAt(0));
      w = g ? g.advanceWidth / f.unitsPerEm : 1;
      this.widthCache.set(ck, w);
    }
    return w;
  }

  /** Ascent of the font in em (for vertical placement of fallback glyphs). */
  ascent(key) {
    const f = this.fonts.get(key);
    return f ? f.font.ascent / f.unitsPerEm : 0.8;
  }
}

/** Code points in the Private Use Area used by Wingdings/Symbol style fonts. */
const PUA_MAP = {
  0xf09f: '•', 0xf0a7: '▪', 0xf06c: '●', 0xf06e: '■', 0xf06f: '□', 0xf071: '❑', 0xf075: '◆', 0xf076: '❖',
  0xf0a8: '◻', 0xf0d8: '➢', 0xf0e0: '→', 0xf0e8: '➔', 0xf0fc: '✓', 0xf0fb: '✗', 0xf0fe: '☑', 0xf0a1: '○',
  0xf0b7: '•', 0xf0a2: '◎', 0xf0a4: '◉', 0xf0b2: '◇', 0xf0b6: '★', 0xf0ab: '★', 0xf020: ' ',
};

/** Normalizes characters that the substitute fonts cannot show directly. */
export function normalizeChar(ch) {
  const cp = ch.codePointAt(0);
  if (PUA_MAP[cp]) return PUA_MAP[cp];
  if (cp === 0x2024) return '·'; // one dot leader
  if (cp === 0x2027) return '·'; // hyphenation point
  if (cp === 0x00a0 || cp === 0x2007 || cp === 0x202f) return ' ';
  return ch;
}

/** Circled numbers ①–⑳ and parenthesized/dotted variants are drawn, not typed. */
export function circledNumber(ch) {
  const cp = ch.codePointAt(0);
  if (cp >= 0x2460 && cp <= 0x2473) return { kind: 'circle', text: String(cp - 0x2460 + 1) };
  if (cp >= 0x24ea && cp <= 0x24ea) return { kind: 'circle', text: '0' };
  if (cp >= 0x3251 && cp <= 0x325f) return { kind: 'circle', text: String(cp - 0x3251 + 21) };
  if (cp >= 0x32b1 && cp <= 0x32bf) return { kind: 'circle', text: String(cp - 0x32b1 + 36) };
  if (cp >= 0x2776 && cp <= 0x277f) return { kind: 'filled', text: String(cp - 0x2776 + 1) };
  if (cp >= 0x24eb && cp <= 0x24f4) return { kind: 'filled', text: String(cp - 0x24eb + 11) };
  if (cp >= 0x3260 && cp <= 0x326d) return { kind: 'circle', text: '가나다라마바사아자차카타파하'[cp - 0x3260] };
  if (cp >= 0x326e && cp <= 0x327b) return { kind: 'circle', text: '가나다라마바사아자차카타파하'[cp - 0x326e] };
  if (cp >= 0x2474 && cp <= 0x2487) return { kind: 'paren', text: `(${cp - 0x2474 + 1})` };
  if (cp >= 0x3200 && cp <= 0x320d) return { kind: 'paren', text: `(${'ㄱㄴㄷㄹㅁㅂㅅㅇㅈㅊㅋㅌㅍㅎ'[cp - 0x3200]})` };
  if (cp >= 0x320e && cp <= 0x321b) return { kind: 'paren', text: `(${'가나다라마바사아자차카타파하'[cp - 0x320e]})` };
  if (cp === 0x33a1) return { kind: 'unit', text: 'm', sup: '2' };
  if (cp === 0x33a5) return { kind: 'unit', text: 'm', sup: '3' };
  if (cp === 0x339f) return { kind: 'unit', text: 'mm', sup: '2' };
  if (cp === 0x33a0) return { kind: 'unit', text: 'cm', sup: '2' };
  if (cp === 0x33a2) return { kind: 'unit', text: 'km', sup: '2' };
  if (cp === 0x338f) return { kind: 'unit', text: 'kg' };
  if (cp === 0x338e) return { kind: 'unit', text: 'mg' };
  if (cp === 0x339c) return { kind: 'unit', text: 'mm' };
  if (cp === 0x339d) return { kind: 'unit', text: 'cm' };
  if (cp === 0x339e) return { kind: 'unit', text: 'km' };
  if (cp === 0x2116) return { kind: 'unit', text: 'No.' };
  return null;
}

/** Which of the seven HWP language slots a character uses. */
export function langOf(ch) {
  const cp = ch.codePointAt(0);
  if ((cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0x1100 && cp <= 0x11ff) || (cp >= 0x3130 && cp <= 0x318f) || (cp >= 0xa960 && cp <= 0xa97f) || (cp >= 0xd7b0 && cp <= 0xd7ff)) return 0;
  if (cp < 0x0250 || (cp >= 0x1e00 && cp <= 0x1eff)) return 1;
  if ((cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0xf900 && cp <= 0xfaff) || cp >= 0x20000) return 2;
  if ((cp >= 0x3040 && cp <= 0x30ff) || (cp >= 0x31f0 && cp <= 0x31ff)) return 3;
  if ((cp >= 0x2000 && cp <= 0x2bff) || (cp >= 0x3000 && cp <= 0x303f) || (cp >= 0x3200 && cp <= 0x33ff) || (cp >= 0xe000 && cp <= 0xf8ff) || (cp >= 0xff00 && cp <= 0xffef) || (cp >= 0x2460 && cp <= 0x24ff)) return 5;
  return 4;
}

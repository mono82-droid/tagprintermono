'use strict';
/*
 * 택번호 프린터 (웹 · 아이폰용) — 안드로이드 앱 TagPrinter와 같은 동작
 * - Xprinter XP-365B 를 블루투스 LE(Web Bluetooth)로 연결해 TSPL BITMAP 으로 인쇄
 * - 아이폰은 사파리가 Web Bluetooth 를 지원하지 않으므로 Bluefy 앱에서 열어야 함
 * - 탭·기록·설정은 이 기기 브라우저(localStorage / IndexedDB)에만 저장됨
 */

// ═══════════════════════════ 기본값 · 도구 ═══════════════════════════

const DOTS = 8;   // 203dpi = 8 dot/mm
const EDGE = 8;   // 라벨 가장자리 여백 1mm — 글자가 이 안을 벗어나지 않음

/** 중국산 열전사 프린터에서 흔한 (BLE 서비스, 쓰기 특성) 조합 — 안드로이드 앱과 같음 */
const KNOWN = [
  ['000018f0-0000-1000-8000-00805f9b34fb', '00002af1-0000-1000-8000-00805f9b34fb'],
  ['e7810a71-73ae-499d-8c15-faa9aef0c3f2', 'bef8d6c9-9c21-4c9e-b632-bd58c1009f9f'],
  ['49535343-fe7d-4ae5-8fa9-9fafd205e455', '49535343-8841-43f4-a8d4-ecbe34729bb3'],
];

const $ = (s, r = document) => r.querySelector(s);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
const clone = o => JSON.parse(JSON.stringify(o));
const int = (v, d = 0) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };

/** 작은 DOM 도우미: h('div', {class:'x', onclick: fn}, '내용') */
function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'style') e.style.cssText = v;
    else if (k === 'value') e.value = v;
    else if (k === 'checked') e.checked = !!v;
    else if (k === 'disabled') e.disabled = !!v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
}

// ═══════════════════════════ 저장 ═══════════════════════════

const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (_) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { console.warn('저장 실패', e); } },
};

const DEFAULTS = {
  nextNumber: 1, rangeStart: 1, rangeEnd: 100, printCount: 1, copies: 1,
  density: 8, speed: 4, flip180: false, offsetX: 0, offsetY: 0,
  chunk: 180, syncEvery: 4, gapMs: 0, fast: false,
  current: '', tabOrder: [], deviceId: null, deviceName: null,
};
const S = Object.assign({}, DEFAULTS, LS.get('tp_settings', {}));
const saveS = () => LS.set('tp_settings', S);

const TYPES = ['TEXT', 'SERIAL', 'DATE'];
const TITLE = { TEXT: '글자', SERIAL: '연속번호', DATE: '날짜' };

/** 라벨 위 요소 하나. 좌표·크기는 dot 기준, x/y = 회전 후 박스의 왼쪽 위 (안드로이드와 같은 형식) */
function makeEl(type, o) {
  return Object.assign({
    type, x: 16, y: 16, text: '글자', prefix: '', suffix: '', digits: 0, dateFmt: 'yyyy.MM.dd',
    font: 'sans', sizeMm: 5, bold: false, italic: false, underline: false, invert: false,
    rotation: 0, align: 1, centerH: true, centerV: false, scaleX: 1,
  }, o || {}, { type });
}
function makeTpl(name, w = 40, hh = 60, gap = 2) { return { name, widthMm: w, heightMm: hh, gapMm: gap, elements: [] }; }
function normTpl(t) {
  t.widthMm = t.widthMm || 40; t.heightMm = t.heightMm || 60; t.gapMm = t.gapMm ?? 2;
  t.elements = (t.elements || []).map(e => makeEl(TYPES.includes(e.type) ? e.type : 'TEXT', e));
  return t;
}

const store = {
  map: LS.get('tp_templates', {}),
  names() { return Object.keys(this.map).sort(); },
  exists(n) { return Object.prototype.hasOwnProperty.call(this.map, n); },
  load(n) { return this.exists(n) ? normTpl(clone(this.map[n])) : null; },
  save(t) { this.map[t.name] = clone(t); LS.set('tp_templates', this.map); },
  del(n) { delete this.map[n]; LS.set('tp_templates', this.map); },
};

const history = {
  all() { return LS.get('tp_history', []); },
  add(r) { LS.set('tp_history', [r, ...this.all()].slice(0, 50)); },
  remove(i) { const l = this.all(); l.splice(i, 1); LS.set('tp_history', l); },
  clear() { LS.set('tp_history', []); },
};

/** 사용자가 추가한 글꼴 파일 (용량이 커서 IndexedDB) */
const idb = {
  p: null,
  open() {
    return this.p || (this.p = new Promise((res, rej) => {
      const r = indexedDB.open('tagprinter', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('fonts');
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    }));
  },
  async tx(mode, fn) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const t = db.transaction('fonts', mode); const os = t.objectStore('fonts'); const req = fn(os);
      t.oncomplete = () => res(req && req.result); t.onerror = () => rej(t.error);
    });
  },
  put(k, v) { return this.tx('readwrite', os => os.put(v, k)); },
  get(k) { return this.tx('readonly', os => os.get(k)); },
  keys() { return this.tx('readonly', os => os.getAllKeys()); },
};

// ═══════════════════════════ 글자 내용 ═══════════════════════════

const WD = ['일', '월', '화', '수', '목', '금', '토'];
function fmtDate(fmt, d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  const map = {
    yyyy: d.getFullYear(), yy: p(d.getFullYear() % 100), MM: p(d.getMonth() + 1), M: d.getMonth() + 1,
    dd: p(d.getDate()), d: d.getDate(), HH: p(d.getHours()), H: d.getHours(), mm: p(d.getMinutes()),
    ss: p(d.getSeconds()), E: WD[d.getDay()],
  };
  return String(fmt).replace(/yyyy|yy|MM|M|dd|d|HH|H|mm|ss|E/g, t => map[t]);
}
function content(e, n) {
  if (e.type === 'TEXT') return e.text;
  if (e.type === 'SERIAL') {
    const s = e.digits > 0 ? String(n).padStart(e.digits, '0') : String(n);
    return e.prefix + s + e.suffix;
  }
  return fmtDate(e.dateFmt);
}

// ═══════════════════════════ 글꼴 ═══════════════════════════

const GOTHIC = '"Apple SD Gothic Neo","Noto Sans KR","Malgun Gothic",system-ui,sans-serif';
const BUNDLED = [   // 모두 SIL Open Font License (fonts/OFL.txt)
  ['NanumGothic-Regular.ttf', '나눔고딕'],
  ['NanumGothic-ExtraBold.ttf', '나눔고딕 아주 굵게'],
  ['NanumMyeongjo-Regular.ttf', '나눔명조'],
  ['BlackHanSans-Regular.ttf', '검은고딕 (굵은 제목용)'],
  ['DoHyeon-Regular.ttf', '도현체'],
  ['Jua-Regular.ttf', '주아체'],
  ['Sunflower-Bold.ttf', '해바라기체'],
  ['Gugi-Regular.ttf', '구기체'],
  ['NanumPenScript-Regular.ttf', '나눔손글씨 펜'],
  ['Oswald.ttf', 'Oswald (좁은 숫자)'],
  ['BebasNeue-Regular.ttf', 'Bebas Neue (숫자·영문 대문자)'],
  ['Anton-Regular.ttf', 'Anton (굵은 숫자)'],
  ['RobotoMono.ttf', 'Roboto Mono (고정폭 숫자)'],
];
const FONTS = [
  { key: 'sans', name: '기본 고딕', family: GOTHIC, weight: 400 },
  { key: 'sys:sans-serif-light', name: '얇은 고딕', family: GOTHIC, weight: 300 },
  { key: 'sys:sans-serif-medium', name: '중간 고딕', family: GOTHIC, weight: 500 },
  { key: 'sys:sans-serif-black', name: '아주 굵은 고딕', family: GOTHIC, weight: 800 },
  { key: 'mono', name: '고정폭', family: 'Menlo,"Courier New",monospace', weight: 400 },
  ...BUNDLED.map(([f, n], i) => ({ key: 'asset:' + f, name: n, file: 'fonts/' + f, family: 'TPF' + i, weight: 400 })),
];
/** 안드로이드 앱 템플릿의 글꼴 키 → 웹 글꼴 */
const ALIAS = { serif: 'asset:NanumMyeongjo-Regular.ttf', 'sys:sans-serif-condensed': 'sans' };
const userFonts = [];
const fontLoads = new Map();

function fontInfo(key) {
  const k = ALIAS[key] || key;
  return FONTS.find(f => f.key === k) || userFonts.find(f => f.key === k) || FONTS[0];
}
const isFileFont = f => !!(f.file || f.buffer);

/** 글꼴 파일을 필요할 때만 받아옴 (한 번 받으면 브라우저가 보관) */
function ensureFont(key) {
  const f = fontInfo(key);
  if (!isFileFont(f)) return Promise.resolve();
  if (!fontLoads.has(f.key)) {
    const face = new FontFace(f.family, f.buffer || `url(${f.file})`);
    fontLoads.set(f.key, face.load()
      .then(ff => { document.fonts.add(ff); f.ready = true; })
      .catch(err => { console.warn('글꼴 불러오기 실패', f.name, err); f.failed = true; }));
  }
  return fontLoads.get(f.key);
}
const ensureFonts = t => Promise.all(t.elements.map(e => ensureFont(e.font)));

function fontSpec(e, px) {
  const f = fontInfo(e.font);
  const file = isFileFont(f);
  let w = f.weight || 400;
  if (e.bold && !file) w = Math.min(900, Math.max(700, w + 300));
  const fam = file ? `"${f.family}",${GOTHIC}` : f.family;
  // 글꼴 파일은 굵게 변형이 없을 수 있어 테두리를 덧그려 굵게 흉내냄
  return { css: `${e.italic ? 'italic ' : ''}${w} ${px.toFixed(2)}px ${fam}`, fakeBold: e.bold && file };
}

async function loadUserFonts() {
  try {
    const keys = await idb.keys();
    for (const name of keys) {
      const buf = await idb.get(name);
      if (buf) addUserFont(name, buf);
    }
  } catch (e) { console.warn('사용자 글꼴 목록 실패', e); }
}
function addUserFont(name, buf) {
  const key = 'file:' + name;
  if (userFonts.some(f => f.key === key)) return key;
  userFonts.push({ key, name: '📁 ' + name.replace(/\.(ttf|otf|ttc)$/i, ''), buffer: buf, family: 'TPU' + userFonts.length, weight: 400 });
  return key;
}

// ═══════════════════════════ 라벨 그리기 (안드로이드 Label.kt 와 같은 규칙) ═══════════════════════════

const mctx = document.createElement('canvas').getContext('2d');

/**
 * 글자 실제 잉크 영역(actualBoundingBox) 기준 측정 → 위아래 쓸데없는 여백 없이 꽉 차게.
 * tops[i] = i번째 줄 상자의 위쪽, rects[i] = 그 줄의 실제 글자 외곽
 */
function measure(e, n, px) {
  let lines = String(content(e, n) ?? '').split('\n');
  if (!lines.length) lines = [''];
  const spec = fontSpec(e, px);
  mctx.font = spec.css;
  const sx = e.scaleX || 1, gap = px * 0.15, emptyH = px * 0.7;
  const fb = spec.fakeBold ? px * 0.03 : 0;
  const rects = lines.map(line => {
    if (!line.trim()) return { l: 0, a: emptyH, w: 0, h: emptyH };
    const m = mctx.measureText(line);
    const l = (m.actualBoundingBoxLeft || 0) + fb, r = (m.actualBoundingBoxRight || m.width) + fb;
    const a = (m.actualBoundingBoxAscent || px * 0.8) + fb, d = (m.actualBoundingBoxDescent || 0) + fb;
    return { l, a, w: (l + r) * sx, h: a + d };
  });
  const tops = []; let y = 0;
  rects.forEach((r, i) => { tops.push(y); y += r.h + (i < rects.length - 1 ? gap : 0); });
  if (e.underline) y += px * 0.12;
  const pad = e.invert ? DOTS : 0;
  const w = Math.max(4, ...rects.map(r => r.w));
  return { lines, rects, tops, w: w + pad * 2, h: Math.max(4, y) + pad * 2, pad, spec, px, sx, fb };
}
const boxSize = (e, m) => (e.rotation === 90 || e.rotation === 270) ? [m.h, m.w] : [m.w, m.h];

/**
 * 배치 계산. 라벨(여백 안)을 넘으면 들어가는 만큼 자동으로 줄이고 위치도 안으로 밀어 넣음.
 * 연속번호는 이번 인쇄의 가장 큰 번호(fit) 기준 크기 → 모든 장이 같은 크기.
 */
function layout(t, e, n, fit = n) {
  let px = e.sizeMm * DOTS, m = measure(e, n, px), [bw, bh] = boxSize(e, m);
  const W = t.widthMm * DOTS, H = t.heightMm * DOTS, aw = W - EDGE * 2, ah = H - EDGE * 2;
  let fw = bw, fh = bh;
  if (e.type === 'SERIAL' && fit !== n) {
    const [w2, h2] = boxSize(e, measure(e, fit, px));
    fw = Math.max(bw, w2); fh = Math.max(bh, h2);
  }
  const f = Math.min(1, aw / fw, ah / fh);
  if (f < 1) { px = px * f * 0.98; m = measure(e, n, px); [bw, bh] = boxSize(e, m); }
  const x = e.centerH ? (W - bw) / 2 : clamp(e.x, EDGE, Math.max(EDGE, W - EDGE - bw));
  // 세로 가운데 고정: 내용·크기가 바뀌어도 항상 위아래 가운데 (탭에 요소 하나일 때 기본)
  const y = e.centerV ? (H - bh) / 2 : clamp(e.y, EDGE, Math.max(EDGE, H - EDGE - bh));
  return { m, x, y, bw, bh, px };
}
function bounds(t, e, n, fit = n) {
  const l = layout(t, e, n, fit);
  return { left: l.x, top: l.y, right: l.x + l.bw, bottom: l.y + l.bh, w: l.bw, h: l.bh };
}
const effectiveSizeMm = (t, e, n, fit = n) => layout(t, e, n, fit).px / DOTS;

function drawElement(ctx, t, e, n, fit = n) {
  const { m, x, y } = layout(t, e, n, fit);
  ctx.save();
  ctx.translate(x, y);
  if (e.rotation === 90) { ctx.translate(m.h, 0); ctx.rotate(Math.PI / 2); }
  else if (e.rotation === 180) { ctx.translate(m.w, m.h); ctx.rotate(Math.PI); }
  else if (e.rotation === 270) { ctx.translate(0, m.w); ctx.rotate(-Math.PI / 2); }
  let color = '#000';
  if (e.invert) { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, m.w, m.h); color = '#fff'; }
  ctx.font = m.spec.css; ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
  ctx.fillStyle = color; ctx.strokeStyle = color; ctx.lineWidth = m.fb * 2; ctx.lineJoin = 'round';
  const inner = m.w - m.pad * 2;
  m.lines.forEach((line, i) => {
    const r = m.rects[i];
    const X = m.pad + (e.align === 1 ? (inner - r.w) / 2 : e.align === 2 ? inner - r.w : 0);
    const base = m.pad + m.tops[i] + r.a;
    ctx.save();
    ctx.scale(m.sx, 1);                  // 장평
    const dx = X / m.sx + r.l;           // 글자 외곽 왼쪽이 X 에 오도록
    ctx.fillText(line, dx, base);
    if (m.fb > 0) ctx.strokeText(line, dx, base);
    if (e.underline && r.w > 0) ctx.fillRect(dx - r.l, base + m.px * 0.08, r.w / m.sx, Math.max(1, m.px * 0.06));
    ctx.restore();
  });
  ctx.restore();
}

/** 라벨 한 장 (실제 크기, dot 단위) */
function render(t, n, fit = n, cv) {
  const W = t.widthMm * DOTS, H = t.heightMm * DOTS;
  cv = cv || document.createElement('canvas');
  if (cv.width !== W) cv.width = W;
  if (cv.height !== H) cv.height = H;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
  t.elements.forEach(e => drawElement(ctx, t, e, n, fit));
  return cv;
}

function center(t, e, hz, vt, n = 1, fit = n) {
  const b = bounds(t, e, n, fit);
  if (hz) e.x = Math.round((t.widthMm * DOTS - b.w) / 2);
  if (vt) e.y = Math.round((t.heightMm * DOTS - b.h) / 2);
}

// ═══════════════════════════ TSPL ═══════════════════════════

const enc = new TextEncoder();

/**
 * 라벨 1장 작업. BITMAP 은 잉크가 있는 영역만 잘라 보내 전송량을 줄임.
 * TSPL BITMAP: 1 = 흰 점, 0 = 검은 점, MSB = 왼쪽 픽셀.
 * header=false 면 용지 설정(SIZE~SPEED)을 생략 → 연속 인쇄 때 첫 장에만.
 */
function tsplJob(t, cv, copies, header = true) {
  const parts = [];
  const cmd = s => parts.push(enc.encode(s + '\r\n'));
  if (header) {
    cmd(`SIZE ${t.widthMm} mm,${t.heightMm} mm`);
    cmd(`GAP ${t.gapMm} mm,0 mm`);
    cmd(`DIRECTION ${S.flip180 ? 1 : 0}`);
    cmd('REFERENCE 0,0');
    cmd(`DENSITY ${S.density}`);
    cmd(`SPEED ${S.speed}`);
  }
  cmd('CLS');
  const w = cv.width, hh = cv.height;
  const d = cv.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, hh).data;
  const black = new Uint8Array(w * hh);
  let minX = w, maxX = -1, minY = hh, maxY = -1;
  for (let y = 0; y < hh; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if ((d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000 < 128) {
        black[y * w + x] = 1;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX >= 0) {
    const bx0 = minX >> 3, wb = (maxX >> 3) - bx0 + 1, rows = maxY - minY + 1;
    const posX = Math.max(0, bx0 * 8 + int(S.offsetX)), posY = Math.max(0, minY + int(S.offsetY));
    parts.push(enc.encode(`BITMAP ${posX},${posY},${wb},${rows},0,`));
    const bmp = new Uint8Array(wb * rows);
    for (let y = minY; y <= maxY; y++) {
      for (let b = 0; b < wb; b++) {
        let v = 0xFF;
        for (let bit = 0; bit < 8; bit++) {
          const x = (bx0 + b) * 8 + bit;
          if (x < w && black[y * w + x]) v &= ~(0x80 >> bit);
        }
        bmp[(y - minY) * wb + b] = v & 0xFF;
      }
    }
    parts.push(bmp);
    parts.push(enc.encode('\r\n'));
  }
  cmd(`PRINT 1,${copies}`);
  let len = 0; for (const p of parts) len += p.length;
  const out = new Uint8Array(len); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// ═══════════════════════════ 프린터 (Web Bluetooth) ═══════════════════════════

const P = {
  device: null, ch: null, canResp: false, canNR: false, connecting: null,
  stale: false,        // 다시 붙이기에 실패한 상태 → 다음 [인쇄] 때 고르기 창(한 번 연결했던 프린터만)
  needAdvert: false,   // 오래 끊겨 있던 기기: 광고 신호를 먼저 받아야 붙는 브라우저가 있음
  userClosed: false,   // 사용자가 '연결 끊기'를 누름 → 자동 연결 안 함
  retryTimer: 0, retryPending: false, retryDelay: 1500,
};
let manualClose = false;

const bleSupported = () => !!(navigator.bluetooth && navigator.bluetooth.requestDevice);
function setStatus(kind, text) {
  $('#status').className = 'chip ' + (kind || '');
  $('#statusText').textContent = text;
}
const isConnected = () => !!(P.ch && P.device && P.device.gatt && P.device.gatt.connected);
const devName = () => (P.device && P.device.name) || S.deviceName || '프린터';
function withTimeout(p, ms, msg) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);
}

/**
 * 프린터 고르기 — 반드시 버튼 누른 직후(다른 await 전에) 불러야 브라우저가 허용.
 * 한 번 연결했던 프린터가 있으면 그 이름만 목록에 떠서 한 번에 고름. any=true 면 전부.
 */
async function pickPrinter(any = false) {
  if (!bleSupported()) { showNoBle(); return false; }
  const optionalServices = KNOWN.map(k => k[0]);
  const opts = (!any && S.deviceName)
    ? { filters: [{ name: S.deviceName }], optionalServices }
    : { acceptAllDevices: true, optionalServices };
  let dev;
  try {
    dev = await navigator.bluetooth.requestDevice(opts);
  } catch (e) {
    if (!e || e.name !== 'NotFoundError') toast('프린터 선택 실패: ' + (e && e.message || e));
    return false;   // NotFoundError = 고르지 않고 닫음
  }
  P.userClosed = false; P.stale = false; P.needAdvert = false;
  attachDevice(dev);
  S.deviceId = dev.id || null; S.deviceName = dev.name || S.deviceName || null; saveS();
  return connect();
}

function attachDevice(dev) {
  if (P.device === dev) return;
  if (P.device) P.device.removeEventListener('gattserverdisconnected', onDisconnected);
  P.device = dev; P.ch = null;
  dev.addEventListener('gattserverdisconnected', onDisconnected);
}

/** 광고 신호를 잠깐 기다림 (지원하는 브라우저만) — 오래 끊겨 있던 기기에 바로 붙으면 '범위 밖' 오류가 나는 경우 대비 */
async function waitAdvert(dev, ms = 6000) {
  if (!dev || typeof dev.watchAdvertisements !== 'function') return;
  const ac = typeof AbortController === 'function' ? new AbortController() : null;
  await new Promise(res => {
    const done = () => { clearTimeout(timer); try { ac && ac.abort(); } catch (_) {} res(); };
    const timer = setTimeout(done, ms);
    dev.addEventListener('advertisementreceived', done, { once: true });
    Promise.resolve(dev.watchAdvertisements(ac ? { signal: ac.signal } : undefined)).catch(done);
  });
}

/** 연결 + 쓰기 채널 찾기. 알려진 UUID 부터, 없으면 허용된 서비스 안의 아무 쓰기 특성 */
function connect() {
  if (!P.device) return Promise.resolve(false);
  if (isConnected()) return Promise.resolve(true);
  if (P.connecting) return P.connecting;
  P.connecting = (async () => {
    const name = devName();
    setStatus('busy', `${name} 연결 중…`);
    try {
      if (P.needAdvert) await waitAdvert(P.device);
      const server = await withTimeout(P.device.gatt.connect(), 12000, '연결 시간 초과 (프린터 전원·거리 확인)');
      let ch = null;
      for (const [s, c] of KNOWN) {
        try {
          const svc = await server.getPrimaryService(s);
          const x = await svc.getCharacteristic(c);
          if (x.properties.write || x.properties.writeWithoutResponse) { ch = x; break; }
        } catch (_) { /* 이 조합은 없음 */ }
      }
      if (!ch) {
        try {
          for (const svc of await server.getPrimaryServices()) {
            for (const x of await svc.getCharacteristics()) {
              if (x.properties.write || x.properties.writeWithoutResponse) { ch = x; break; }
            }
            if (ch) break;
          }
        } catch (_) { /* 없음 */ }
      }
      if (!ch) throw new Error('프린터 쓰기 채널을 찾지 못함');
      P.ch = ch; P.canResp = !!ch.properties.write; P.canNR = !!ch.properties.writeWithoutResponse;
      P.stale = false; P.needAdvert = false; P.retryDelay = 1500;
      setStatus('ok', name);
      return true;
    } catch (e) {
      P.ch = null; P.stale = true; P.needAdvert = true;
      setStatus('err', `${name} 연결 안 됨 — [인쇄]를 누르면 다시 연결`);
      return false;
    } finally {
      P.connecting = null;
    }
  })();
  return P.connecting;
}

/**
 * 자동 다시 연결: 끊기면 화면이 켜져 있는 동안 계속 시도 (1.5초 → 3 → 6 … 최대 30초 간격).
 * 사용자가 '연결 끊기'를 눌렀거나 화면이 꺼져 있으면 쉼 (돌아오면 다시 시작).
 */
function scheduleReconnect(first = false) {
  if (!P.device || P.userClosed || isConnected() || document.hidden) return;
  if (first) { P.retryDelay = 1500; clearTimeout(P.retryTimer); P.retryPending = false; }
  if (P.retryPending) return;
  P.retryPending = true;
  P.retryTimer = setTimeout(async () => {
    P.retryPending = false;
    if (!P.device || P.userClosed || isConnected() || document.hidden) return;
    if (printing) { scheduleReconnect(); return; }
    if (await connect()) return;
    P.retryDelay = Math.min(P.retryDelay * 2, 30000);
    scheduleReconnect();
  }, P.retryDelay);
}

function onDisconnected() {
  P.ch = null;
  if (manualClose) { manualClose = false; setStatus('', '연결 끊음 — 눌러서 연결'); return; }
  P.needAdvert = true;
  setStatus('busy', `${devName()} 끊김 — 다시 연결 중`);
  scheduleReconnect(true);
}
function disconnect() {
  P.userClosed = true; clearTimeout(P.retryTimer); P.retryPending = false;
  if (P.device && P.device.gatt && P.device.gatt.connected) { manualClose = true; P.device.gatt.disconnect(); }
  P.ch = null;
  setStatus('', '연결 끊음 — 눌러서 연결');
}
/** 메뉴의 '다시 연결': 붙일 수 있으면 붙이고, 안 되는 상태면 고르기 창(그 프린터만) */
function userReconnect() {
  P.userClosed = false;
  if (!P.device || P.stale) return pickPrinter(false);
  P.ch = null;
  return connect();
}

/**
 * 지난번 프린터 다시 붙이기 — 페이지를 열 때 / 다시 돌아왔을 때.
 * 페이지가 열려 있는 동안 받은 기기가 있으면 그걸로, 없으면 브라우저의 '허용한 기기 목록'(getDevices, 지원할 때만)에서 찾음.
 */
async function restoreDevice() {
  if (!bleSupported()) { showNoBle(false); return; }
  if (P.device) { if (!isConnected() && !P.userClosed) scheduleReconnect(true); return; }
  const idle = S.deviceName ? `${S.deviceName} — [인쇄]를 누르면 연결` : '프린터 연결 안 됨';
  if (!navigator.bluetooth.getDevices || (!S.deviceId && !S.deviceName)) { setStatus('', idle); return; }
  try {
    const devs = await navigator.bluetooth.getDevices();
    const d = devs.find(x => S.deviceId && x.id === S.deviceId) || devs.find(x => S.deviceName && x.name === S.deviceName);
    if (!d) { setStatus('', idle); return; }
    attachDevice(d); P.needAdvert = true;
    if (!(await connect())) scheduleReconnect(true);
  } catch (_) { setStatus('', idle); }
}

/**
 * 쓰기: N조각마다 한 번 '응답 있는 쓰기'로 프린터가 따라왔는지 확인, 나머지는 응답 없이 연속 전송.
 * 1 = 매 조각 확인(가장 안전·느림). 빠른 전송이면 확인 없음.
 */
async function writeBytes(bytes) {
  const ch = P.ch;
  if (!ch) throw new Error('연결 안 됨');
  const size = clamp(int(S.chunk, 180), 20, 512), every = clamp(int(S.syncEvery, 4), 1, 64);
  const hasNR = P.canNR && typeof ch.writeValueWithoutResponse === 'function';
  const hasR = P.canResp;
  let idx = 0;
  for (let off = 0; off < bytes.length; off += size) {
    if (!isConnected()) throw new Error('블루투스 끊김');
    const end = Math.min(off + size, bytes.length);
    const chunk = bytes.slice(off, end);
    const last = end >= bytes.length;
    const resp = !hasNR || (hasR && !S.fast && (every === 1 || last || (idx + 1) % every === 0));
    try {
      if (resp) await (ch.writeValueWithResponse ? ch.writeValueWithResponse(chunk) : ch.writeValue(chunk));
      else await ch.writeValueWithoutResponse(chunk);
    } catch (err) {
      // 첫 조각부터 거부 = 아직 아무것도 안 보냄 → 조각을 줄여 처음부터 다시 보내도 안전
      if (idx === 0 && isConnected()) { const e2 = new Error((err && err.message) || '첫 조각 전송 실패'); e2.firstWrite = true; throw e2; }
      throw err;
    }
    idx++;
    if (S.gapMs > 0) await sleep(int(S.gapMs));
  }
}

/** 끊겨 있으면 연결, 실패하면 다시 연결해서 1번 더 */
async function sendJob(bytes) {
  if (!(await connect())) throw new Error('프린터 연결 안 됨');
  try {
    await writeBytes(bytes);
  } catch (e) {
    if (e.firstWrite && int(S.chunk, 180) > 20) {
      // 큰 조각을 못 받는 프린터 → 20바이트로 낮춰 저장하고 다시 (스스로 복구)
      S.chunk = 20; saveS();
      toast('블루투스 조각 크기를 20으로 낮춰 다시 보냅니다');
      await writeBytes(bytes);
      return;
    }
    P.ch = null;
    setStatus('busy', '다시 연결 중');
    await sleep(500);
    if (!(await connect())) throw e;
    await writeBytes(bytes);
  }
}

/**
 * 인쇄 전에: 연결돼 있으면 바로, 아니면 다시 붙이기.
 * 프린터가 없거나 다시 붙이기에 실패한 상태면 누른 지금 바로 고르기 창 (한 번 연결했던 프린터만 떠서 한 번에 선택).
 */
async function ensurePrinter() {
  if (!bleSupported()) { showNoBle(); return false; }
  if (isConnected()) return true;
  P.userClosed = false;
  if (!P.device || P.stale) return pickPrinter(false);
  if (await connect()) return true;
  toast('프린터에 연결하지 못했습니다 — [인쇄]를 한 번 더 누르면 프린터를 다시 고릅니다');
  return false;
}

// ═══════════════════════════ 상태 ═══════════════════════════

let tpl = null;            // 지금 탭(라벨)
let selIdx = -1;           // 선택된 요소
let dragEnabled = false;   // 끌어서 옮기기 (기본 잠금)
let printing = false, cancelReq = false, lastPrinted = -1, lastFit = null;

// 되돌리기: 탭별 변경 기록. 저장될 때마다 이전 상태를 쌓음
const undoStack = [], redoStack = [];
let lastSnap = '', lastPushAt = 0;

const hasSerial = () => tpl.elements.some(e => e.type === 'SERIAL');
function typeOf(t) {
  const es = t.elements;
  if (es.some(e => e.type === 'SERIAL')) return 'SERIAL';
  if (es.some(e => e.type === 'DATE') && !es.some(e => e.type === 'TEXT')) return 'DATE';
  return 'TEXT';
}
const tabIcon = t => ({ SERIAL: '#  ', DATE: '📅 ', TEXT: 'Aa  ' })[typeOf(t)];
function orderedTabs() {
  const names = store.names();
  const order = S.tabOrder.filter(n => names.includes(n));
  return [...order, ...names.filter(n => !order.includes(n))];
}

/** 이번에 실제로 뽑을 번호 구간 [처음, 끝] (범위 끝을 넘지 않게) */
function planned() {
  const from = Math.max(S.nextNumber, S.rangeStart);
  const to = Math.min(from + S.printCount - 1, S.rangeEnd);
  return to >= from ? [from, to] : null;
}
/** 이번에 뽑을 번호 중 가장 큰 번호 (글자 크기 기준) */
const fitNum = () => { const r = planned(); return r ? r[1] : S.nextNumber; };
const previewFit = () => Math.max(S.nextNumber, fitNum());

// ═══════════════════════════ 첫 장 미리 만들기 ═══════════════════════════

let prepared = null, prepTimer = 0;
const prepKey = (t, n, fit, copies) =>
  `${JSON.stringify(t)}|${n}|${fit}|${copies}|${S.density}|${S.speed}|${S.flip180}|${S.offsetX}|${S.offsetY}`;
function schedulePrepare() { clearTimeout(prepTimer); prepTimer = setTimeout(prepareFirst, 300); }
async function prepareFirst() {
  if (printing || !tpl) return;
  const t = clone(tpl);
  let n = 0, fit = 0, copies = 1;
  if (hasSerial()) { const r = planned(); if (!r) return; [n, fit] = r; copies = S.copies; }
  const key = prepKey(t, n, fit, copies);
  if (prepared && prepared.key === key) return;
  await ensureFonts(t);
  prepared = { key, job: tsplJob(t, render(t, n, fit), copies, true) };
}
const takePrepared = (t, n, fit, copies) =>
  (prepared && prepared.key === prepKey(t, n, fit, copies)) ? prepared.job : null;

// ═══════════════════════════ 템플릿(탭) ═══════════════════════════

function saveTpl() { recordUndo(); store.save(tpl); }

function recordUndo() {
  const now = JSON.stringify(tpl);
  if (now === lastSnap) return;
  const t = Date.now();
  // 1초 안에 이어지는 변경(글자 연달아 치기 등)은 한 번으로 묶음
  if (lastSnap && (!undoStack.length || t - lastPushAt > 1000)) {
    undoStack.push(lastSnap);
    if (undoStack.length > 50) undoStack.shift();
  }
  lastPushAt = t; lastSnap = now; redoStack.length = 0;
  undoButtons();
}
function resetUndo() { undoStack.length = 0; redoStack.length = 0; lastSnap = JSON.stringify(tpl); lastPushAt = 0; undoButtons(); }
function undoButtons() { $('#undo').disabled = !undoStack.length; $('#redo').disabled = !redoStack.length; }
function undo() {
  if (!undoStack.length) return;
  redoStack.push(JSON.stringify(tpl)); restoreSnap(undoStack.pop()); toast('되돌림');
}
function redo() {
  if (!redoStack.length) return;
  undoStack.push(JSON.stringify(tpl)); restoreSnap(redoStack.pop()); toast('다시 함');
}
function restoreSnap(json) {
  const name = tpl.name;
  tpl = normTpl(JSON.parse(json)); tpl.name = name;
  lastSnap = json; lastPushAt = 0;
  store.save(tpl);
  if (selIdx >= tpl.elements.length) selIdx = -1;
  buildProps(); redraw(); renderTabs(); updatePrintUI(); undoButtons();
}

function switchTo(t) {
  tpl = t; S.current = t.name;
  if (!S.tabOrder.includes(t.name)) S.tabOrder.push(t.name);
  saveS(); store.save(tpl);
  resetUndo();   // 탭이 바뀌면 되돌리기 기록도 그 탭 것으로
  selIdx = tpl.elements.length ? 0 : -1;
  bindTemplate();
}
function bindTemplate() {
  renderTabs(); buildProps(); refreshNumbers(); redraw();
  ensureFonts(tpl).then(() => { redraw(); buildProps(); });
}

function renderTabs() {
  const box = $('#tabs'); box.innerHTML = '';
  let cur = null;
  for (const name of orderedTabs()) {
    const isCur = name === tpl.name;
    const t = isCur ? tpl : store.load(name);
    const b = h('button', { class: 'tab' + (isCur ? ' cur' : ''), type: 'button' }, tabIcon(t) + name);
    onLongPress(b, () => { if (name !== tpl.name) switchTo(store.load(name)); tabMenu(); });
    b.addEventListener('click', () => { if (name !== tpl.name) switchTo(store.load(name)); });
    box.append(b);
    if (isCur) cur = b;
  }
  box.append(h('button', { class: 'tab add', type: 'button', onclick: () => listSheet('새 라벨 탭', TYPES.map(ty => ({ label: TITLE[ty] + ' 탭', onClick: () => newTab(ty) }))) }, '＋'));
  if (cur) requestAnimationFrame(() => box.scrollTo({ left: Math.max(0, cur.offsetLeft - 40), behavior: 'smooth' }));
  // 지금 탭 종류 버튼은 진하게
  const ty = typeOf(tpl);
  document.querySelectorAll('#typeRow .btn').forEach(b => {
    b.classList.toggle('primary', b.dataset.type === ty);
    b.classList.toggle('tonal', b.dataset.type !== ty);
  });
}

/** 새 탭(새 라벨)을 만들고 그 종류 요소 하나를 가운데에 → 다른 탭 위에 겹치지 않음 */
function newTab(type) {
  let name = TITLE[type], k = 2;
  while (store.exists(name)) name = `${TITLE[type]} ${k++}`;
  const t = makeTpl(name, tpl ? tpl.widthMm : 40, tpl ? tpl.heightMm : 60, tpl ? tpl.gapMm : 2);
  const e = type === 'TEXT' ? makeEl('TEXT', { text: '글자', sizeMm: 12, bold: true, centerV: true })
    : type === 'SERIAL' ? makeEl('SERIAL', { sizeMm: 40, bold: true, centerV: true })
    : makeEl('DATE', { sizeMm: 8, bold: true, centerV: true });
  t.elements.push(e);
  center(t, e, true, true, S.nextNumber);
  switchTo(t);
  selIdx = 0; buildProps(); redraw();
  if (type !== 'DATE') editInline(e);
}

/** 그 종류 탭이 있으면 그 탭으로, 하나도 없을 때만 새로 만듦 */
function openOrCreateTab(type) {
  if (typeOf(tpl) === type) { toast(`지금 ${TITLE[type]} 탭입니다`); return; }
  for (const n of orderedTabs()) {
    const t = store.load(n);
    if (t && typeOf(t) === type) { switchTo(t); return; }
  }
  newTab(type);
}

/** 길게 누르면: 지금 라벨에 추가 (기존 글자 아래에 놓아 겹치지 않게) */
function addElement(type) {
  const e = type === 'TEXT' ? makeEl('TEXT', { text: '글자', sizeMm: 6 })
    : type === 'SERIAL' ? makeEl('SERIAL', { sizeMm: 14, bold: true })
    : makeEl('DATE', { sizeMm: 4 });
  let below = 0;
  for (const x of tpl.elements) {
    const b = bounds(tpl, x, S.nextNumber, previewFit());
    if (x.centerV) { x.y = Math.round(b.top); x.centerV = false; }   // 지금 자리에 고정
    below = Math.max(below, b.bottom);
  }
  tpl.elements.push(e);
  center(tpl, e, true, true, S.nextNumber, previewFit());
  if (below > 0) e.y = Math.round(below + 8);
  selIdx = tpl.elements.length - 1;
  changed(); buildProps();
  if (type === 'TEXT') editInline(e);
}

function tabMenu() {
  listSheet(`'${tpl.name}' 탭`, [
    { label: '이름 바꾸기', onClick: () => prompt2('탭 이름', tpl.name, n => {
      if (n === tpl.name || !checkNewName(n)) return;
      const old = tpl.name;
      S.tabOrder = S.tabOrder.map(x => x === old ? n : x);
      store.del(old); tpl.name = n; switchTo(tpl);
    }) },
    { label: `라벨 크기·간격 (${tpl.widthMm}×${tpl.heightMm}mm)`, onClick: labelSizeSheet },
    { label: '복제', onClick: () => {
      let n = tpl.name + ' 복사', k = 2;
      while (store.exists(n)) n = `${tpl.name} 복사 ${k++}`;
      const c = clone(tpl); c.name = n; switchTo(c);
    } },
    { label: '삭제', cls: 'danger', onClick: () => confirm2(`'${tpl.name}' 탭을 삭제할까요?`, '삭제', () => {
      const old = tpl.name; store.del(old); S.tabOrder = S.tabOrder.filter(x => x !== old);
      const first = orderedTabs()[0];
      switchTo(first ? store.load(first) : defaultTpl());
    }) },
  ]);
}
function checkNewName(n) {
  if (!n) { toast('이름을 입력하세요'); return false; }
  if (store.exists(n)) { toast('같은 이름이 이미 있습니다'); return false; }
  return true;
}
function defaultTpl() {
  const t = makeTpl('연속번호');
  const e = makeEl('SERIAL', { sizeMm: 40, bold: true, centerV: true });
  t.elements.push(e); center(t, e, true, true, 1);
  return t;
}
/** 라벨 크기 바꾸기. all=true 면 모든 탭에 같은 크기 */
function applyLabelSize(w, hh, g, all) {
  const W = clamp(int(w, tpl.widthMm), 10, 76), H = clamp(int(hh, tpl.heightMm), 10, 200), G = clamp(int(g, tpl.gapMm), 0, 10);
  if (all) {
    for (const n of orderedTabs()) {
      if (n === tpl.name) continue;
      const t = store.load(n); if (!t) continue;
      t.widthMm = W; t.heightMm = H; t.gapMm = G; store.save(t);
    }
  }
  tpl.widthMm = W; tpl.heightMm = H; tpl.gapMm = G;
  saveTpl(); bindTemplate();
  toast(`라벨 ${W}×${H}mm, 간격 ${G}mm` + (all ? ' — 모든 탭에 적용' : ''));
}
/** 라벨 크기 입력칸 묶음 (설정 창과 라벨 크기 창에서 같이 씀) */
function labelSizeFields() {
  const w = numInput(tpl.widthMm), hh = numInput(tpl.heightMm), g = numInput(tpl.gapMm);
  const box = h('div', {},
    h('div', { class: 'row' }, field('가로 mm', w), field('세로 mm', hh), field('간격 mm', g)),
    h('div', { class: 'hint' }, 'XP-365B 최대 인쇄 폭 76mm. 간격은 라벨 사이 빈칸(보통 2mm).'));
  return { box, w, hh, g };
}

function labelSizeSheet() {
  const f = labelSizeFields();
  openSheet(`라벨 크기 — '${tpl.name}' 탭`, f.box, [
    btn('모든 탭에', 'tonal', () => { closeSheet(); applyLabelSize(f.w.value, f.hh.value, f.g.value, true); }),
    btn('이 탭에 적용', 'primary', () => { closeSheet(); applyLabelSize(f.w.value, f.hh.value, f.g.value, false); })]);
}

// ═══════════════════════════ 편집 영역 (캔버스) ═══════════════════════════

const cv = $('#label');
let scale = 1;

function fitPaper() {
  const W = tpl.widthMm * DOTS, H = tpl.heightMm * DOTS, st = $('#stage');
  $('#sizeChip').textContent = `라벨 ${tpl.widthMm}×${tpl.heightMm}mm ▾`;
  scale = Math.max(0.1, Math.min((st.clientWidth - 24) / W, (st.clientHeight - 24) / H));
  cv.style.width = (W * scale) + 'px'; cv.style.height = (H * scale) + 'px';
}
function redraw() {
  if (!tpl) return;
  render(tpl, S.nextNumber, previewFit(), cv);
  fitPaper(); drawSel(); updateQuick();
  schedulePrepare();
}
function drawSel() {
  const box = $('#sel'), e = tpl.elements[selIdx];
  if (!e) { box.hidden = true; return; }
  const b = bounds(tpl, e, S.nextNumber, previewFit());
  Object.assign(box.style, {
    left: (b.left * scale - 4) + 'px', top: (b.top * scale - 4) + 'px',
    width: (b.w * scale + 8) + 'px', height: (b.h * scale + 8) + 'px',
  });
  box.hidden = false;
}
function changed() { redraw(); saveTpl(); updatePrintUI(); renderTabs(); }

function toDots(ev) {
  const r = cv.getBoundingClientRect();
  return { x: (ev.clientX - r.left) / r.width * tpl.widthMm * DOTS, y: (ev.clientY - r.top) / r.height * tpl.heightMm * DOTS };
}
function hitTest(p) {
  for (let i = tpl.elements.length - 1; i >= 0; i--) {   // 위에 그려진 것부터
    const b = bounds(tpl, tpl.elements[i], S.nextNumber, previewFit());
    if (p.x >= b.left - 6 && p.x <= b.right + 6 && p.y >= b.top - 6 && p.y <= b.bottom + 6) return i;
  }
  return -1;
}

let drag = null, suppressClick = false;
cv.addEventListener('pointerdown', ev => {
  if (!tpl) return;
  const p = toDots(ev), hit = hitTest(p);
  if (hit !== selIdx) { selIdx = hit; buildProps(); drawSel(); }
  drag = { x0: ev.clientX, y0: ev.clientY, moved: false, hit, dx: 0, dy: 0 };
  if (hit >= 0) {
    const b = bounds(tpl, tpl.elements[hit], S.nextNumber, previewFit());
    drag.dx = p.x - b.left; drag.dy = p.y - b.top;
  }
  try { cv.setPointerCapture(ev.pointerId); } catch (_) {}
});
cv.addEventListener('pointermove', ev => {
  if (!drag) return;
  if (!drag.moved && Math.hypot(ev.clientX - drag.x0, ev.clientY - drag.y0) < 8) return;
  drag.moved = true;
  if (!dragEnabled || drag.hit < 0) return;
  const e = tpl.elements[drag.hit], p = toDots(ev), W = tpl.widthMm * DOTS, H = tpl.heightMm * DOTS;
  const b = bounds(tpl, e, S.nextNumber, previewFit());
  let nx = p.x - drag.dx, ny = p.y - drag.dy;
  const snapX = !e.centerH && Math.abs(nx + b.w / 2 - W / 2) < 6;
  const snapY = Math.abs(ny + b.h / 2 - H / 2) < 6;
  if (snapX) nx = (W - b.w) / 2;
  if (snapY) ny = (H - b.h) / 2;
  if (!e.centerH) e.x = Math.round(nx);   // 가로 가운데 고정이면 위아래로만
  if (e.centerV && !snapY) e.centerV = false;   // 위아래로 옮기면 세로 가운데 고정 해제
  e.y = Math.round(ny);
  const nb = bounds(tpl, e, S.nextNumber, previewFit());   // 라벨 밖으로 못 나가게 실제 위치로 맞춤
  e.y = Math.round(nb.top); if (!e.centerH) e.x = Math.round(nb.left);
  $('#guideX').hidden = !snapX; $('#guideY').hidden = !snapY;
  redraw();
});
function endDrag() {
  if (!drag) return;
  if (drag.moved) { suppressClick = true; if (dragEnabled && drag.hit >= 0) { saveTpl(); updatePrintUI(); } }
  drag = null;
  $('#guideX').hidden = true; $('#guideY').hidden = true;
}
cv.addEventListener('pointerup', endDrag);
cv.addEventListener('pointercancel', endDrag);
// 톡 누르면 그 자리에서 바로 수정 (키보드가 뜨려면 click 안에서 열어야 함)
cv.addEventListener('click', ev => {
  if (suppressClick) { suppressClick = false; return; }
  const hit = hitTest(toDots(ev));
  if (hit >= 0) { selIdx = hit; drawSel(); editInline(tpl.elements[hit]); }
});

// ═══════════════════════════ 글자 바로 수정 ═══════════════════════════

function editInline(e) {
  const backup = JSON.stringify(e), bNext = S.nextNumber, bStart = S.rangeStart, bEnd = S.rangeEnd;
  const restore = () => {
    Object.assign(e, JSON.parse(backup));
    S.nextNumber = bNext; S.rangeStart = bStart; S.rangeEnd = bEnd; saveS();
    refreshNumbers(); redraw();
  };
  const body = h('div', {});
  let first = null;
  const add = (title, input) => { body.append(field(title, input)); if (!first) first = input; };
  if (e.type === 'TEXT') {
    const ta = h('textarea', { class: 'field', rows: 3, value: e.text });
    ta.addEventListener('input', () => { e.text = ta.value; redraw(); });
    add('글자 (줄바꿈 가능)', ta);
  } else if (e.type === 'SERIAL') {
    // "7-404" 처럼 통째로 입력 → 끝의 숫자만 늘어남 (7-404, 7-405 …)
    const inp = h('input', { class: 'field', value: content(e, S.nextNumber), autocomplete: 'off' });
    const hint = h('div', { class: 'hint', style: 'color:var(--primary)' });
    const showHint = () => { hint.textContent = '인쇄하면: ' + [0, 1, 2].map(i => content(e, S.nextNumber + i)).join(', ') + ' …'; };
    inp.addEventListener('input', () => {
      const m = /^(.*?)(\d+)(\D*)$/.exec(inp.value);
      if (!m) { e.prefix = inp.value; e.suffix = ''; }
      else {
        e.prefix = m[1]; e.suffix = m[3];
        e.digits = (m[2].length > 1 && m[2].startsWith('0')) ? m[2].length : 0;
        const n = int(m[2], S.nextNumber);
        S.nextNumber = n;
        if (n < S.rangeStart) S.rangeStart = n;
        if (n > S.rangeEnd) S.rangeEnd = n + 999;
        saveS();
      }
      showHint(); redraw();
    });
    add('시작 태그 (예: 7-404, A001)', inp);
    body.append(hint); showHint();
  } else {
    const inp = h('input', { class: 'field', value: e.dateFmt, autocomplete: 'off' });
    inp.addEventListener('input', () => { e.dateFmt = inp.value; redraw(); });
    add('날짜 형식 (예: yyyy.MM.dd)', inp);
  }
  openSheet(`${TITLE[e.type]} 수정`, body, [
    btn('취소', 'outline', () => { closeSheet(true); }),
    btn('확인', 'primary', () => { closeSheet(); saveTpl(); buildProps(); refreshNumbers(); updatePrintUI(); renderTabs(); }),
  ], restore);
  if (first) { first.focus(); if (first.select && e.type !== 'TEXT') first.select(); }
}

// ═══════════════════════════ 글자 크기 고정 줄 ═══════════════════════════

function updateQuick() {
  const q = $('#quick'), e = tpl && tpl.elements[selIdx];
  if (!e) { q.hidden = true; return; }
  q.hidden = false;
  $('#qSize').value = Math.round(e.sizeMm * 2);
  const real = effectiveSizeMm(tpl, e, S.nextNumber, previewFit());
  const v = $('#qVal'); v.innerHTML = '';
  v.append(`${e.sizeMm.toFixed(1)}mm`);
  if (real < e.sizeMm - 0.05) v.append(h('small', {}, `맞춤 ${real.toFixed(1)}`));   // 라벨에 맞춰 줄어든 실제 크기
}
function quickStep(d) {
  const e = tpl.elements[selIdx]; if (!e) return;
  e.sizeMm = clamp(Math.round((e.sizeMm + d) * 2) / 2, 1, 80);
  changed(); buildProps();
}
function quickFill() {
  const e = tpl.elements[selIdx]; if (!e) return;
  e.sizeMm = 80;
  e.sizeMm = Math.floor(effectiveSizeMm(tpl, e, S.nextNumber, previewFit()) * 10) / 10;
  if (e.centerH && !e.centerV) center(tpl, e, false, true, S.nextNumber, previewFit());
  changed(); buildProps();
}

// ═══════════════════════════ 속성 패널 ═══════════════════════════

function buildProps() {
  updateQuick();
  const box = $('#props'); box.innerHTML = '';
  const e = tpl.elements[selIdx];
  if (!e) {
    box.append(sec('편집', true), h('div', { class: 'hint' }, '라벨 위 글자를 누르면 바로 고칠 수 있어요.\n옮기려면 [🔒 위치 고정]을 눌러 잠금을 푸세요.'));
    return;
  }
  box.append(sec(`${TITLE[e.type]} 편집`, true));

  if (e.type === 'TEXT') {
    const ta = h('textarea', { class: 'field', rows: 2, value: e.text });
    ta.addEventListener('input', () => { e.text = ta.value; changed(); });
    box.append(field('내용 (줄바꿈 가능)', ta));
  } else if (e.type === 'SERIAL') {
    const pre = h('input', { class: 'field', value: e.prefix }), suf = h('input', { class: 'field', value: e.suffix });
    const dig = numInput(e.digits);
    pre.addEventListener('input', () => { e.prefix = pre.value; changed(); });
    suf.addEventListener('input', () => { e.suffix = suf.value; changed(); });
    dig.addEventListener('input', () => { e.digits = clamp(int(dig.value), 0, 10); changed(); });
    box.append(h('div', { class: 'row' }, field('앞글자', pre), field('뒷글자', suf), field('자릿수(0=그대로)', dig)),
      h('div', { class: 'hint' }, "번호는 아래 '다음 번호'와 '장수'로 정합니다."));
  } else {
    const f = h('input', { class: 'field', value: e.dateFmt });
    f.addEventListener('input', () => { e.dateFmt = f.value; changed(); });
    const presets = ['yyyy.MM.dd', 'yyyy-MM-dd', 'yy.MM.dd', 'MM/dd', 'M월 d일', 'yyyy년 M월 d일', 'MM.dd(E)', 'yyyy.MM.dd HH:mm'];
    box.append(h('div', { class: 'row' },
      h('div', { style: 'flex:2.5 1 0' }, field('날짜 형식', f)),
      h('div', { class: 'f', style: 'flex:1 1 0' }, h('span', {}, ' '), btn('형식 ▾', 'outline', () =>
        listSheet('날짜 형식', presets.map(p => ({ label: `${p}   →  ${fmtDate(p)}`, onClick: () => { f.value = p; e.dateFmt = p; changed(); } })))))));
  }

  // 글꼴 (버튼 글자도 그 글꼴로)
  const fi = fontInfo(e.font);
  const fb = btn(fi.name + '  ▾', 'outline', () => fontSheet(e));
  fb.style.fontFamily = isFileFont(fi) ? `"${fi.family}",${GOTHIC}` : fi.family;
  fb.style.width = '100%'; fb.style.fontSize = '15px';
  box.append(h('div', { class: 'lbl' }, '글꼴'), fb);

  // 크기
  const val = h('div', { class: 'val' });
  const bar = h('input', { type: 'range', min: 2, max: 160, step: 1, value: Math.round(e.sizeMm * 2) });
  const showSize = () => {
    const real = effectiveSizeMm(tpl, e, S.nextNumber, previewFit());
    val.innerHTML = '';
    val.append(`${e.sizeMm.toFixed(1)} mm`);
    if (real < e.sizeMm - 0.05) val.append(h('small', {}, `맞춤 ${real.toFixed(1)}`));
  };
  bar.addEventListener('input', () => { e.sizeMm = int(bar.value) / 2; showSize(); redraw(); });
  bar.addEventListener('change', () => { saveTpl(); updatePrintUI(); });
  const step = d => { e.sizeMm = clamp(e.sizeMm + d, 1, 80); bar.value = Math.round(e.sizeMm * 2); showSize(); changed(); };
  showSize();
  box.append(
    h('div', { class: 'row', style: 'margin-top:4px' }, h('div', { class: 'lbl' }, '글자 크기'),
      btn('라벨에 꽉 채우기', 'tonal', quickFill)),
    h('div', { class: 'row' }, btn('−', 'outline', () => step(-0.5)), h('div', { style: 'flex:3 1 0' }, bar), btn('+', 'outline', () => step(0.5)), val));

  // 장평
  const sval = h('div', { class: 'val' }, `${Math.round(e.scaleX * 100)}%`);
  const sbar = h('input', { type: 'range', min: 50, max: 200, step: 1, value: Math.round(e.scaleX * 100) });
  sbar.addEventListener('input', () => { e.scaleX = int(sbar.value) / 100; sval.textContent = `${sbar.value}%`; redraw(); });
  sbar.addEventListener('change', () => { saveTpl(); });
  box.append(h('div', { class: 'lbl' }, '장평 (글자 가로 폭)'), h('div', { class: 'row' }, h('div', { style: 'flex:4 1 0' }, sbar), sval));

  // 스타일
  const tog = (label, key) => {
    const b = btn(label, e[key] ? 'outline sel' : 'outline', () => { e[key] = !e[key]; b.classList.toggle('sel', e[key]); changed(); });
    return b;
  };
  box.append(h('div', { class: 'checks' }, tog('굵게', 'bold'), tog('기울임', 'italic'), tog('밑줄', 'underline'), tog('반전', 'invert')));

  box.append(switchRow('가로 가운데 고정 (끄면 좌우로도 옮길 수 있음)', e.centerH, on => {
    if (!on) e.x = Math.round(bounds(tpl, e, S.nextNumber, previewFit()).left);
    e.centerH = on; changed();
  }));
  box.append(switchRow('세로 가운데 고정 (번호 길이가 바뀌어도 위아래 가운데)', e.centerV, on => {
    if (!on) e.y = Math.round(bounds(tpl, e, S.nextNumber, previewFit()).top);
    e.centerV = on; changed();
  }));
  box.append(h('div', { class: 'lbl' }, '회전'), segmented(['0°', '90°', '180°', '270°'], e.rotation / 90, i => { e.rotation = i * 90; changed(); }));
  box.append(h('div', { class: 'lbl' }, '줄 정렬 (여러 줄일 때)'), segmented(['왼쪽', '가운데', '오른쪽'], e.align, i => { e.align = i; changed(); }));
}

function fontSheet(e) {
  const list = h('div', { class: 'list' });
  const all = [...FONTS, ...userFonts];
  const cur = fontInfo(e.font).key;
  for (const f of all) {
    const pv = h('span', { class: 'pv' }, '가나다 ABC 0123456789');
    pv.style.fontFamily = isFileFont(f) ? `"${f.family}",${GOTHIC}` : f.family;
    pv.style.fontWeight = f.weight || 400;
    if (isFileFont(f)) ensureFont(f.key);   // 목록을 여는 동안 미리보기 글꼴을 차례로 받아옴
    list.append(h('button', { class: f.key === cur ? 'cur' : '', type: 'button', onclick: () => {
      e.font = f.key; closeSheet();
      ensureFont(f.key).then(() => { changed(); buildProps(); });
      changed(); buildProps();
    } }, (f.key === cur ? '✓  ' : '') + f.name, pv));
  }
  const picker = h('input', { type: 'file', accept: '.ttf,.otf,.ttc,font/ttf,font/otf', style: 'display:none' });
  picker.addEventListener('change', async () => {
    const file = picker.files && picker.files[0];
    if (!file) return;
    if (!/\.(ttf|otf|ttc)$/i.test(file.name)) { toast('TTF/OTF 파일만 됩니다'); return; }
    try {
      const buf = await file.arrayBuffer();
      await new FontFace('TPTEST', buf).load();          // 읽을 수 있는 글꼴인지 확인
      await idb.put(file.name, buf);
      const key = addUserFont(file.name, buf);
      await ensureFont(key);
      e.font = key; closeSheet(); changed(); buildProps();
      toast('글꼴 추가됨: ' + file.name);
    } catch (err) { toast('글꼴을 읽을 수 없습니다'); }
  });
  list.append(h('button', { type: 'button', style: 'color:var(--primary);font-weight:700', onclick: () => picker.click() }, '+ 글꼴 파일 추가 (TTF/OTF)'));
  openSheet('글꼴', h('div', {}, list, picker), [btn('닫기', 'outline', closeSheet)]);
}

// ═══════════════════════════ 번호·인쇄 ═══════════════════════════

function refreshNumbers() {
  $('#next').value = S.nextNumber;
  $('#count').value = S.printCount;
  updatePrintUI();
}
function setNext(v) { S.nextNumber = Math.max(0, v); saveS(); refreshNumbers(); redraw(); }
function setCount(v) { S.printCount = clamp(v, 1, 9999); saveS(); refreshNumbers(); redraw(); }

function updatePrintUI() {
  if (printing || !tpl) return;
  const pb = $('#print'), prog = $('#progress');
  pb.textContent = '인쇄';
  if (!hasSerial()) { $('#numberRow').hidden = true; pb.disabled = false; return; }
  $('#numberRow').hidden = false;
  const r = planned();
  pb.disabled = !r;
  if (!r) {
    prog.textContent = S.rangeEnd < S.rangeStart ? '범위 끝이 시작보다 작습니다' : '범위 끝까지 다 뽑았습니다 → [번호 설정]에서 처음부터';
  } else if (!prog.dataset.keep) {
    const left = S.rangeEnd - Math.max(S.nextNumber, S.rangeStart) + 1;
    prog.textContent = `범위 ${S.rangeStart}~${S.rangeEnd} 중 남은 번호 ${left}개`;
  }
  schedulePrepare();
}
function setProgress(text, keep = true) {
  const p = $('#progress'); p.textContent = text;
  if (keep) p.dataset.keep = '1'; else delete p.dataset.keep;
}
function setBusy(b) {
  $('#cancel').hidden = !b;
  $('#reprint').disabled = b || lastPrinted < 0;
  if (b) { $('#print').disabled = true; $('#print').textContent = '인쇄중'; }
  else updatePrintUI();
}

async function startPrint() {
  if (printing) return;
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  // 프린터 고르기는 누른 그 순간에만 가능하므로 가장 먼저
  if (!(await ensurePrinter())) return;
  if (!hasSerial()) return printTextLabel();
  const r = planned();
  if (!r) { toast('남은 번호가 없습니다. [번호 설정]에서 처음부터를 누르세요'); return; }
  const [start, endN] = r, count = endN - start + 1, fit = endN, copies = S.copies;
  const t = clone(tpl);   // 인쇄 중 편집해도 영향 없게
  printing = true; cancelReq = false; setBusy(true);
  await ensureFonts(t);
  // 연속 인쇄: 보내는 동안 다음 라벨을 미리 그려 둠(최대 3장 앞서) → 장 사이에 쉬지 않음
  const queue = []; let stop = false;
  const first = takePrepared(t, start, fit, copies);
  const producer = (async () => {
    for (let i = 0; i < count && !stop && !cancelReq; i++) {
      while (queue.length >= 3 && !stop && !cancelReq) await sleep(4);
      const n = start + i;
      const job = (i === 0 && first) ? first : tsplJob(t, render(t, n, fit), copies, i === 0);
      queue.push([n, job]);
      await sleep(0);
    }
  })();
  let done = 0, err = null, bytes = 0;
  const t0 = performance.now();
  try {
    for (let i = 0; i < count; i++) {
      if (cancelReq) break;
      while (!queue.length) await sleep(2);
      const [n, job] = queue.shift();
      await sendJob(job);
      bytes = job.length;
      S.nextNumber = n + 1; saveS();          // 한 장 보낼 때마다 저장 → 끊겨도 이어서 인쇄
      lastPrinted = n; lastFit = fit; done++;
      setProgress(`${n} 보냄  (${done}/${count})`);
    }
  } catch (e) { err = (e && e.message) || '인쇄 실패'; }
  stop = true; await producer.catch(() => {});
  if (done > 0) history.add({ time: Date.now(), template: t, from: start, to: start + done - 1, copies });
  printing = false;
  const left = Math.max(0, S.rangeEnd - S.nextNumber + 1);
  if (err) setProgress(`⚠ ${done}/${count}장 보낸 뒤 중단: ${err}\n인쇄를 다시 누르면 ${S.nextNumber}번부터 이어서 나옵니다`);
  else if (cancelReq) setProgress(`중지됨 — ${done}/${count}장 보냄 (다음 ${S.nextNumber}번)`);
  else setProgress(`완료 — ${start} ~ ${start + done - 1} (${done}장) · 남은 번호 ${left}개\n전송 ${((performance.now() - t0) / 1000).toFixed(1)}초 (장당 ${(bytes / 1024).toFixed(1)}KB)`);
  setBusy(false); refreshNumbers(); redraw();
}

/** 글자만 있는 라벨: 한 장 인쇄 (번호 안 넘어감), 최근 인쇄에 기록 */
async function printTextLabel() {
  const t = clone(tpl);
  printing = true; cancelReq = false; setBusy(true);
  let err = null;
  try {
    await ensureFonts(t);
    const job = takePrepared(t, 0, 0, 1) || tsplJob(t, render(t, 0), 1, true);
    await sendJob(job);
    history.add({ time: Date.now(), template: t, from: 0, to: 0, copies: 1 });
  } catch (e) { err = (e && e.message) || '인쇄 실패'; }
  printing = false; setBusy(false);
  setProgress(err ? `⚠ ${err}` : '인쇄함');
}

async function printOnce(n, fit) {
  if (printing) return;
  if (!(await ensurePrinter())) return;
  const t = clone(tpl), f = Math.max(n, fit ?? fitNum());
  printing = true; setBusy(true);
  let err = null;
  try { await ensureFonts(t); await sendJob(tsplJob(t, render(t, n, f), 1, true)); }
  catch (e) { err = (e && e.message) || '인쇄 실패'; }
  printing = false; setBusy(false);
  setProgress(err ? `⚠ ${err}` : `${n} 인쇄함`);
}

function numberSettings() {
  const st = numInput(S.rangeStart), en = numInput(S.rangeEnd), cp = numInput(S.copies);
  const apply = () => {
    S.rangeStart = Math.max(0, int(st.value, S.rangeStart));
    S.rangeEnd = Math.max(0, int(en.value, S.rangeEnd));
    S.copies = clamp(int(cp.value, S.copies), 1, 20);
    saveS();
  };
  openSheet('번호 설정', h('div', {},
    h('div', { class: 'row' }, field('번호 범위 시작', st), field('끝', en)),
    h('div', { class: 'hint' }, '인쇄는 이 범위 안에서만 됩니다. 끝 번호를 넘으면 멈춥니다.'),
    field('같은 번호를 몇 장씩 (보통 1)', cp)),
    [btn('처음부터', 'tonal', () => { apply(); closeSheet(); setProgress('', false); setNext(S.rangeStart); }),
     btn('확인', 'primary', () => {
       apply(); closeSheet();
       if (S.nextNumber < S.rangeStart) S.nextNumber = S.rangeStart;
       saveS(); setProgress('', false); refreshNumbers(); redraw();
     })]);
}

// ═══════════════════════════ 최근 인쇄 ═══════════════════════════

/** 실제 인쇄된 라벨 그림을 2열로 (글자 목록보다 헷갈리지 않게) */
function historySheet() {
  const list = history.all();
  if (!list.length) { toast('아직 인쇄한 기록이 없습니다'); return; }
  const grid = h('div', { class: 'grid' });
  list.forEach((rec, i) => {
    const t = normTpl(clone(rec.template));
    const img = h('img', { alt: '' });
    const draw = () => { img.src = render(t, rec.from, Math.max(rec.from, rec.to)).toDataURL(); };
    draw(); ensureFonts(t).then(draw);
    const d = new Date(rec.time);
    const time = `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const serial = t.elements.find(e => e.type === 'SERIAL');
    const range = (serial && rec.from !== rec.to) ? `~ ${content(serial, rec.to)}  ` : '';
    const count = rec.to - rec.from + 1;
    grid.append(h('button', { class: 'cell', type: 'button', onclick: () => { closeSheet(); historyItem(rec, i); } },
      img, h('div', {}, `${range}${count}장`, h('br'), time)));
  });
  openSheet('최근 인쇄 — 눌러서 선택', grid, [
    btn('전체 지우기', 'danger', () => { closeSheet(); confirm2('최근 인쇄 기록을 모두 지울까요?', '지우기', () => history.clear()); }),
    btn('닫기', 'outline', closeSheet)]);
}
function historyItem(rec, index) {
  const t = normTpl(clone(rec.template));
  const serial = t.elements.some(e => e.type === 'SERIAL');
  const count = rec.to - rec.from + 1;
  const items = serial ? [
    { label: `불러와서 수정하기 (${rec.from}번부터 ${count}장)`, onClick: () => loadRecord(rec, rec.from) },
    { label: `이어서 인쇄 준비 (${rec.to + 1}번부터 ${count}장)`, onClick: () => loadRecord(rec, rec.to + 1) },
    { label: '똑같이 다시 인쇄 (바로 인쇄)', onClick: () => { loadRecord(rec, rec.from); startPrint(); } },
    { label: '기록 삭제', cls: 'danger', onClick: () => history.remove(index) },
  ] : [
    { label: '불러와서 수정하기', onClick: () => loadRecord(rec, rec.from) },
    { label: '똑같이 다시 인쇄 (바로 인쇄)', onClick: () => { loadRecord(rec, rec.from); startPrint(); } },
    { label: '기록 삭제', cls: 'danger', onClick: () => history.remove(index) },
  ];
  listSheet(`${t.name} · ${count}장`, items);
}
/** 기록의 라벨 디자인을 불러오고 번호·장수를 맞춤. 디자인은 그 탭 이름으로 저장됨 */
function loadRecord(rec, from) {
  const t = normTpl(clone(rec.template));
  if (!t.name) t.name = '최근 인쇄';
  switchTo(t);
  setProgress('', false);
  if (!t.elements.some(e => e.type === 'SERIAL')) { toast('불러왔습니다'); return; }   // 글자만 있는 기록은 번호를 건드리지 않음
  const count = rec.to - rec.from + 1;
  S.copies = rec.copies || 1; S.printCount = count; S.nextNumber = from;
  if (from < S.rangeStart) S.rangeStart = from;
  if (from + count - 1 > S.rangeEnd) S.rangeEnd = from + count - 1;
  saveS(); refreshNumbers(); redraw();
  toast('불러왔습니다 — 글자를 눌러 고친 뒤 [인쇄]');
}

// ═══════════════════════════ 프린터 메뉴 · 설정 ═══════════════════════════

function printerMenu() {
  if (!bleSupported()) { showNoBle(); return; }
  listSheet('프린터', [
    { label: '다시 연결', onClick: () => userReconnect() },
    { label: S.deviceName ? '다른 프린터 찾기' : '프린터 찾기', onClick: () => pickPrinter(true) },
    { label: '연결 끊기', onClick: disconnect },
    { label: '프린터 설정', onClick: settingsSheet },
  ]);
}

function settingsSheet() {
  const num = (key, signed) => {
    const i = numInput(S[key], signed);
    i.addEventListener('input', () => { const v = int(i.value, NaN); if (Number.isFinite(v)) { S[key] = v; saveS(); } });
    return i;
  };
  const lf = labelSizeFields();
  const body = h('div', {},
    sec(`라벨 크기 — '${tpl.name}' 탭`, true),
    lf.box,
    h('div', { class: 'row' },
      btn('이 탭에 적용', 'primary', () => { applyLabelSize(lf.w.value, lf.hh.value, lf.g.value, false); }),
      btn('모든 탭에 적용', 'tonal', () => { applyLabelSize(lf.w.value, lf.hh.value, lf.g.value, true); })),
    sec('인쇄'),
    h('div', { class: 'row' }, field('농도 (0~15)', num('density')), field('속도 (1~6)', num('speed'))),
    h('div', { class: 'row' }, field('가로 보정 (dot)', num('offsetX', true)), field('세로 보정 (dot)', num('offsetY', true))),
    switchRow('출력 방향 180° 뒤집기', S.flip180, v => { S.flip180 = v; saveS(); }),
    sec('연결'),
    h('div', { class: 'row' },
      btn(S.deviceName ? '다른 프린터 찾기' : '프린터 찾기', 'tonal', () => pickPrinter(true)),
      btn('연결 끊기', 'outline', disconnect)),
    sec('블루투스 전송'),
    field('확인 간격 — 1 안전 · 4 기본 · 클수록 빠름', num('syncEvery')),
    field('조각 크기 (byte) — 기본 180, 깨지면 100', num('chunk')),
    field('패킷 간격 ms — 깨지면 5~20', num('gapMs')),
    switchRow('빠른 전송 (깨질 수 있음)', S.fast, v => { S.fast = v; saveS(); }),
    h('div', { class: 'row', style: 'margin-top:12px' }, btn('테스트 인쇄 (번호 안 넘어감)', 'tonal', () => { closeSheet(); printOnce(S.nextNumber); })),
    h('div', { class: 'hint' }, `블루투스: ${bleSupported() ? '사용 가능' : '이 브라우저는 지원 안 함'} · 저장 위치: 이 기기 브라우저`),
  );
  openSheet('프린터 설정', body, [btn('닫기', 'outline', closeSheet)]);
}

function showNoBle(open = true) {
  setStatus('err', '블루투스 미지원 브라우저');
  if (!open) return;
  openSheet('블루투스를 쓸 수 없는 브라우저', h('div', {},
    h('p', { style: 'line-height:1.6;margin:4px 0' }, '사파리와 아이폰 크롬은 웹페이지에서 블루투스를 쓸 수 없습니다.'),
    h('p', { style: 'line-height:1.6;margin:4px 0' }, '아이폰은 App Store에서 ', h('b', {}, 'Bluefy – Web BLE Browser'), ' 앱을 설치한 뒤, 그 앱에서 이 주소를 열어 주세요.'),
    h('p', { style: 'line-height:1.6;margin:4px 0;color:var(--sub);font-size:13px' }, location.href)),
    [btn('주소 복사', 'outline', async () => { try { await navigator.clipboard.writeText(location.href); toast('복사했습니다'); } catch (_) { toast(location.href); } }),
     btn('Bluefy 받기', 'primary', () => { location.href = 'https://apps.apple.com/app/id1492822055'; })]);
}

// ═══════════════════════════ 시트 · 위젯 ═══════════════════════════

let sheetCancel = null;
function openSheet(title, body, actions, onCancel) {
  const sh = $('#sheet');
  sh.innerHTML = '';
  sh.append(h('div', { class: 'grab' }), title ? h('h2', {}, title) : null, body);
  if (actions && actions.length) sh.append(h('div', { class: 'actions' }, ...actions));
  sheetCancel = onCancel || null;
  $('#scrim').hidden = false; sh.hidden = false;
}
function closeSheet(cancelled = false) {
  const fn = sheetCancel; sheetCancel = null;
  $('#sheet').hidden = true; $('#scrim').hidden = true; $('#sheet').innerHTML = '';
  if (cancelled && fn) fn();
}
function listSheet(title, items) {
  openSheet(title, h('div', { class: 'list' }, ...items.map(it =>
    h('button', { type: 'button', style: it.cls === 'danger' ? 'color:var(--red)' : '', onclick: () => { closeSheet(); it.onClick(); } }, it.label))),
  [btn('닫기', 'outline', () => closeSheet(true))]);
}
function prompt2(title, initial, onOk) {
  const inp = h('input', { class: 'field', value: initial, autocomplete: 'off' });
  openSheet(title, inp, [btn('취소', 'outline', () => closeSheet(true)), btn('확인', 'primary', () => { closeSheet(); onOk(inp.value.trim()); })]);
  inp.focus(); inp.select();
}
function confirm2(msg, okLabel, onOk) {
  openSheet(null, h('p', { style: 'font-size:16px;line-height:1.5;margin:8px 0' }, msg),
    [btn('취소', 'outline', () => closeSheet(true)), btn(okLabel, 'danger', () => { closeSheet(); onOk(); })]);
}

function btn(label, cls, onClick) { return h('button', { class: 'btn ' + cls, type: 'button', onclick: onClick }, label); }
function sec(text, first) { return h('div', { class: 'sec' + (first ? ' first' : '') }, text); }
function field(label, input) { return h('label', { class: 'f' }, h('span', {}, label), input); }
function numInput(v, signed) {
  return h('input', { class: 'field', type: signed ? 'text' : 'number', inputmode: signed ? 'text' : 'numeric', value: String(v), style: 'text-align:center' });
}
function switchRow(label, on, onChange) {
  const inp = h('input', { type: 'checkbox', checked: on });
  inp.addEventListener('change', () => onChange(inp.checked));
  return h('label', { class: 'switch' }, h('span', {}, label), inp);
}
function segmented(options, current, onPick) {
  const bs = options.map((o, i) => btn(o, i === current ? 'outline sel' : 'outline', () => {
    bs.forEach((b, j) => b.classList.toggle('sel', j === i)); onPick(i);
  }));
  return h('div', { class: 'row' }, ...bs);
}
/** 길게 누르기 (탭 메뉴 · 지금 라벨에 추가) */
function onLongPress(el, fn, ms = 500) {
  let timer = 0, fired = false, x0 = 0, y0 = 0;
  el.addEventListener('pointerdown', ev => { fired = false; x0 = ev.clientX; y0 = ev.clientY; timer = setTimeout(() => { fired = true; fn(); }, ms); });
  el.addEventListener('pointermove', ev => { if (Math.hypot(ev.clientX - x0, ev.clientY - y0) > 10) clearTimeout(timer); });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach(t => el.addEventListener(t, () => clearTimeout(timer)));
  el.addEventListener('click', ev => { if (fired) { ev.stopImmediatePropagation(); ev.preventDefault(); fired = false; } }, true);
  el.addEventListener('contextmenu', ev => ev.preventDefault());
}
let toastTimer = 0;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2200);
}

// ═══════════════════════════ 시작 ═══════════════════════════

function wire() {
  $('#status').addEventListener('click', printerMenu);
  $('#gear').addEventListener('click', settingsSheet);
  $('#sizeChip').addEventListener('click', labelSizeSheet);
  $('#qMinus').addEventListener('click', () => quickStep(-1));
  $('#qPlus').addEventListener('click', () => quickStep(1));
  $('#qFill').addEventListener('click', quickFill);
  $('#qSize').addEventListener('input', () => {
    const e = tpl.elements[selIdx]; if (!e) return;
    e.sizeMm = int($('#qSize').value) / 2; redraw();
  });
  $('#qSize').addEventListener('change', () => { saveTpl(); updatePrintUI(); buildProps(); });
  $('#undo').addEventListener('click', undo);
  $('#redo').addEventListener('click', redo);
  $('#recent').addEventListener('click', historySheet);
  $('#scrim').addEventListener('click', () => closeSheet(true));

  document.querySelectorAll('#typeRow .btn').forEach(b => {
    onLongPress(b, () => addElement(b.dataset.type));
    b.addEventListener('click', () => openOrCreateTab(b.dataset.type));
  });
  document.querySelectorAll('[data-nudge]').forEach(b => b.addEventListener('click', () => {
    const e = tpl.elements[selIdx]; if (!e) return;
    const [dx, dy] = b.dataset.nudge.split(',').map(Number);
    const b0 = bounds(tpl, e, S.nextNumber, previewFit());
    if (dx && e.centerH) { e.x = Math.round(b0.left); e.centerH = false; buildProps(); }   // 좌우로 옮기면 가로 고정 해제
    if (dy && e.centerV) { e.y = Math.round(b0.top); e.centerV = false; buildProps(); }    // 위아래로 옮기면 세로 고정 해제
    e.x += dx; e.y += dy; changed();
  }));
  $('#centerH').addEventListener('click', () => {
    const e = tpl.elements[selIdx]; if (!e) return;
    e.centerH = true; center(tpl, e, true, false, S.nextNumber, previewFit()); changed(); buildProps();
  });
  $('#centerV').addEventListener('click', () => {
    const e = tpl.elements[selIdx]; if (!e) return;
    e.centerV = true; center(tpl, e, false, true, S.nextNumber, previewFit()); changed(); buildProps();
  });
  $('#lock').addEventListener('click', () => {
    dragEnabled = !dragEnabled;
    const b = $('#lock');
    b.textContent = dragEnabled ? '✋ 끌어서 이동' : '🔒 위치 고정';
    b.className = 'btn wider ' + (dragEnabled ? 'primary' : 'outline');
    toast(dragEnabled ? '라벨 위 글자를 끌어서 옮기세요' : '위치 고정 — 글자를 누르면 수정');
  });
  $('#dup').addEventListener('click', () => {
    const e = tpl.elements[selIdx]; if (!e) return;
    const c = clone(e); c.x += 16; c.y += 16; tpl.elements.push(c); selIdx = tpl.elements.length - 1;
    changed(); buildProps();
  });
  $('#del').addEventListener('click', () => {
    if (selIdx < 0 || selIdx >= tpl.elements.length) return;
    tpl.elements.splice(selIdx, 1); selIdx = -1; changed(); buildProps();
  });

  $('#next').addEventListener('input', () => { const v = int($('#next').value, NaN); if (Number.isFinite(v)) { S.nextNumber = Math.max(0, v); saveS(); setProgress('', false); updatePrintUI(); redraw(); } });
  $('#count').addEventListener('input', () => { const v = int($('#count').value, NaN); if (Number.isFinite(v)) { S.printCount = clamp(v, 1, 9999); saveS(); setProgress('', false); updatePrintUI(); redraw(); } });
  $('#cMinus').addEventListener('click', () => setCount(S.printCount - 1));
  $('#cPlus').addEventListener('click', () => setCount(S.printCount + 1));
  $('#numSet').addEventListener('click', numberSettings);
  $('#print').addEventListener('click', startPrint);
  $('#reprint').addEventListener('click', () => { if (lastPrinted >= 0) printOnce(lastPrinted, lastFit); });
  $('#cancel').addEventListener('click', () => { cancelReq = true; });

  window.addEventListener('resize', () => { if (tpl) { fitPaper(); drawSel(); } });
  // 다른 앱 갔다가 돌아오거나 화면을 다시 켜면 바로 다시 붙이기
  document.addEventListener('visibilitychange', () => { if (!document.hidden) restoreDevice(); });
  window.addEventListener('pageshow', () => restoreDevice());
  window.addEventListener('focus', () => restoreDevice());
  // 화면이 켜져 있는 동안 20초마다 점검 (끊김 이벤트를 놓친 경우 대비)
  setInterval(() => { if (!document.hidden && P.device && !isConnected() && !P.connecting && !P.userClosed && !printing) scheduleReconnect(); }, 20000);
}

function init() {
  // 첫 실행: 연속번호 탭 하나
  if (!store.names().length) {
    const t = defaultTpl(); store.save(t);
    S.tabOrder = [t.name]; S.current = t.name; saveS();
  }
  tpl = store.load(S.current) || store.load(orderedTabs()[0]);
  S.current = tpl.name; saveS();
  selIdx = tpl.elements.length ? 0 : -1;
  wire();
  bindTemplate();
  resetUndo();
  restoreDevice();
  loadUserFonts();
}

init();

const byId = (id) => document.getElementById(id);
const storageKey = 'simji-ledger-v1';
const memberStorageKey = 'simji-member-v1';
const sessionStorageKey = 'simji-session-v1';
const openingBalance = 1340278;
const members = ['종남', '인기', '상훈', '민철', '공근', '성호'];
const treasurerMember = '성호';
const apiUrl = (window.SIMJI_CONFIG?.apiUrl || '').replace(/\/$/, '');
const cloudMode = Boolean(apiUrl);

let selectedFile = null;
let selectedIncomeFile = null;
let activeFilter = 'all';
let activeMember = '';
let recordsCache = [];
let toastTimer;
let activeView = 'ledger';
let activeMediaFilter = 'all';
let mediaItems = [];
let mediaNextCursor = '';
let mediaHasMore = true;
let mediaLoading = false;
let selectedMediaFiles = [];
let mediaPreviewUrls = [];
let mediaPhotoMetadata = [];
let mediaPhotoMetadataLoading = false;
let mediaSelectionVersion = 0;
let activeMediaDetailId = '';
let photoViewerRequestId = 0;
const photoObjectUrls = new Map();
const photoSourceUrls = new Map();
let photoTransitionBusy = false;
const landscapeMediaQuery = window.matchMedia('(orientation: landscape)');
const themeColorMeta = document.querySelector('meta[name="theme-color"]');
const defaultThemeColor = themeColorMeta?.getAttribute('content') || '#f8f8f4';
let mediaObserver;
let serviceWorkerRegistration;
let serviceWorkerReloading = false;
let pendingAppUpdate = false;

function hasOpenModal() {
  return Array.from(document.querySelectorAll('.modal-backdrop')).some((backdrop) => !backdrop.hidden);
}
function syncModalScrollLock() {
  const locked = hasOpenModal();
  document.documentElement.classList.toggle('modal-open', locked);
  document.body.classList.toggle('modal-open', locked);
}
function isSafeToReload() {
  const activeElement = document.activeElement;
  const activeField = activeElement?.matches('input, textarea, select')
    && !activeElement.closest('[hidden]');
  return !hasOpenModal() && !activeField;
}
function applyPendingAppUpdate() {
  if (!pendingAppUpdate || !isSafeToReload()) return;
  pendingAppUpdate = false;
  serviceWorkerReloading = true;
  window.location.reload();
}
function reloadForAppUpdate() {
  if (serviceWorkerReloading) return;
  if (!isSafeToReload()) {
    pendingAppUpdate = true;
    showToast('새 화면이 준비됐어요. ↻ 버튼을 눌러 적용하세요.');
    return;
  }
  serviceWorkerReloading = true;
  window.location.reload();
}

if ('serviceWorker' in navigator) {
  let hadServiceWorkerController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadServiceWorkerController) {
      hadServiceWorkerController = true;
      return;
    }
    reloadForAppUpdate();
  });

  window.addEventListener('load', async () => {
    try {
      serviceWorkerRegistration = await navigator.serviceWorker.register('/service-worker.js', { updateViaCache: 'none' });
      const checkForUpdate = () => serviceWorkerRegistration.update().catch(() => undefined);
      checkForUpdate();
      window.setInterval(checkForUpdate, 15 * 60 * 1000);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') checkForUpdate();
      });
    } catch {
      // The app still works online when a browser blocks service workers.
    }
  });
}

function formatMoney(value) { return `₩${Number(value || 0).toLocaleString('ko-KR')}`; }
function formatAmountInput(value) {
  const digits = String(value || '').replace(/[^0-9]/g, '');
  return digits ? Number(digits).toLocaleString('ko-KR') : '';
}
function parseAmountInput(value) { return Number(String(value || '').replace(/[^0-9]/g, '')); }
function enableAmountCommas(input) {
  if (!input) return;
  input.type = 'text';
  input.inputMode = 'numeric';
  input.value = formatAmountInput(input.value);
  input.addEventListener('input', () => { input.value = formatAmountInput(input.value); });
}
function formatDate(value) {
  const date = new Date(`${value}T00:00:00`);
  return `${date.getMonth() + 1}월 ${date.getDate()}일`;
}
function escapeHtml(text = '') {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
function getLocalRecords() {
  try { return JSON.parse(localStorage.getItem(storageKey)) || []; }
  catch { return []; }
}
function saveLocalRecords(records) { localStorage.setItem(storageKey, JSON.stringify(records)); }
function showToast(message) {
  const toast = byId('toast');
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add('show');
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2600);
}
function todayInKorea() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const part = (type) => parts.find((item) => item.type === type).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function isLikelyImage(file) {
  return /^image\//i.test(file?.type || '') || /\.(avif|gif|heic|heif|jpe?g|png|webp)$/i.test(file?.name || '');
}
function numberPad(value) { return String(value).padStart(2, '0'); }
function dateFromMillis(value) {
  const date = new Date(Number(value));
  if (Number.isNaN(date.getTime())) return { date: todayInKorea(), capturedAt: '' };
  return {
    date: `${date.getFullYear()}-${numberPad(date.getMonth() + 1)}-${numberPad(date.getDate())}`,
    capturedAt: `${date.getFullYear()}-${numberPad(date.getMonth() + 1)}-${numberPad(date.getDate())}T${numberPad(date.getHours())}:${numberPad(date.getMinutes())}:${numberPad(date.getSeconds())}`,
  };
}
function parseExifDate(value) {
  const matched = String(value || '').trim().match(/^(\d{4}):(\d{2}):(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (!matched) return null;
  const [, year, month, day, hour, minute, second] = matched;
  const stamp = `${year}-${month}-${day}T${hour}:${minute}:${second}`;
  const checked = new Date(`${stamp}Z`);
  if (Number.isNaN(checked.getTime()) || checked.getUTCFullYear() !== Number(year) || checked.getUTCMonth() + 1 !== Number(month) || checked.getUTCDate() !== Number(day)) return null;
  return { date: `${year}-${month}-${day}`, capturedAt: stamp };
}
function readAscii(bytes, start, length) {
  if (start < 0 || length < 0 || start + length > bytes.length) return '';
  let output = '';
  for (let index = start; index < start + length; index += 1) {
    const value = bytes[index];
    if (!value) break;
    output += String.fromCharCode(value);
  }
  return output;
}
function hasBytes(bytes, start, expected) {
  return start >= 0 && start + expected.length <= bytes.length && expected.every((value, index) => bytes[start + index] === value);
}
function readUint64Safe(view, offset, littleEndian) {
  const high = view.getUint32(offset + (littleEndian ? 4 : 0), littleEndian);
  const low = view.getUint32(offset + (littleEndian ? 0 : 4), littleEndian);
  const value = high * 4294967296 + low;
  return Number.isSafeInteger(value) ? value : 0;
}
function parseTiffExif(bytes, start, end = bytes.length) {
  try {
    if (start < 0 || start + 8 > end) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const byteOrder = readAscii(bytes, start, 2);
    const littleEndian = byteOrder === 'II';
    if (!littleEndian && byteOrder !== 'MM') return null;
    const u16 = (offset) => (offset + 2 <= end ? view.getUint16(offset, littleEndian) : 0);
    const u32 = (offset) => (offset + 4 <= end ? view.getUint32(offset, littleEndian) : 0);
    if (u16(start + 2) !== 42) return null;
    const typeSizes = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
    const readIfd = (relativeOffset) => {
      const offset = start + relativeOffset;
      if (!relativeOffset || offset + 2 > end) return new Map();
      const count = u16(offset);
      if (count > 160 || offset + 2 + count * 12 > end) return new Map();
      const tags = new Map();
      for (let index = 0; index < count; index += 1) {
        const entry = offset + 2 + index * 12;
        const tag = u16(entry);
        const type = u16(entry + 2);
        const countValue = u32(entry + 4);
        const byteLength = (typeSizes[type] || 0) * countValue;
        if (!byteLength || byteLength > end - start) continue;
        const valueOffset = byteLength <= 4 ? entry + 8 : start + u32(entry + 8);
        if (valueOffset < start || valueOffset + byteLength > end) continue;
        tags.set(tag, { type, count: countValue, valueOffset, rawOffset: u32(entry + 8), byteLength });
      }
      return tags;
    };
    const textValue = (entry) => entry && readAscii(bytes, entry.valueOffset, entry.byteLength).trim();
    const pointerValue = (entry) => entry && (entry.type === 3 ? u16(entry.valueOffset) : u32(entry.valueOffset));
    const rationalValue = (entry) => {
      if (!entry || entry.type !== 5 || entry.count < 3) return null;
      const parts = [0, 1, 2].map((index) => {
        const offset = entry.valueOffset + index * 8;
        const denominator = u32(offset + 4);
        return denominator ? u32(offset) / denominator : 0;
      });
      return parts.every(Number.isFinite) ? parts[0] + parts[1] / 60 + parts[2] / 3600 : null;
    };
    const firstIfd = readIfd(u32(start + 4));
    const exifIfd = readIfd(pointerValue(firstIfd.get(0x8769)));
    const gpsIfd = readIfd(pointerValue(firstIfd.get(0x8825)));
    const capture = parseExifDate(textValue(exifIfd.get(0x9003)) || textValue(exifIfd.get(0x9004)) || textValue(firstIfd.get(0x0132)));
    let latitude = rationalValue(gpsIfd.get(2));
    let longitude = rationalValue(gpsIfd.get(4));
    const latitudeRef = (textValue(gpsIfd.get(1)) || '').toUpperCase();
    const longitudeRef = (textValue(gpsIfd.get(3)) || '').toUpperCase();
    if (latitudeRef === 'S') latitude = -latitude;
    if (longitudeRef === 'W') longitude = -longitude;
    const hasCoordinates = Number.isFinite(latitude) && Number.isFinite(longitude) && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180 && (latitude || longitude);
    return { ...(capture || {}), ...(hasCoordinates ? { latitude, longitude } : {}) };
  } catch {
    return null;
  }
}
function readBigEndian(bytes, offset, length) {
  if (length < 0 || length > 8 || offset < 0 || offset + length > bytes.length) return 0;
  let value = 0;
  for (let index = 0; index < length; index += 1) value = value * 256 + bytes[offset + index];
  return Number.isSafeInteger(value) ? value : 0;
}
function bmffBoxes(bytes, start, end) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const boxes = [];
  for (let offset = start; offset + 8 <= end;) {
    let size = view.getUint32(offset, false);
    const type = readAscii(bytes, offset + 4, 4);
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > end) break;
      size = readUint64Safe(view, offset + 8, false);
      headerSize = 16;
    } else if (size === 0) size = end - offset;
    if (size < headerSize || offset + size > end) break;
    boxes.push({ type, start: offset, payloadStart: offset + headerSize, end: offset + size });
    offset += size;
  }
  return boxes;
}
function parseHeifExif(bytes) {
  try {
    const meta = bmffBoxes(bytes, 0, bytes.length).find((box) => box.type === 'meta');
    if (!meta || meta.payloadStart + 4 > meta.end) return null;
    const children = bmffBoxes(bytes, meta.payloadStart + 4, meta.end);
    const iinf = children.find((box) => box.type === 'iinf');
    const iloc = children.find((box) => box.type === 'iloc');
    if (!iinf || !iloc) return null;
    const iinfVersion = bytes[iinf.payloadStart];
    const infeStart = iinf.payloadStart + 4 + (iinfVersion === 0 ? 2 : 4);
    const exifIds = new Set(bmffBoxes(bytes, infeStart, iinf.end).map((box) => {
      const version = bytes[box.payloadStart];
      if (version < 2) return 0;
      const idLength = version === 2 ? 2 : 4;
      const idOffset = box.payloadStart + 4;
      const itemTypeOffset = idOffset + idLength + 2;
      return readAscii(bytes, itemTypeOffset, 4) === 'Exif' ? readBigEndian(bytes, idOffset, idLength) : 0;
    }).filter(Boolean));
    if (!exifIds.size) return null;
    const version = bytes[iloc.payloadStart];
    let cursor = iloc.payloadStart + 4;
    const offsetSize = bytes[cursor] >> 4;
    const lengthSize = bytes[cursor] & 15;
    cursor += 1;
    const baseOffsetSize = bytes[cursor] >> 4;
    const indexSize = version === 1 || version === 2 ? bytes[cursor] & 15 : 0;
    cursor += 1;
    const itemCountLength = version < 2 ? 2 : 4;
    const itemCount = readBigEndian(bytes, cursor, itemCountLength);
    cursor += itemCountLength;
    const idat = children.find((box) => box.type === 'idat');
    for (let item = 0; item < itemCount && cursor < iloc.end; item += 1) {
      const idLength = version < 2 ? 2 : 4;
      const itemId = readBigEndian(bytes, cursor, idLength);
      cursor += idLength;
      let constructionMethod = 0;
      if (version === 1 || version === 2) {
        constructionMethod = readBigEndian(bytes, cursor, 2) & 15;
        cursor += 2;
      }
      cursor += 2; // data reference index
      const baseOffset = readBigEndian(bytes, cursor, baseOffsetSize);
      cursor += baseOffsetSize;
      const extentCount = readBigEndian(bytes, cursor, 2);
      cursor += 2;
      for (let extent = 0; extent < extentCount && cursor < iloc.end; extent += 1) {
        if ((version === 1 || version === 2) && indexSize) cursor += indexSize;
        const extentOffset = readBigEndian(bytes, cursor, offsetSize);
        cursor += offsetSize;
        const extentLength = readBigEndian(bytes, cursor, lengthSize);
        cursor += lengthSize;
        if (!exifIds.has(itemId) || !extentLength) continue;
        const dataStart = (constructionMethod === 1 && idat ? idat.payloadStart : 0) + baseOffset + extentOffset;
        const dataEnd = dataStart + extentLength;
        if (dataStart < 0 || dataEnd > bytes.length) continue;
        const tiffOffset = readBigEndian(bytes, dataStart, 4);
        const parsed = parseTiffExif(bytes, dataStart + 4 + tiffOffset, dataEnd)
          || (hasBytes(bytes, dataStart, [69, 120, 105, 102, 0, 0]) ? parseTiffExif(bytes, dataStart + 6, dataEnd) : null);
        if (parsed) return parsed;
      }
    }
  } catch {
    // Some HEIC variants do not expose an Exif item. The normal fallback is used below.
  }
  return null;
}
function parsePhotoExif(bytes) {
  try {
    if (bytes.length > 12 && readAscii(bytes, 0, 2) === '\xFF\xD8') {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      for (let offset = 2; offset + 4 < bytes.length;) {
        if (bytes[offset] !== 0xff) { offset += 1; continue; }
        const marker = bytes[offset + 1];
        if (marker === 0xda || marker === 0xd9) break;
        const length = view.getUint16(offset + 2, false);
        const end = offset + 2 + length;
        if (length < 2 || end > bytes.length) break;
        if (marker === 0xe1 && hasBytes(bytes, offset + 4, [69, 120, 105, 102, 0, 0])) return parseTiffExif(bytes, offset + 10, end);
        offset = end;
      }
    }
    if (bytes.length > 12 && readAscii(bytes, 1, 3) === 'PNG') {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      for (let offset = 8; offset + 12 <= bytes.length;) {
        const length = view.getUint32(offset, false);
        const dataStart = offset + 8;
        const end = dataStart + length;
        if (end + 4 > bytes.length) break;
        if (readAscii(bytes, offset + 4, 4) === 'eXIf') return parseTiffExif(bytes, dataStart, end);
        offset = end + 4;
      }
    }
    if (readAscii(bytes, 0, 4) === 'RIFF' && readAscii(bytes, 8, 4) === 'WEBP') {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      for (let offset = 12; offset + 8 <= bytes.length;) {
        const length = view.getUint32(offset + 4, true);
        const dataStart = offset + 8;
        if (dataStart + length > bytes.length) break;
        if (readAscii(bytes, offset, 4) === 'EXIF') return parseTiffExif(bytes, dataStart, dataStart + length);
        offset = dataStart + length + (length % 2);
      }
    }
    if (readAscii(bytes, 4, 4) === 'ftyp' && ['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(readAscii(bytes, 8, 4))) return parseHeifExif(bytes);
  } catch {
    // Metadata is optional, so a malformed image never prevents it from being stored.
  }
  return null;
}
async function photoMetadataFromFile(file) {
  const fallback = dateFromMillis(file.lastModified || Date.now());
  try {
    const exif = parsePhotoExif(new Uint8Array(await file.arrayBuffer())) || {};
    return {
      date: exif.date || fallback.date,
      capturedAt: exif.capturedAt || fallback.capturedAt,
      latitude: exif.latitude,
      longitude: exif.longitude,
      source: exif.date ? 'exif' : 'file',
    };
  } catch {
    return { ...fallback, source: 'file' };
  }
}
function formatCapturedAt(value, fallbackDate = '') {
  const matched = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!matched) return fallbackDate ? formatMediaDate(fallbackDate) : '';
  return `${Number(matched[2])}월 ${Number(matched[3])}일 ${matched[4]}:${matched[5]}`;
}
function setToday() { byId('expenseDate').value = todayInKorea(); }

async function api(path, { method = 'GET', body, authenticated = true } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const token = localStorage.getItem(sessionStorageKey);
  if (authenticated && token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${apiUrl}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message || '서버 요청에 실패했어요.');
  return payload;
}

async function loadRecords() {
  try {
    if (cloudMode) {
      const payload = await api('/records');
      recordsCache = payload.records || [];
    } else {
      recordsCache = getLocalRecords();
    }
    render();
  } catch (error) {
    if (cloudMode && /세션|인증|로그인/.test(error.message)) signOut(false);
    showToast(error.message || '기록을 불러오지 못했어요.');
  }
}

function updateCreateButton() {
  byId('openExpense').innerHTML = activeFilter === 'income'
    ? '<span>↓</span> 입금 기록 입력'
    : '<span>＋</span> 영수증으로 지출 등록';
  byId('openExpense').hidden = activeView !== 'ledger';
}

function setActiveView(view) {
  activeView = view;
  const isMedia = view === 'media';
  byId('ledgerView').hidden = isMedia;
  byId('mediaView').hidden = !isMedia;
  byId('openMedia').hidden = !isMedia;
  document.querySelectorAll('.main-tab').forEach((button) => button.classList.toggle('is-active', button.dataset.view === view));
  updateCreateButton();
  if (isMedia) {
    renderMedia();
    if (!mediaItems.length && !mediaLoading) loadMedia({ reset: true });
  }
}

function paymentState(record) {
  if (record.paymentStatus === 'paid') return 'paid';
  if (record.paymentStatus === 'pending') return 'pending';
  return 'unconfirmed';
}
function paymentStatusText(record) {
  const state = paymentState(record);
  if (state === 'paid') {
    const completedDate = record.paymentDate || String(record.paymentCompletedAt || '').slice(0, 10);
    return completedDate ? `입금 완료 · ${formatDate(completedDate)}` : '입금 완료';
  }
  return state === 'pending' ? '입금 대기' : '입금 확인 필요';
}
function paymentActionMarkup(record) {
  if (activeMember !== treasurerMember || record.type !== 'expense') return '';
  const state = paymentState(record);
  const nextStatus = state === 'paid' ? 'pending' : 'paid';
  const label = state === 'paid' ? '입금 완료 취소' : '입금 완료';
  const dateField = state === 'paid' ? '' : `<label class="payment-date payment-date--detail">입금일<input id="detailPaymentDate" type="date" value="${todayInKorea()}" required /></label>`;
  return `${dateField}<button class="payment-action payment-detail-action${state === 'paid' ? ' is-reset' : ''}" id="detailPaymentButton" type="button" data-payment-status="${nextStatus}">${label}</button>`;
}
function bindDetailPaymentButton(record) {
  const button = byId('detailPaymentButton');
  if (!button) return;
  button.addEventListener('click', () => savePaymentStatus(record, button.dataset.paymentStatus, button, byId('detailPaymentDate')?.value));
}
function placeExpenseButtonInline(hasPayableExpenses) {
  const button = byId('openExpense');
  if (activeMember === treasurerMember && hasPayableExpenses) {
    byId('paymentPanel').after(button);
    button.classList.add('add-expense--inline');
  } else {
    byId('appShell').append(button);
    button.classList.remove('add-expense--inline');
  }
}
function renderPaymentPanel(records) {
  const panel = byId('paymentPanel');
  if (activeMember !== treasurerMember) {
    panel.hidden = true;
    placeExpenseButtonInline(false);
    return;
  }

  panel.hidden = false;
  const payable = records.filter((record) => record.type === 'expense' && paymentState(record) !== 'paid')
    .sort((a, b) => new Date(a.date) - new Date(b.date));
  placeExpenseButtonInline(payable.length > 0);
  const total = payable.reduce((sum, record) => sum + Number(record.amount || 0), 0);
  byId('paymentCount').textContent = `${payable.length}건`;
  byId('paymentSummary').textContent = payable.length
    ? `송금할 지출 ${payable.length}건 · ${formatMoney(total)}`
    : '현재 송금할 지출이 없어요.';
  byId('paymentList').innerHTML = payable.length ? payable.map((record) => {
    const hasAccount = Boolean(record.refundBank && record.refundAccount);
    const account = hasAccount ? `${record.refundBank} ${record.refundAccount}` : '환불 계좌를 등록해 주세요.';
    return `<article class="payment-card"><div class="payment-card__head"><div><p class="payment-card__person">${escapeHtml(record.person || record.member || '지출자 확인 필요')}</p><span class="payment-card__memo">${escapeHtml(record.memo || '영수증 지출')}</span></div><strong class="payment-card__amount">${formatMoney(record.amount)}</strong></div><p class="payment-card__account${hasAccount ? '' : ' is-missing'}">${escapeHtml(account)}</p><div class="payment-card__footer"><label class="payment-date">입금일<input type="date" value="${todayInKorea()}" data-payment-date required /></label><button class="payment-action" type="button" data-payment-id="${escapeHtml(record.id)}" data-payment-status="paid">입금 완료</button></div></article>`;
  }).join('') : '<p class="payment-empty">모든 환불 송금이 완료되었어요.</p>';
}

function render() {
  const records = [...recordsCache].sort((a, b) => new Date(b.date) - new Date(a.date));
  const income = records.filter((record) => record.type === 'income').reduce((sum, record) => sum + Number(record.amount || 0), 0);
  const expense = records.filter((record) => record.type === 'expense').reduce((sum, record) => sum + Number(record.amount || 0), 0);
  byId('incomeAmount').textContent = formatMoney(income);
  byId('expenseAmount').textContent = formatMoney(expense);
  byId('recordCount').textContent = `${records.length}건`;
  byId('balanceAmount').textContent = formatMoney(openingBalance + income - expense);
  byId('balanceHint').textContent = `기초 잔액 ${formatMoney(openingBalance)}과 기록한 지출 기준이에요.`;
  renderPaymentPanel(records);

  const filtered = records.filter((record) => activeFilter === 'all' || record.type === activeFilter);
  byId('ledger').innerHTML = filtered.map((record) => {
    const label = record.type === 'income' ? (record.memo || '회비 입금') : (record.memo || '영수증 지출');
    const person = record.type === 'income' ? `${record.person || '입금자 확인 필요'} · 입금 증빙 사진 있음` : `${record.person || record.member} · 증빙 사진 있음`;
    const proofUrl = record.proofUrl || record.proof;
    const icon = proofUrl ? `<img src="${proofUrl}" alt="" />` : record.type === 'income' ? '↓' : '⌑';
    const paymentBadge = record.type === 'expense' ? `<span class="payment-badge is-${paymentState(record)}">${paymentStatusText(record)}</span>` : '';
    return `<button class="ledger-row ledger-row--${record.type}" data-id="${record.id}"><span class="ledger-row__icon">${icon}</span><span class="ledger-row__main"><b>${escapeHtml(label)}</b><span>${escapeHtml(person)} · ${formatDate(record.date)}</span>${paymentBadge}</span><span class="ledger-row__amount"><b>${record.type === 'income' ? '+' : '−'}${formatMoney(record.amount)}</b><span>${record.type === 'income' ? '입금' : '영수증'}</span></span></button>`;
  }).join('');
  byId('emptyState').hidden = filtered.length > 0;
  updateCreateButton();
}

function openExpense() {
  if (activeFilter === 'income') { openIncome(); return; }
  byId('expenseBackdrop').hidden = false;
  byId('expensePerson').value = activeMember;
  setToday();
}
function closeExpense() {
  byId('expenseBackdrop').hidden = true;
  applyPendingAppUpdate();
}
function openIncome() { byId('incomeBackdrop').hidden = false; }
function closeIncome() {
  byId('incomeBackdrop').hidden = true;
  applyPendingAppUpdate();
}
function closeDetail() {
  byId('detailBackdrop').hidden = true;
  applyPendingAppUpdate();
}
function openMedia() {
  if (!cloudMode) { showToast('사진·영상 보관함은 AWS 연결 후 사용할 수 있어요.'); return; }
  byId('mediaVideoDate').value = todayInKorea();
  byId('mediaBackdrop').hidden = false;
}
function closeMedia() {
  byId('mediaBackdrop').hidden = true;
  applyPendingAppUpdate();
}
function resetPhotoViewer() {
  setPhotoViewerMode('none');
  byId('mediaDetailBackdrop').classList.remove('media-detail-backdrop--viewer');
  byId('mediaDetailContent').closest('.media-detail').classList.remove('media-detail--photo', 'media-detail--viewer');
  photoObjectUrls.forEach((url) => URL.revokeObjectURL(url));
  photoObjectUrls.clear();
  photoSourceUrls.clear();
  photoViewerRequestId += 1;
}
function setPhotoViewerMode(mode) {
  const isPhotoViewer = mode !== 'none';
  const isLandscape = mode === 'landscape';
  document.documentElement.classList.toggle('photo-detail-viewer', isPhotoViewer);
  document.body.classList.toggle('photo-detail-viewer', isPhotoViewer);
  document.documentElement.classList.toggle('landscape-photo-viewer', isLandscape);
  document.body.classList.toggle('landscape-photo-viewer', isLandscape);
  themeColorMeta?.setAttribute('content', isLandscape ? '#050806' : isPhotoViewer ? '#243229' : defaultThemeColor);
}
function closeMediaDetail() {
  byId('mediaDetailBackdrop').hidden = true;
  resetPhotoViewer();
  activeMediaDetailId = '';
  applyPendingAppUpdate();
}
function closeAllModals() {
  document.querySelectorAll('.modal-backdrop').forEach((backdrop) => { backdrop.hidden = true; });
  resetPhotoViewer();
  activeMediaDetailId = '';
  applyPendingAppUpdate();
}
function clearReceipt() {
  selectedFile = null;
  byId('receiptInput').value = '';
  byId('receiptPreview').hidden = true;
  byId('previewImage').src = '';
}
function clearIncomeImage() {
  selectedIncomeFile = null;
  byId('incomeInput').value = '';
  byId('incomePreview').hidden = true;
  byId('incomePreviewImage').src = '';
}

function compressImage(file, maxSize = 1280, quality = 0.76) {
  return new Promise((resolve, reject) => {
    const source = new Image();
    const reader = new FileReader();
    reader.onload = () => { source.src = reader.result; };
    reader.onerror = reject;
    source.onload = () => {
      const scale = Math.min(1, maxSize / Math.max(source.width, source.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(source.width * scale);
      canvas.height = Math.round(source.height * scale);
      canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    source.onerror = reject;
    reader.readAsDataURL(file);
  });
}
function openDetail(record) {
  if (record.type === 'expense') {
    const proofUrl = record.proofUrl || record.proof;
    const canEdit = record.person === activeMember;
    byId('detailType').textContent = 'EXPENSE';
    byId('detailTitle').textContent = record.memo || '영수증 지출';
    if (!canEdit) {
      const refundAccount = record.refundBank && record.refundAccount ? `${record.refundBank} ${record.refundAccount}` : '등록된 계좌 없음';
      const refundRow = activeMember === treasurerMember ? `<div><dt>환불 받을 계좌</dt><dd>${escapeHtml(refundAccount)}</dd></div>` : '';
      byId('detailContent').innerHTML = `<div class="detail-content">${proofUrl ? `<img class="detail-proof" src="${proofUrl}" alt="등록한 영수증" />` : ''}<p class="detail-amount">−${formatMoney(record.amount)}</p><dl class="detail-list"><div><dt>기록 날짜</dt><dd>${formatDate(record.date)}</dd></div><div><dt>지출 등록자</dt><dd>${escapeHtml(record.person || record.member || '')}</dd></div>${refundRow}${record.memo ? `<div><dt>메모</dt><dd>${escapeHtml(record.memo)}</dd></div>` : ''}</dl><p class="detail-readonly">지출 등록자만 수정하거나 삭제할 수 있어요.</p>${paymentActionMarkup(record)}</div>`;
      bindDetailPaymentButton(record);
      byId('detailBackdrop').hidden = false;
      return;
    }
    byId('detailContent').innerHTML = `<form class="detail-content detail-edit-form" id="detailEditForm">${proofUrl ? `<img class="detail-proof" src="${proofUrl}" alt="등록한 영수증" />` : ''}<p class="detail-edit-hint">영수증을 보고 금액·날짜·메모를 고친 뒤 저장하세요.</p><label class="field">금액<input name="amount" type="number" min="1" max="100000000" inputmode="numeric" value="${Number(record.amount) || ''}" required /></label><label class="field">기록 날짜<input name="date" type="date" value="${escapeHtml(record.date)}" required /></label><label class="field field--last">메모 <span>(선택)</span><input name="memo" maxlength="80" value="${escapeHtml(record.memo || '')}" placeholder="예: 7월 정기모임 식사" /></label><p class="detail-person">지출 등록자 · ${escapeHtml(record.person || record.member || '')}</p><button class="save-expense detail-save" id="detailSaveButton" type="submit">수정 저장하기 <span>→</span></button></form>`;
    const editForm = byId('detailEditForm');
    enableAmountCommas(editForm.elements.amount);
    const refundFields = document.createElement('div');
    refundFields.className = 'refund-fields detail-refund-fields';
    refundFields.innerHTML = `<p class="refund-title">환불 받을 계좌</p><div class="two-fields"><label class="field">은행명<input name="refundBank" maxlength="20" autocomplete="off" value="${escapeHtml(record.refundBank || '')}" placeholder="예: 국민" /></label><label class="field">계좌번호<input name="refundAccount" inputmode="numeric" maxlength="30" autocomplete="off" value="${escapeHtml(record.refundAccount || '')}" placeholder="숫자만 입력" /></label></div>`;
    editForm.insertBefore(refundFields, editForm.querySelector('.detail-person'));
    editForm.addEventListener('submit', (event) => saveExpenseEdit(event, record));
    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'delete-expense';
    deleteButton.textContent = '이 지출 삭제하기';
    deleteButton.addEventListener('click', () => deleteExpense(record, deleteButton));
    editForm.append(deleteButton);
    if (activeMember === treasurerMember) {
      editForm.insertAdjacentHTML('beforeend', paymentActionMarkup(record));
      bindDetailPaymentButton(record);
    }
    byId('detailBackdrop').hidden = false;
    return;
  }
  const proofUrl = record.proofUrl || record.proof;
  byId('detailType').textContent = record.type === 'income' ? 'INCOME' : 'EXPENSE';
  byId('detailTitle').textContent = record.type === 'income' ? '회비 입금' : (record.memo || '영수증 지출');
  byId('detailContent').innerHTML = `<div class="detail-content">${proofUrl ? `<img class="detail-proof" src="${proofUrl}" alt="등록한 ${record.type === 'income' ? '입금 내역' : '영수증'}" />` : ''}<p class="detail-amount">${record.type === 'income' ? '+' : '−'}${formatMoney(record.amount)}</p><dl class="detail-list"><div><dt>기록 날짜</dt><dd>${formatDate(record.date)}</dd></div><div><dt>${record.type === 'income' ? '입금자' : '지출한 사람'}</dt><dd>${escapeHtml(record.type === 'income' ? (record.person || '입금자 확인 필요') : (record.person || record.member))}</dd></div>${record.memo ? `<div><dt>메모</dt><dd>${escapeHtml(record.memo)}</dd></div>` : ''}</dl></div>`;
  byId('detailBackdrop').hidden = false;
}

async function saveExpenseEdit(event, record) {
  event.preventDefault();
  if (record.person !== activeMember) { showToast('지출 등록자만 수정할 수 있어요.'); return; }
  const form = new FormData(event.currentTarget);
  const amount = parseAmountInput(form.get('amount'));
  const date = String(form.get('date') || '');
  const memo = String(form.get('memo') || '').trim();
  const refundBank = String(form.get('refundBank') || '').trim();
  const refundAccount = String(form.get('refundAccount') || '').replace(/\s/g, '');
  if (!amount || !date) { showToast('금액과 날짜를 입력해 주세요.'); return; }
  if (Boolean(refundBank) !== Boolean(refundAccount)) { showToast('은행명과 계좌번호를 함께 입력해 주세요.'); return; }

  const button = byId('detailSaveButton');
  button.disabled = true;
  button.textContent = '수정 저장 중…';
  try {
    if (cloudMode) {
      await api(`/expenses/${encodeURIComponent(record.id)}`, { method: 'PATCH', body: { amount, date, memo, refundBank, refundAccount } });
    } else {
      const records = getLocalRecords().map((item) => (item.id === record.id ? { ...item, amount, date, memo, refundBank, refundAccount, needsReview: false } : item));
      saveLocalRecords(records);
    }
    byId('detailBackdrop').hidden = true;
    await loadRecords();
    showToast('지출 기록을 수정했어요.');
  } catch (error) {
    showToast(error.message || '수정 내용을 저장하지 못했어요.');
  } finally {
    button.disabled = false;
    button.innerHTML = '수정 저장하기 <span>→</span>';
  }
}

async function savePaymentStatus(record, status, button, paymentDate = todayInKorea()) {
  if (activeMember !== treasurerMember) { showToast('통장 담당자만 입금 상태를 처리할 수 있어요.'); return; }
  const isPaid = status === 'paid';
  if (isPaid && !/^\d{4}-\d{2}-\d{2}$/.test(paymentDate || '')) { showToast('입금일을 선택해 주세요.'); return; }
  const account = record.refundBank && record.refundAccount ? `${record.refundBank} ${record.refundAccount}` : '등록된 계좌 없음';
  const confirmation = isPaid
    ? `${record.person || record.member} · ${formatMoney(record.amount)}\n${account}\n입금일 ${formatDate(paymentDate)}로 완료 처리할까요?`
    : `${record.person || record.member} 지출의 입금 완료 표시를 취소할까요?`;
  if (!window.confirm(confirmation)) return;

  button.disabled = true;
  button.textContent = isPaid ? '처리 중…' : '취소 중…';
  try {
    if (cloudMode) {
      await api(`/expenses/${encodeURIComponent(record.id)}/payment`, { method: 'PATCH', body: { status, paymentDate: isPaid ? paymentDate : undefined } });
    } else {
      const paymentCompletedAt = isPaid ? new Date().toISOString() : undefined;
      const records = getLocalRecords().map((item) => (item.id === record.id ? {
        ...item,
        paymentStatus: status,
        paymentCompletedAt,
        paymentCompletedBy: isPaid ? treasurerMember : undefined,
        paymentDate: isPaid ? paymentDate : undefined,
      } : item));
      saveLocalRecords(records);
    }
    byId('detailBackdrop').hidden = true;
    await loadRecords();
    showToast(isPaid ? '입금 완료로 표시했어요.' : '입금 대기로 되돌렸어요.');
  } catch (error) {
    showToast(error.message || '입금 상태를 저장하지 못했어요.');
  } finally {
    button.disabled = false;
  }
}

async function deleteExpense(record, button) {
  if (!window.confirm('이 지출 기록과 영수증 사진을 삭제할까요? 삭제 후에는 되돌릴 수 없어요.')) return;

  button.disabled = true;
  button.textContent = '삭제하는 중…';
  try {
    if (cloudMode) {
      await api(`/expenses/${encodeURIComponent(record.id)}`, { method: 'DELETE' });
    } else {
      saveLocalRecords(getLocalRecords().filter((item) => item.id !== record.id));
    }
    byId('detailBackdrop').hidden = true;
    await loadRecords();
    showToast('지출 기록을 삭제했어요.');
  } catch (error) {
    showToast(error.message || '지출 기록을 삭제하지 못했어요.');
  } finally {
    button.disabled = false;
    button.textContent = '이 지출 삭제하기';
  }
}

function formatMediaDate(value) {
  return new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' }).format(new Date(`${value}T00:00:00`));
}
function formatMediaMonth(value) {
  const [year, month] = String(value).split('-');
  return `${String(year || '').slice(-2)}.${month}`;
}
function mediaCardMarkup(item) {
  const isVideo = item.mediaType === 'video';
  const location = item.locationName ? `<span class="media-card__location">⌖ ${escapeHtml(item.locationName)}</span>` : '';
  return `<button class="media-card media-card--${escapeHtml(item.mediaType)}" type="button" data-media-id="${escapeHtml(item.id)}"><span class="media-card__image"><img loading="lazy" src="${escapeHtml(item.thumbnailUrl)}" alt="${isVideo ? '유튜브 영상' : '사진'}" />${isVideo ? '<span class="media-card__youtube">YouTube</span><span class="media-card__play">▶</span>' : ''}</span>${location}</button>`;
}
function renderMedia() {
  const visibleItems = mediaItems.filter((item) => activeMediaFilter === 'all' || item.mediaType === activeMediaFilter);
  const groups = [];
  visibleItems.forEach((item) => {
    const last = groups[groups.length - 1];
    if (!last || last.date !== item.date) groups.push({ date: item.date, items: [item] });
    else last.items.push(item);
  });
  const months = groups.reduce((result, group) => {
    const month = group.date.slice(0, 7);
    if (!result.some((entry) => entry.month === month)) result.push({ month, target: group.date });
    return result;
  }, []);
  byId('mediaCount').textContent = `${visibleItems.length}개`;
  byId('mediaFeed').innerHTML = groups.map((group) => `<section class="media-day" id="media-date-${group.date}" data-media-date="${group.date}"><div class="media-day__bookmark"><span>${formatMediaDate(group.date)}</span><i></i></div><div class="media-grid">${group.items.map(mediaCardMarkup).join('')}</div></section>`).join('');
  byId('mediaDateRail').innerHTML = months.map((entry, index) => `<button type="button" class="media-date-jump${index === 0 ? ' is-active' : ''}" data-media-target="${entry.target}" data-media-month="${entry.month}">${formatMediaMonth(entry.month)}</button>`).join('');
  byId('mediaEmpty').hidden = visibleItems.length > 0 || mediaLoading;
  byId('mediaLoading').hidden = !mediaLoading;
  byId('mediaSentinel').hidden = !mediaHasMore;
  updateActiveMediaDate();
}
function updateActiveMediaDate() {
  if (activeView !== 'media') return;
  const sections = Array.from(document.querySelectorAll('.media-day'));
  if (!sections.length) return;
  const current = sections.reduce((selected, section) => (section.getBoundingClientRect().top <= 160 ? section : selected), sections[0]);
  const currentMonth = current.dataset.mediaDate.slice(0, 7);
  document.querySelectorAll('.media-date-jump').forEach((button) => button.classList.toggle('is-active', button.dataset.mediaMonth === currentMonth));
}
async function loadMedia({ reset = false } = {}) {
  if (!cloudMode) return;
  if (mediaLoading || (!reset && !mediaHasMore)) return;
  if (reset) {
    mediaItems = [];
    mediaNextCursor = '';
    mediaHasMore = true;
  }
  mediaLoading = true;
  renderMedia();
  try {
    const cursor = mediaNextCursor ? `&cursor=${encodeURIComponent(mediaNextCursor)}` : '';
    const result = await api(`/media?limit=18${cursor}`);
    const incoming = result.items || [];
    const known = new Set(mediaItems.map((item) => item.id));
    mediaItems = [...mediaItems, ...incoming.filter((item) => !known.has(item.id))]
      .sort((first, second) => `${second.date}${second.createdAt || ''}`.localeCompare(`${first.date}${first.createdAt || ''}`));
    mediaNextCursor = result.nextCursor || '';
    mediaHasMore = Boolean(mediaNextCursor);
  } catch (error) {
    showToast(error.message || '사진·영상을 불러오지 못했어요.');
  } finally {
    mediaLoading = false;
    renderMedia();
  }
}
function clearMediaPhotoSelection() {
  mediaSelectionVersion += 1;
  mediaPreviewUrls.forEach((url) => URL.revokeObjectURL(url));
  mediaPreviewUrls = [];
  selectedMediaFiles = [];
  mediaPhotoMetadata = [];
  mediaPhotoMetadataLoading = false;
  byId('mediaPhotoInput').value = '';
  byId('mediaPhotoPreview').hidden = true;
  byId('mediaPhotoPreview').innerHTML = '';
  byId('mediaPhotoInfo').hidden = true;
  byId('mediaPhotoInfo').innerHTML = '';
}
function renderMediaPhotoInfo() {
  const info = byId('mediaPhotoInfo');
  if (!selectedMediaFiles.length) { info.hidden = true; return; }
  if (mediaPhotoMetadataLoading) {
    info.hidden = false;
    info.innerHTML = '<b>촬영 정보 읽는 중…</b><span>사진에 포함된 날짜와 위치를 확인하고 있어요.</span>';
    return;
  }
  info.hidden = false;
  const shownMetadata = mediaPhotoMetadata.slice(0, 16);
  const details = shownMetadata.map((metadata, index) => {
    const dateLabel = formatCapturedAt(metadata.capturedAt, metadata.date);
    const placeLabel = Number.isFinite(metadata.latitude) && Number.isFinite(metadata.longitude)
      ? '위치 정보 확인됨 · 보관할 때 지역명으로 표시'
      : '위치 정보 없음';
    const fallback = metadata.source === 'file' ? '사진 날짜 정보가 없어 파일 날짜를 사용합니다' : '';
    return `<p><b>${escapeHtml(selectedMediaFiles[index]?.name || `사진 ${index + 1}`)}</b><span>${escapeHtml(dateLabel)} · ${placeLabel}${fallback ? ` · ${fallback}` : ''}</span></p>`;
  }).join('');
  const more = selectedMediaFiles.length > shownMetadata.length ? `<p><span>나머지 ${selectedMediaFiles.length - shownMetadata.length}장도 함께 저장됩니다.</span></p>` : '';
  info.innerHTML = details + more;
}
async function setSelectedMediaFiles(files) {
  const allFiles = Array.from(files || []).filter(isLikelyImage);
  clearMediaPhotoSelection();
  const selectionVersion = mediaSelectionVersion;
  selectedMediaFiles = allFiles;
  if (!selectedMediaFiles.length) return;
  const previewFiles = selectedMediaFiles.slice(0, 12);
  mediaPreviewUrls = previewFiles.map((file) => URL.createObjectURL(file));
  const previews = mediaPreviewUrls.map((url, index) => `<img src="${url}" alt="선택한 사진 ${index + 1}" />`).join('');
  const more = selectedMediaFiles.length > previewFiles.length ? `<span class="media-photo-preview__more">+${selectedMediaFiles.length - previewFiles.length}</span>` : '';
  byId('mediaPhotoPreview').innerHTML = previews + more;
  byId('mediaPhotoPreview').hidden = false;
  mediaPhotoMetadataLoading = true;
  renderMediaPhotoInfo();
  const metadata = [];
  for (const file of selectedMediaFiles) {
    metadata.push(await photoMetadataFromFile(file));
    if (selectionVersion !== mediaSelectionVersion) return;
  }
  if (selectionVersion !== mediaSelectionVersion) return;
  mediaPhotoMetadata = metadata;
  mediaPhotoMetadataLoading = false;
  renderMediaPhotoInfo();
}
function setMediaForm(type) {
  const isPhoto = type === 'photo';
  byId('mediaPhotoForm').hidden = !isPhoto;
  byId('mediaVideoForm').hidden = isPhoto;
  document.querySelectorAll('.media-form-tab').forEach((button) => button.classList.toggle('is-active', button.dataset.mediaForm === type));
}
async function saveMediaPhotos(event) {
  event.preventDefault();
  if (!selectedMediaFiles.length) { showToast('보관할 사진을 선택해 주세요.'); return; }
  if (mediaPhotoMetadataLoading) { showToast('사진의 촬영 정보를 읽는 중이에요. 잠시만 기다려 주세요.'); return; }
  const formElement = event.currentTarget;
  const photoCount = selectedMediaFiles.length;
  const button = byId('saveMediaPhoto');
  button.disabled = true;
  try {
    for (let index = 0; index < photoCount; index += 1) {
      const metadata = mediaPhotoMetadata[index] || dateFromMillis(selectedMediaFiles[index].lastModified || Date.now());
      button.textContent = `사진 ${index + 1}/${photoCount} 저장 중…`;
      const image = await compressImage(selectedMediaFiles[index], 1280, 0.76);
      const thumbnail = await compressImage(selectedMediaFiles[index], 480, 0.7);
      await api('/media/photos', {
        method: 'POST',
        body: {
          imageBase64: image.split(',')[1],
          thumbnailBase64: thumbnail.split(',')[1],
          date: metadata.date,
          capturedAt: metadata.capturedAt,
          latitude: metadata.latitude,
          longitude: metadata.longitude,
          caption: '',
        },
      });
    }
    formElement.reset();
    clearMediaPhotoSelection();
    closeMedia();
    await loadMedia({ reset: true });
    showToast(`${photoCount}장의 사진을 보관했어요.`);
  } catch (error) {
    showToast(error.message || '사진을 저장하지 못했어요. 다시 시도해 주세요.');
  } finally {
    button.disabled = false;
    button.innerHTML = '사진 보관하기 <span>→</span>';
  }
}
async function saveMediaVideo(event) {
  event.preventDefault();
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  const url = String(form.get('url') || '').trim();
  const date = String(form.get('date') || '');
  if (!url || !date) { showToast('유튜브 링크와 날짜를 확인해 주세요.'); return; }
  const button = byId('saveMediaVideo');
  button.disabled = true;
  button.textContent = '영상 링크 저장 중…';
  try {
    await api('/media/videos', { method: 'POST', body: { url, date, caption: '' } });
    formElement.reset();
    closeMedia();
    await loadMedia({ reset: true });
    showToast('유튜브 영상을 보관했어요.');
  } catch (error) {
    showToast(error.message || '유튜브 링크를 저장하지 못했어요.');
  } finally {
    button.disabled = false;
    button.innerHTML = '영상 링크 보관하기 <span>→</span>';
  }
}
function mediaGalleryItems() {
  return mediaItems;
}
function mediaPhotoPeekMarkup(item, direction) {
  const position = direction < 0 ? 'previous' : 'next';
  if (!item) return `<div class="media-photo-peek media-photo-peek--${position} is-empty" aria-hidden="true"></div>`;
  const isVideo = item.mediaType === 'video';
  const label = direction < 0 ? `이전 ${isVideo ? '영상' : '사진'} 보기` : `다음 ${isVideo ? '영상' : '사진'} 보기`;
  return `<button class="media-photo-peek media-photo-peek--${position}${isVideo ? ' media-photo-peek--video' : ''}" type="button" data-media-direction="${direction}" aria-label="${label}"><img src="${escapeHtml(item.thumbnailUrl)}" alt="" />${isVideo ? '<span class="media-photo-peek__video">▶</span>' : ''}</button>`;
}
function mediaCarouselCenterMarkup(item, sourceUrl) {
  if (item.mediaType === 'video') {
    return `<div class="media-photo-main media-video-main" id="mediaVideoMain" tabindex="0" aria-label="영상 영역을 누르면 삭제 메뉴 표시"><div class="media-video-preview"><img src="${escapeHtml(sourceUrl)}" alt="유튜브 영상 썸네일" /><a class="media-video-open" href="${escapeHtml(item.youtubeUrl)}" target="_blank" rel="noopener noreferrer" aria-label="유튜브에서 영상 재생"><span>▶</span><b>YouTube에서 보기</b></a></div></div>`;
  }
  return `<div class="media-photo-main" id="mediaPhotoMain" role="button" tabindex="0" aria-label="사진을 누르면 삭제 메뉴 표시" aria-expanded="false"><img class="media-detail-image" src="${escapeHtml(sourceUrl)}" alt="사진" /></div>`;
}
function mediaTransitionEnterClass(transition) {
  if (!transition) return '';
  return ` photo-transition-enter photo-transition-enter--${transition.axis} photo-transition-enter--${transition.direction > 0 ? 'next' : 'previous'}`;
}
function mediaPhotoCarouselMarkup(item, sourceUrl, transition) {
  const items = mediaGalleryItems();
  const currentIndex = items.findIndex((entry) => entry.id === item.id);
  const previous = currentIndex > 0 ? items[currentIndex - 1] : (items.length > 1 ? items.at(-1) : null);
  const next = currentIndex >= 0 && currentIndex < items.length - 1 ? items[currentIndex + 1] : (items.length > 1 ? items[0] : null);
  const deleteControl = item.person === activeMember
    ? `<button class="media-photo-delete" id="mediaPhotoDeleteButton" type="button" hidden aria-label="${item.mediaType === 'photo' ? '이 사진 삭제' : '이 영상 링크 삭제'}" title="${item.mediaType === 'photo' ? '이 사진 삭제' : '이 영상 링크 삭제'}">🗑</button>`
    : '';
  return `<div class="media-photo-carousel${mediaTransitionEnterClass(transition)}" id="mediaPhotoCarousel">${mediaPhotoPeekMarkup(previous, -1)}${mediaCarouselCenterMarkup(item, sourceUrl)}${mediaPhotoPeekMarkup(next, 1)}${deleteControl}</div>`;
}
function renderMediaDetail(item, photoUrl = '', transition) {
  const isVideo = item.mediaType === 'video';
  const dialog = byId('mediaDetailContent').closest('.media-detail');
  dialog.classList.toggle('media-detail--photo', !isVideo);
  const location = !isVideo && item.locationName ? `<p class="media-detail-location">⌖ ${escapeHtml(item.locationName)}</p>` : '';
  const sourceUrl = isVideo ? item.thumbnailUrl : photoUrl;
  byId('mediaDetailContent').innerHTML = `<div class="media-detail-content${isVideo ? '' : ' media-detail-content--photo'}">${mediaPhotoCarouselMarkup(item, sourceUrl, transition)}<div class="media-detail-copy"><p class="media-detail-date">${formatMediaDate(item.date)}</p>${location}</div></div>`;
  bindMediaPhotoCarousel(item);
}
async function moveMediaPhoto(direction, { skipExit = false } = {}) {
  let items = mediaGalleryItems();
  let currentIndex = items.findIndex((item) => item.id === activeMediaDetailId);
  let target = items[currentIndex + direction];
  if (!target && direction > 0 && mediaHasMore) {
    await loadMedia();
    items = mediaGalleryItems();
    currentIndex = items.findIndex((item) => item.id === activeMediaDetailId);
    target = items[currentIndex + direction];
  }
  if (!target && items.length > 1) target = direction > 0 ? items[0] : items.at(-1);
  if (!target) {
    showToast('보관된 사진·영상이 한 개예요.');
    return;
  }
  if (!skipExit && !await animatePhotoTransition(direction, 'vertical')) return;
  try {
    await openMediaDetail(target, { direction, axis: 'vertical' });
  } finally {
    photoTransitionBusy = false;
  }
}
function bindMediaPhotoCarousel(item) {
  const carousel = byId('mediaPhotoCarousel');
  const isVideo = item.mediaType === 'video';
  const main = byId(isVideo ? 'mediaVideoMain' : 'mediaPhotoMain');
  const deleteButton = byId('mediaPhotoDeleteButton');
  if (!carousel || !main) return;
  carousel.querySelectorAll('[data-media-direction]').forEach((button) => button.addEventListener('click', () => moveMediaPhoto(Number(button.dataset.mediaDirection))));
  if (deleteButton) deleteButton.addEventListener('click', () => deleteMediaItem(item, deleteButton));
  const toggleDeleteControl = () => {
    if (!deleteButton) return;
    deleteButton.hidden = !deleteButton.hidden;
    main.setAttribute('aria-expanded', String(!deleteButton.hidden));
  };
  let ignoreNextClick = false;
  main.addEventListener('click', (event) => {
    if (ignoreNextClick) { ignoreNextClick = false; return; }
    if (isVideo && event.target.closest('.media-video-open')) return;
    toggleDeleteControl();
  });
  if (!isVideo) {
    main.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      toggleDeleteControl();
    });
  } else main.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    toggleDeleteControl();
  });
  bindPhotoDrag(main, 'vertical', (direction) => moveMediaPhoto(direction, { skipExit: true }), ({ dragged }) => {
    if (!dragged) return;
    ignoreNextClick = true;
    if (deleteButton) deleteButton.hidden = true;
  }, carousel);
}
function photoViewerItems() {
  return mediaItems.filter((item) => item.mediaType === 'photo');
}
function photoCacheKey(id) {
  return new Request(`${location.origin}/__simji_viewed_photo__/${encodeURIComponent(id)}`);
}
async function cachedPhotoViewerUrl(id) {
  if (photoObjectUrls.has(id)) return photoObjectUrls.get(id);
  if (!('caches' in window)) return '';
  try {
    const cache = await caches.open('simji-viewed-photos-v1');
    const response = await cache.match(photoCacheKey(id));
    if (!response) return '';
    const blob = await response.blob();
    if (!blob.size) return '';
    const objectUrl = URL.createObjectURL(blob);
    photoObjectUrls.set(id, objectUrl);
    photoSourceUrls.set(id, objectUrl);
    return objectUrl;
  } catch {
    return '';
  }
}
async function resolvePhotoSource(item) {
  if (photoSourceUrls.has(item.id)) return photoSourceUrls.get(item.id);
  const cachedUrl = await cachedPhotoViewerUrl(item.id);
  if (cachedUrl) return cachedUrl;
  const result = await api(`/media/${encodeURIComponent(item.id)}`);
  const sourceUrl = result.item.photoUrl;
  photoSourceUrls.set(item.id, sourceUrl);
  cacheViewedPhoto(item.id, sourceUrl);
  return sourceUrl;
}
async function cacheViewedPhoto(id, photoUrl) {
  if (!('caches' in window) || !photoUrl) return;
  try {
    const cache = await caches.open('simji-viewed-photos-v1');
    if (await cache.match(photoCacheKey(id))) return;
    // Avoid reusing an image-only browser cache entry, which cannot always be read by Cache Storage.
    const response = await fetch(photoUrl, { cache: 'no-store' });
    if (response.ok) await cache.put(photoCacheKey(id), response.clone());
  } catch {
    // Caching is best effort. The signed source URL remains available for this view.
  }
}
function photoNeighbor(item, direction) {
  const photos = photoViewerItems();
  if (photos.length < 2) return item;
  const currentIndex = photos.findIndex((entry) => entry.id === item.id);
  if (currentIndex < 0) return item;
  return photos[(currentIndex + direction + photos.length) % photos.length];
}
function realPhotoSlideMarkup(item, position) {
  const source = photoSourceUrls.get(item.id) || item.thumbnailUrl;
  return `<button class="real-photo-slide real-photo-slide--${position}" type="button" data-photo-id="${escapeHtml(item.id)}" data-photo-position="${position}"${position === 'current' ? '' : ' tabindex="-1" aria-hidden="true"'}><img src="${escapeHtml(source)}" alt="${position === 'current' ? '사진' : ''}" /></button>`;
}
function updateRealPhotoMetadata(state) {
  const item = state.slots[1];
  activeMediaDetailId = item.id;
  const metadata = byId('realPhotoMeta');
  if (metadata) {
    const location = item.locationName ? `<p class="media-detail-location">⌖ ${escapeHtml(item.locationName)}</p>` : '';
    metadata.innerHTML = `<p class="media-detail-date">${formatMediaDate(item.date)}</p>${location}`;
  }
  const deleteButton = byId('realPhotoDelete');
  if (deleteButton) {
    deleteButton.hidden = true;
    deleteButton.disabled = item.person !== activeMember;
    deleteButton.setAttribute('aria-label', '이 사진 삭제');
  }
}
function fillRealPhotoSlide(slide, item, position) {
  const source = photoSourceUrls.get(item.id) || item.thumbnailUrl;
  slide.className = `real-photo-slide real-photo-slide--${position}`;
  slide.dataset.photoId = item.id;
  slide.dataset.photoPosition = position;
  slide.tabIndex = position === 'current' ? 0 : -1;
  slide.setAttribute('aria-hidden', String(position !== 'current'));
  const image = slide.querySelector('img');
  image.src = source;
  image.alt = position === 'current' ? '사진' : '';
}
function setupRealPhotoCarousel(item, photoUrl, axis) {
  const reel = byId('realPhotoReel');
  const track = byId('realPhotoTrack');
  if (!reel || !track) return;
  if (mediaHasMore) void loadMedia();
  photoSourceUrls.set(item.id, photoUrl);
  const state = {
    axis,
    reel,
    track,
    slots: [photoNeighbor(item, -1), item, photoNeighbor(item, 1)],
    settling: false,
    dragging: false,
    ignoreClick: false,
    startX: 0,
    startY: 0,
    delta: 0,
    size: 0,
    cardSize: 0,
    initialOffset: 0,
  };
  const getDimension = () => {
    const style = window.getComputedStyle(reel);
    const padding = axis === 'horizontal'
      ? parseFloat(style.paddingLeft) + parseFloat(style.paddingRight)
      : parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    return Math.max(1, (axis === 'horizontal' ? reel.clientWidth : reel.clientHeight) - padding);
  };
  const setTransform = (offset, animate = false) => {
    track.style.transition = animate ? 'transform 320ms cubic-bezier(.22,.8,.25,1)' : 'none';
    track.style.transform = axis === 'horizontal' ? `translate3d(${offset}px,0,0)` : `translate3d(0,${offset}px,0)`;
  };
  const layout = () => {
    const style = window.getComputedStyle(reel);
    state.size = getDimension();
    const peek = axis === 'horizontal'
      ? Math.min(136, Math.max(52, state.size * 0.15))
      : Math.min(70, Math.max(48, state.size * 0.1));
    state.cardSize = Math.max(1, state.size - (peek * 2));
    state.initialOffset = -(state.cardSize - peek);
    const crossPadding = axis === 'horizontal'
      ? parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
      : parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    const crossSize = Math.max(1, (axis === 'horizontal' ? reel.clientHeight : reel.clientWidth) - crossPadding);
    Array.from(track.children).forEach((slide) => {
      if (axis === 'horizontal') {
        slide.style.width = `${state.cardSize}px`;
        slide.style.height = `${crossSize}px`;
      } else {
        slide.style.width = `${crossSize}px`;
        slide.style.height = `${state.cardSize}px`;
      }
    });
    if (axis === 'horizontal') {
      track.style.width = `${state.cardSize * 3}px`;
      track.style.height = `${crossSize}px`;
    } else {
      track.style.width = `${crossSize}px`;
      track.style.height = `${state.cardSize * 3}px`;
    }
    setTransform(state.initialOffset);
  };
  const prime = (target) => {
    resolvePhotoSource(target).then((source) => {
      Array.from(track.children).forEach((slide) => {
        if (slide.dataset.photoId !== target.id) return;
        const image = slide.querySelector('img');
        if (image) image.src = source;
      });
    }).catch(() => {});
  };
  const refreshSlots = () => {
    Array.from(track.children).forEach((slide, index) => fillRealPhotoSlide(slide, state.slots[index], index === 0 ? 'previous' : index === 1 ? 'current' : 'next'));
    updateRealPhotoMetadata(state);
    prime(state.slots[0]);
    prime(state.slots[2]);
  };
  const finishShift = (direction) => {
    if (direction > 0) {
      state.slots = [state.slots[1], state.slots[2], photoNeighbor(state.slots[2], 1)];
      track.append(track.firstElementChild);
    } else {
      state.slots = [photoNeighbor(state.slots[0], -1), state.slots[0], state.slots[1]];
      track.prepend(track.lastElementChild);
    }
    refreshSlots();
    state.settling = false;
    setTransform(state.initialOffset);
    window.requestAnimationFrame(() => { track.style.transition = ''; });
  };
  const navigate = (direction) => {
    if (state.settling || state.slots[0].id === state.slots[1].id) return;
    state.settling = true;
    const targetOffset = state.initialOffset - (direction * state.cardSize);
    setTransform(targetOffset, true);
    let complete = false;
    const finish = () => {
      if (complete) return;
      complete = true;
      track.removeEventListener('transitionend', onTransitionEnd);
      finishShift(direction);
    };
    const onTransitionEnd = (event) => {
      if (event.target === track && event.propertyName === 'transform') finish();
    };
    track.addEventListener('transitionend', onTransitionEnd);
    window.setTimeout(finish, 380);
  };
  const snapBack = () => setTransform(state.initialOffset, true);
  track.innerHTML = `${realPhotoSlideMarkup(state.slots[0], 'previous')}${realPhotoSlideMarkup(state.slots[1], 'current')}${realPhotoSlideMarkup(state.slots[2], 'next')}`;
  layout();
  updateRealPhotoMetadata(state);
  prime(state.slots[0]);
  prime(state.slots[2]);
  const deleteButton = byId('realPhotoDelete');
  if (deleteButton) deleteButton.addEventListener('click', () => deleteMediaItem(state.slots[1], deleteButton));
  reel.addEventListener('click', (event) => {
    if (state.ignoreClick) return;
    const slide = event.target.closest('.real-photo-slide');
    if (!slide) return;
    const position = slide.dataset.photoPosition;
    if (position === 'previous') navigate(-1);
    else if (position === 'next') navigate(1);
    else if (deleteButton && state.slots[1].person === activeMember) deleteButton.hidden = !deleteButton.hidden;
  });
  reel.addEventListener('touchstart', (event) => {
    if (state.settling) return;
    const touch = event.changedTouches[0];
    state.startX = touch.clientX;
    state.startY = touch.clientY;
    state.delta = 0;
    state.dragging = false;
  }, { passive: true });
  reel.addEventListener('touchmove', (event) => {
    if (state.settling) return;
    const touch = event.changedTouches[0];
    const primary = axis === 'horizontal' ? touch.clientX - state.startX : touch.clientY - state.startY;
    const cross = axis === 'horizontal' ? touch.clientY - state.startY : touch.clientX - state.startX;
    if (!state.dragging && Math.abs(primary) < Math.abs(cross) * 1.15) return;
    if (Math.abs(primary) < 5) return;
    state.dragging = true;
    state.delta = Math.max(-state.cardSize * 0.68, Math.min(state.cardSize * 0.68, primary * 0.82));
    reel.classList.add('is-real-photo-dragging');
    setTransform(state.initialOffset + state.delta);
    event.preventDefault();
  }, { passive: false });
  const finishDrag = () => {
    if (!state.dragging) return;
    state.dragging = false;
    reel.classList.remove('is-real-photo-dragging');
    state.ignoreClick = true;
    window.setTimeout(() => { state.ignoreClick = false; }, 220);
    const threshold = Math.min(96, state.cardSize * 0.17);
    if (Math.abs(state.delta) < threshold) snapBack();
    else navigate(state.delta < 0 ? 1 : -1);
  };
  reel.addEventListener('touchend', finishDrag, { passive: true });
  reel.addEventListener('touchcancel', finishDrag, { passive: true });
}
function renderRealPhotoCarousel(item, photoUrl, axis) {
  const isLandscape = axis === 'horizontal';
  const dialog = byId('mediaDetailContent').closest('.media-detail');
  const backdrop = byId('mediaDetailBackdrop');
  setPhotoViewerMode(isLandscape ? 'landscape' : 'portrait');
  backdrop.classList.toggle('media-detail-backdrop--viewer', isLandscape);
  dialog.classList.toggle('media-detail--viewer', isLandscape);
  dialog.classList.toggle('media-detail--photo', !isLandscape);
  const portraitDetails = isLandscape ? '' : `<button class="media-photo-delete" id="realPhotoDelete" type="button" hidden aria-label="이 사진 삭제" title="이 사진 삭제">🗑</button><div class="media-detail-copy" id="realPhotoMeta"></div>`;
  byId('mediaDetailContent').innerHTML = `<div class="real-photo-detail real-photo-detail--${axis}"><div class="real-photo-reel real-photo-reel--${axis}" id="realPhotoReel"><div class="real-photo-track" id="realPhotoTrack"></div></div>${portraitDetails}</div>`;
  setupRealPhotoCarousel(item, photoUrl, axis);
}
function renderPhotoViewer(item, photoUrl) {
  renderRealPhotoCarousel(item, photoUrl, 'horizontal');
}
function renderPhotoDetail(item, photoUrl) {
  renderRealPhotoCarousel(item, photoUrl, landscapeMediaQuery.matches ? 'horizontal' : 'vertical');
}
async function movePhotoViewer(direction, { skipExit = false } = {}) {
  let photos = photoViewerItems();
  let currentIndex = photos.findIndex((item) => item.id === activeMediaDetailId);
  let target = photos[currentIndex + direction];
  if (!target && direction > 0 && mediaHasMore) {
    await loadMedia();
    photos = photoViewerItems();
    currentIndex = photos.findIndex((item) => item.id === activeMediaDetailId);
    target = photos[currentIndex + direction];
  }
  if (!target && photos.length > 1) target = direction > 0 ? photos[0] : photos.at(-1);
  if (!target) {
    showToast(direction > 0 ? '마지막 사진이에요.' : '첫 사진이에요.');
    return;
  }
  if (!skipExit && !await animatePhotoTransition(direction, 'horizontal')) return;
  try {
    await openMediaDetail(target, { direction, axis: 'horizontal' });
  } finally {
    photoTransitionBusy = false;
  }
}
async function animatePhotoTransition(direction, axis) {
  if (photoTransitionBusy) return false;
  const current = byId(axis === 'horizontal' ? 'photoFullscreenViewer' : 'mediaPhotoCarousel');
  if (!current) return true;
  photoTransitionBusy = true;
  current.classList.add('photo-transition-exit', `photo-transition-exit--${axis}`, `photo-transition-exit--${direction > 0 ? 'next' : 'previous'}`);
  await new Promise((resolve) => window.setTimeout(resolve, 145));
  return true;
}
function bindPhotoDrag(main, axis, onCommit, onRelease = () => {}, moveTarget = main) {
  let startX = 0;
  let startY = 0;
  let distance = 0;
  let dragging = false;
  const reset = () => {
    moveTarget.classList.remove('is-photo-dragging', 'photo-drag-commit');
    moveTarget.style.transform = '';
  };
  main.addEventListener('touchstart', (event) => {
    if (photoTransitionBusy) return;
    const touch = event.changedTouches[0];
    startX = touch.clientX;
    startY = touch.clientY;
    distance = 0;
    dragging = false;
  }, { passive: true });
  main.addEventListener('touchmove', (event) => {
    if (photoTransitionBusy) return;
    const touch = event.changedTouches[0];
    const primary = axis === 'horizontal' ? touch.clientX - startX : touch.clientY - startY;
    const cross = axis === 'horizontal' ? touch.clientY - startY : touch.clientX - startX;
    if (!dragging && Math.abs(primary) < Math.abs(cross) * 1.2) return;
    if (Math.abs(primary) < 6) return;
    dragging = true;
    event.preventDefault();
    const limit = (axis === 'horizontal' ? moveTarget.clientWidth : moveTarget.clientHeight) * 0.42;
    distance = Math.max(-limit, Math.min(limit, primary * 0.72));
    moveTarget.classList.add('is-photo-dragging');
    moveTarget.style.transform = axis === 'horizontal' ? `translateX(${distance}px)` : `translateY(${distance}px)`;
  }, { passive: false });
  const finish = () => {
    if (!dragging) return;
    const threshold = Math.min(96, (axis === 'horizontal' ? moveTarget.clientWidth : moveTarget.clientHeight) * 0.16);
    const committed = Math.abs(distance) >= threshold;
    onRelease({ dragged: true, committed });
    if (!committed) {
      reset();
      return;
    }
    const direction = distance < 0 ? 1 : -1;
    photoTransitionBusy = true;
    moveTarget.classList.remove('is-photo-dragging');
    moveTarget.classList.add('photo-drag-commit');
    const finishDistance = (axis === 'horizontal' ? moveTarget.clientWidth : moveTarget.clientHeight) * (direction > 0 ? -1.08 : 1.08);
    moveTarget.style.transform = axis === 'horizontal' ? `translateX(${finishDistance}px)` : `translateY(${finishDistance}px)`;
    window.setTimeout(() => onCommit(direction), 165);
  };
  main.addEventListener('touchend', finish, { passive: true });
  main.addEventListener('touchcancel', () => { if (dragging) { onRelease({ dragged: true, committed: false }); reset(); } }, { passive: true });
}
function bindPhotoViewerSwipe() {
  const viewer = byId('photoFullscreenViewer');
  const main = byId('photoFullscreenMain');
  if (!viewer || !main) return;
  viewer.querySelectorAll('[data-photo-viewer-direction]').forEach((button) => button.addEventListener('click', () => movePhotoViewer(Number(button.dataset.photoViewerDirection))));
  bindPhotoDrag(main, 'horizontal', (direction) => movePhotoViewer(direction, { skipExit: true }), () => {}, viewer);
}
async function openPhotoViewer(item, transition) {
  const requestId = ++photoViewerRequestId;
  const dialog = byId('mediaDetailContent').closest('.media-detail');
  const fullscreen = landscapeMediaQuery.matches;
  setPhotoViewerMode(fullscreen ? 'landscape' : 'portrait');
  byId('mediaDetailBackdrop').classList.toggle('media-detail-backdrop--viewer', fullscreen);
  dialog.classList.toggle('media-detail--photo', !fullscreen);
  dialog.classList.toggle('media-detail--viewer', fullscreen);
  byId('mediaDetailContent').innerHTML = '<p class="media-detail-wait">사진을 불러오는 중이에요…</p>';
  try {
    const photoUrl = await resolvePhotoSource(item);
    if (requestId !== photoViewerRequestId || activeMediaDetailId !== item.id) return;
    renderPhotoDetail(item, photoUrl, transition);
  } catch (error) {
    byId('mediaDetailContent').innerHTML = '<p class="media-detail-wait">사진을 불러오지 못했어요.</p>';
    showToast(error.message || '사진을 불러오지 못했어요.');
  }
}
async function openMediaDetail(item, transition) {
  activeMediaDetailId = item.id;
  byId('mediaDetailBackdrop').hidden = false;
  if (item.mediaType === 'video') {
    resetPhotoViewer();
    activeMediaDetailId = item.id;
    renderMediaDetail(item, '', transition);
    return;
  }
  await openPhotoViewer(item, transition);
}
async function deleteMediaItem(item, button) {
  if (!window.confirm(item.mediaType === 'photo' ? '이 사진을 삭제할까요? 삭제 후에는 되돌릴 수 없어요.' : '이 유튜브 링크를 삭제할까요?')) return;
  const currentIndex = mediaGalleryItems().findIndex((entry) => entry.id === item.id);
  const iconButton = button.classList.contains('media-photo-delete');
  button.disabled = true;
  button.textContent = iconButton ? '…' : '삭제 중…';
  try {
    await api(`/media/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
    mediaItems = mediaItems.filter((entry) => entry.id !== item.id);
    renderMedia();
    let nextItem = mediaGalleryItems()[currentIndex] || mediaGalleryItems()[currentIndex - 1];
    if (!nextItem && mediaHasMore) {
      await loadMedia();
      const loadedItems = mediaGalleryItems();
      nextItem = loadedItems[currentIndex] || loadedItems[currentIndex - 1] || loadedItems[0];
    }
    if (nextItem) await openMediaDetail(nextItem);
    else closeMediaDetail();
    showToast('사진·영상을 삭제했어요.');
  } catch (error) {
    showToast(error.message || '삭제하지 못했어요.');
  } finally {
    button.disabled = false;
    if (iconButton) button.textContent = '🗑';
  }
}

function enterApp(member, sessionToken = '') {
  activeMember = member;
  localStorage.setItem(memberStorageKey, member);
  if (sessionToken) localStorage.setItem(sessionStorageKey, sessionToken);
  byId('memberInitial').textContent = member.slice(0, 1);
  byId('memberName').textContent = member;
  byId('expensePerson').value = member;
  byId('loginScreen').hidden = true;
  byId('appShell').hidden = false;
}
function signOut(focus = true) {
  localStorage.removeItem(memberStorageKey);
  localStorage.removeItem(sessionStorageKey);
  activeMember = '';
  byId('appShell').hidden = true;
  byId('loginScreen').hidden = false;
  byId('memberCode').value = '';
  byId('loginError').hidden = true;
  if (focus) byId('memberCode').focus();
}

byId('openExpense').addEventListener('click', openExpense);
byId('closeExpense').addEventListener('click', closeExpense);
byId('closeIncome').addEventListener('click', closeIncome);
byId('closeDetail').addEventListener('click', closeDetail);
byId('openMedia').addEventListener('click', openMedia);
byId('closeMedia').addEventListener('click', closeMedia);
byId('closeMediaDetail').addEventListener('click', closeMediaDetail);
byId('refreshApp').addEventListener('click', async () => {
  const button = byId('refreshApp');
  button.classList.add('is-refreshing');
  try {
    await serviceWorkerRegistration?.update();
  } catch {
    // A normal reload still refreshes the latest app when the device is online.
  }
  window.setTimeout(() => window.location.reload(), 450);
});
document.querySelectorAll('.modal-backdrop').forEach((backdrop) => backdrop.addEventListener('click', (event) => { if (event.target === backdrop) closeAllModals(); }));
const modalScrollObserver = new MutationObserver(syncModalScrollLock);
document.querySelectorAll('.modal-backdrop').forEach((backdrop) => modalScrollObserver.observe(backdrop, { attributes: true, attributeFilter: ['hidden'] }));
syncModalScrollLock();
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeAllModals(); });
document.querySelectorAll('.main-tab').forEach((button) => button.addEventListener('click', () => setActiveView(button.dataset.view)));
document.querySelectorAll('.media-filter').forEach((button) => button.addEventListener('click', () => {
  document.querySelector('.media-filter.is-active')?.classList.remove('is-active');
  button.classList.add('is-active');
  activeMediaFilter = button.dataset.mediaFilter;
  renderMedia();
}));
document.querySelectorAll('.media-form-tab').forEach((button) => button.addEventListener('click', () => setMediaForm(button.dataset.mediaForm)));
byId('mediaPhotoInput').addEventListener('change', (event) => setSelectedMediaFiles(event.target.files));
byId('mediaPhotoForm').addEventListener('submit', saveMediaPhotos);
byId('mediaVideoForm').addEventListener('submit', saveMediaVideo);
byId('mediaFeed').addEventListener('click', (event) => {
  const card = event.target.closest('[data-media-id]');
  if (!card) return;
  const item = mediaItems.find((entry) => entry.id === card.dataset.mediaId);
  if (item) openMediaDetail(item);
});
byId('mediaDateRail').addEventListener('click', (event) => {
  const button = event.target.closest('[data-media-target]');
  if (!button) return;
  byId(`media-date-${button.dataset.mediaTarget}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
});
let photoOrientationTimer;
function refreshOpenPhotoForOrientation() {
  window.clearTimeout(photoOrientationTimer);
  photoOrientationTimer = window.setTimeout(() => {
    if (byId('mediaDetailBackdrop').hidden) return;
    const item = mediaItems.find((entry) => entry.id === activeMediaDetailId);
    if (item?.mediaType === 'photo') openMediaDetail(item);
  }, 160);
}
landscapeMediaQuery.addEventListener?.('change', refreshOpenPhotoForOrientation);
window.addEventListener('orientationchange', refreshOpenPhotoForOrientation);
window.addEventListener('scroll', updateActiveMediaDate, { passive: true });
if ('IntersectionObserver' in window) {
  mediaObserver = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting) && activeView === 'media') loadMedia();
  }, { rootMargin: '500px 0px' });
  mediaObserver.observe(byId('mediaSentinel'));
}

byId('receiptInput').addEventListener('change', (event) => {
  const [file] = event.target.files;
  if (!file) return;
  selectedFile = file;
  byId('previewImage').src = URL.createObjectURL(file);
  byId('receiptFileName').textContent = file.name.length > 24 ? `${file.name.slice(0, 21)}…` : file.name;
  byId('receiptPreview').hidden = false;
});
byId('removeReceipt').addEventListener('click', clearReceipt);

byId('incomeInput').addEventListener('change', (event) => {
  const [file] = event.target.files;
  if (!file) return;
  selectedIncomeFile = file;
  byId('incomePreviewImage').src = URL.createObjectURL(file);
  byId('incomeFileName').textContent = file.name.length > 24 ? `${file.name.slice(0, 21)}…` : file.name;
  byId('incomePreview').hidden = false;
});
byId('removeIncome').addEventListener('click', clearIncomeImage);

byId('expenseForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!selectedFile) { showToast('영수증 또는 카드 전표 사진을 선택해 주세요.'); return; }
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  const refundBank = String(form.get('refundBank') || '').trim();
  const refundAccount = String(form.get('refundAccount') || '').replace(/\s/g, '');
  if (!refundBank || !refundAccount) { showToast('환불 받을 은행명과 계좌번호를 입력해 주세요.'); return; }
  const button = byId('saveExpenseButton');
  button.disabled = true;
  button.textContent = cloudMode ? '영수증 읽는 중…' : '사진 저장 중…';
  try {
    const proof = await compressImage(selectedFile);
    if (cloudMode) {
      const result = await api('/expenses/scan', {
        method: 'POST',
        body: { imageBase64: proof.split(',')[1], mimeType: 'image/jpeg', refundBank, refundAccount },
      });
      formElement.reset();
      clearReceipt();
      closeExpense();
      await loadRecords();
      showToast(result.needsReview ? '영수증은 저장했어요. 금액을 한 번 확인해 주세요.' : '영수증을 읽고 지출을 자동 등록했어요.');
    } else {
      const amount = parseAmountInput(form.get('amount'));
      const person = form.get('person').trim();
      const date = form.get('date');
      if (!amount || !person || !date) { showToast('금액과 날짜를 입력해 주세요.'); return; }
      const records = getLocalRecords();
      records.push({ id: crypto.randomUUID(), type: 'expense', amount, person, date, memo: form.get('memo').trim(), refundBank, refundAccount, proof });
      saveLocalRecords(records);
      formElement.reset();
      clearReceipt();
      closeExpense();
      await loadRecords();
      showToast('영수증과 지출 기록을 저장했어요.');
    }
  } catch (error) {
    showToast(error.message || '사진을 저장하지 못했어요. 다시 시도해 주세요.');
  } finally {
    button.disabled = false;
    button.innerHTML = cloudMode ? '영수증 읽고 자동 저장 <span>→</span>' : '지출 저장하기 <span>→</span>';
  }
});

byId('incomeForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!selectedIncomeFile) { showToast('통장 입금 내역 사진을 선택해 주세요.'); return; }
  if (!cloudMode) { showToast('입금 자동 기록은 AWS 연결 후 사용할 수 있어요.'); return; }

  const formElement = event.currentTarget;
  const button = byId('saveIncomeButton');
  button.disabled = true;
  button.textContent = '입금 내역 읽는 중…';
  try {
    const proof = await compressImage(selectedIncomeFile);
    const result = await api('/incomes/scan', {
      method: 'POST',
      body: { imageBase64: proof.split(',')[1], mimeType: 'image/jpeg' },
    });
    formElement.reset();
    clearIncomeImage();
    closeIncome();
    await loadRecords();
    showToast(result.needsReview ? '입금 내역은 저장했어요. 날짜와 금액을 확인해 주세요.' : '입금 내역을 읽고 자동 등록했어요.');
  } catch (error) {
    showToast(error.message || '입금 내역을 저장하지 못했어요. 다시 시도해 주세요.');
  } finally {
    button.disabled = false;
    button.innerHTML = '입금 내역 읽고 자동 저장 <span>→</span>';
  }
});

document.querySelectorAll('.filter').forEach((button) => button.addEventListener('click', () => {
  document.querySelector('.filter.is-active').classList.remove('is-active');
  button.classList.add('is-active');
  activeFilter = button.dataset.filter;
  render();
}));
byId('ledger').addEventListener('click', (event) => {
  const row = event.target.closest('.ledger-row');
  if (row) openDetail(recordsCache.find((record) => record.id === row.dataset.id));
});
byId('paymentList').addEventListener('click', (event) => {
  const button = event.target.closest('[data-payment-id]');
  if (!button) return;
  const record = recordsCache.find((item) => item.id === button.dataset.paymentId);
  const paymentDate = button.closest('.payment-card')?.querySelector('[data-payment-date]')?.value;
  if (record) savePaymentStatus(record, button.dataset.paymentStatus, button, paymentDate);
});
byId('memberButton').addEventListener('click', () => {
  if (window.confirm('다른 멤버로 이 기기를 사용할까요?')) signOut();
});

byId('loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const code = byId('memberCode').value.replaceAll(' ', '');
  const localMember = members.find((name) => code === `${name}0717`);
  if (!localMember) { byId('loginError').hidden = false; return; }
  try {
    if (cloudMode) {
      const result = await api('/auth', { method: 'POST', body: { code }, authenticated: false });
      enterApp(result.member, result.token);
    } else {
      enterApp(localMember);
    }
    byId('loginError').hidden = true;
    await loadRecords();
  } catch {
    byId('loginError').hidden = false;
  }
});

byId('monthLabel').textContent = `${new Date().getFullYear()}년 ${new Date().getMonth() + 1}월`;
document.body.classList.toggle('cloud-mode', cloudMode);
if (cloudMode) byId('saveExpenseButton').innerHTML = '영수증 읽고 자동 저장 <span>→</span>';
setToday();
enableAmountCommas(byId('expenseValue'));
const savedMember = localStorage.getItem(memberStorageKey);
const savedToken = localStorage.getItem(sessionStorageKey);
if (members.includes(savedMember) && (!cloudMode || savedToken)) {
  enterApp(savedMember);
  loadRecords();
}

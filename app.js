if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js').catch(() => {
      // The app still works online when a browser blocks service workers.
    });
  });
}

const byId = (id) => document.getElementById(id);
const storageKey = 'simji-ledger-v1';
const memberStorageKey = 'simji-member-v1';
const sessionStorageKey = 'simji-session-v1';
const members = ['종남', '인기', '상훈', '민철', '공근', '성호'];
const apiUrl = (window.SIMJI_CONFIG?.apiUrl || '').replace(/\/$/, '');
const cloudMode = Boolean(apiUrl);

let selectedFile = null;
let activeFilter = 'all';
let activeMember = '';
let recordsCache = [];
let toastTimer;

function formatMoney(value) { return `₩${Number(value || 0).toLocaleString('ko-KR')}`; }
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
function setToday() { byId('expenseDate').value = new Date().toISOString().slice(0, 10); }

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

function render() {
  const records = [...recordsCache].sort((a, b) => new Date(b.date) - new Date(a.date));
  const income = records.filter((record) => record.type === 'income').reduce((sum, record) => sum + Number(record.amount || 0), 0);
  const expense = records.filter((record) => record.type === 'expense').reduce((sum, record) => sum + Number(record.amount || 0), 0);
  byId('incomeAmount').textContent = formatMoney(income);
  byId('expenseAmount').textContent = formatMoney(expense);
  byId('recordCount').textContent = `${records.length}건`;
  byId('balanceAmount').textContent = income ? formatMoney(income - expense) : '입금 내역 필요';
  byId('balanceHint').textContent = income ? '계좌 거래내역 기준으로 계산한 금액이에요.' : '계좌 거래내역 엑셀을 올리면 잔액을 계산해요.';

  const filtered = records.filter((record) => activeFilter === 'all' || record.type === activeFilter);
  byId('ledger').innerHTML = filtered.map((record) => {
    const label = record.type === 'income' ? '회비 입금' : (record.memo || '영수증 지출');
    const person = record.type === 'income' ? '계좌 거래내역' : `${record.person || record.member} · 증빙 사진 있음`;
    const proofUrl = record.proofUrl || record.proof;
    const icon = proofUrl ? `<img src="${proofUrl}" alt="" />` : record.type === 'income' ? '↓' : '⌑';
    return `<button class="ledger-row ledger-row--${record.type}" data-id="${record.id}"><span class="ledger-row__icon">${icon}</span><span class="ledger-row__main"><b>${escapeHtml(label)}</b><span>${escapeHtml(person)} · ${formatDate(record.date)}</span></span><span class="ledger-row__amount"><b>${record.type === 'income' ? '+' : '−'}${formatMoney(record.amount)}</b><span>${record.type === 'income' ? '입금' : '영수증'}</span></span></button>`;
  }).join('');
  byId('emptyState').hidden = filtered.length > 0;
}

function openExpense() {
  byId('expenseBackdrop').hidden = false;
  byId('expensePerson').value = activeMember;
  setToday();
}
function closeExpense() { byId('expenseBackdrop').hidden = true; }
function clearReceipt() {
  selectedFile = null;
  byId('receiptInput').value = '';
  byId('receiptPreview').hidden = true;
  byId('previewImage').src = '';
}
function compressImage(file) {
  return new Promise((resolve, reject) => {
    const source = new Image();
    const reader = new FileReader();
    reader.onload = () => { source.src = reader.result; };
    reader.onerror = reject;
    source.onload = () => {
      const maxSize = 1280;
      const scale = Math.min(1, maxSize / Math.max(source.width, source.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(source.width * scale);
      canvas.height = Math.round(source.height * scale);
      canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', 0.76));
    };
    source.onerror = reject;
    reader.readAsDataURL(file);
  });
}
function openDetail(record) {
  const proofUrl = record.proofUrl || record.proof;
  byId('detailType').textContent = record.type === 'income' ? 'INCOME' : 'EXPENSE';
  byId('detailTitle').textContent = record.type === 'income' ? '회비 입금' : (record.memo || '영수증 지출');
  byId('detailContent').innerHTML = `<div class="detail-content">${proofUrl ? `<img class="detail-proof" src="${proofUrl}" alt="등록한 영수증" />` : ''}<p class="detail-amount">${record.type === 'income' ? '+' : '−'}${formatMoney(record.amount)}</p><dl class="detail-list"><div><dt>기록 날짜</dt><dd>${formatDate(record.date)}</dd></div><div><dt>${record.type === 'income' ? '확인 방식' : '지출한 사람'}</dt><dd>${escapeHtml(record.type === 'income' ? '계좌 거래내역' : (record.person || record.member))}</dd></div>${record.memo ? `<div><dt>메모</dt><dd>${escapeHtml(record.memo)}</dd></div>` : ''}</dl></div>`;
  byId('detailBackdrop').hidden = false;
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
byId('closeDetail').addEventListener('click', () => { byId('detailBackdrop').hidden = true; });
document.querySelectorAll('.modal-backdrop').forEach((backdrop) => backdrop.addEventListener('click', (event) => { if (event.target === backdrop) backdrop.hidden = true; }));
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') document.querySelectorAll('.modal-backdrop').forEach((backdrop) => { backdrop.hidden = true; }); });

byId('receiptInput').addEventListener('change', (event) => {
  const [file] = event.target.files;
  if (!file) return;
  selectedFile = file;
  byId('previewImage').src = URL.createObjectURL(file);
  byId('receiptFileName').textContent = file.name.length > 24 ? `${file.name.slice(0, 21)}…` : file.name;
  byId('receiptPreview').hidden = false;
});
byId('removeReceipt').addEventListener('click', clearReceipt);

byId('expenseForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!selectedFile) { showToast('영수증 또는 카드 전표 사진을 선택해 주세요.'); return; }
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  const button = byId('saveExpenseButton');
  button.disabled = true;
  button.textContent = cloudMode ? '영수증 읽는 중…' : '사진 저장 중…';
  try {
    const proof = await compressImage(selectedFile);
    if (cloudMode) {
      const result = await api('/expenses/scan', {
        method: 'POST',
        body: { imageBase64: proof.split(',')[1], mimeType: 'image/jpeg' },
      });
      formElement.reset();
      clearReceipt();
      closeExpense();
      await loadRecords();
      showToast(result.needsReview ? '영수증은 저장했어요. 금액을 한 번 확인해 주세요.' : '영수증을 읽고 지출을 자동 등록했어요.');
    } else {
      const amount = Number(form.get('amount'));
      const person = form.get('person').trim();
      const date = form.get('date');
      if (!amount || !person || !date) { showToast('금액과 날짜를 입력해 주세요.'); return; }
      const records = getLocalRecords();
      records.push({ id: crypto.randomUUID(), type: 'expense', amount, person, date, memo: form.get('memo').trim(), proof });
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
byId('bankNote').addEventListener('click', () => showToast('다음 단계에서 계좌 거래내역 엑셀 업로드를 연결할게요.'));
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
const savedMember = localStorage.getItem(memberStorageKey);
const savedToken = localStorage.getItem(sessionStorageKey);
if (members.includes(savedMember) && (!cloudMode || savedToken)) {
  enterApp(savedMember);
  loadRecords();
}

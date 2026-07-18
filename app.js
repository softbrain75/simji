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
function closeExpense() { byId('expenseBackdrop').hidden = true; }
function openIncome() { byId('incomeBackdrop').hidden = false; }
function closeIncome() { byId('incomeBackdrop').hidden = true; }
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

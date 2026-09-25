/* Общий код для страницы квиза и админ-панели. */
const CFG = window.QUIZ_CONFIG || {};
const CONFIGURED = !!(CFG.SUPABASE_URL && CFG.SUPABASE_KEY) && !/YOUR-/.test(CFG.SUPABASE_URL + CFG.SUPABASE_KEY);
const sb = CONFIGURED ? window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_KEY) : null;

const PLAY_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15l13-7.5z"/></svg>';
const PAUSE_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 4h4.5v16H6zM13.5 4H18v16h-4.5z"/></svg>';
const LETTERS = 'АБВГДЕ';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = (a, b) => (b ? Math.round((a * 100) / b) : 0);
const fmtMs = ms => (ms == null || isNaN(ms) ? '—' : (ms / 1000).toFixed(1).replace('.', ',') + ' с');
const mmss = s => { s = Math.max(0, s || 0); return Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0'); };
function plural(n, one, few, many) {
  n = Math.abs(n) % 100; const m = n % 10;
  if (n > 10 && n < 20) return many; if (m > 1 && m < 5) return few; if (m === 1) return one; return many;
}
function toast(msg) {
  let t = $('#toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
  t.textContent = msg; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 3500);
}
const audioUrl = path => sb.storage.from('fragments').getPublicUrl(path).data.publicUrl;

/* Понятные сообщения для ошибок сервера. */
const ERRORS = {
  not_authenticated: 'Сессия истекла. Войдите заново.',
  no_profile: 'Сначала завершите регистрацию.',
  question_not_found: 'Этот фрагмент сняли с игры. Переходим к следующему.',
  not_started: 'Сначала включите фрагмент.',
  invalid_choice: 'Такого варианта нет.',
  question_has_no_key: 'У фрагмента не отмечен правильный ответ. Сообщите организатору.',
  forbidden: 'Нет прав администратора.',
  options_count: 'Нужно от 2 до 6 вариантов.',
  empty_option: 'Заполните все варианты.',
  invalid_correct: 'Отметьте правильный вариант.',
  audio_required: 'Выберите аудиофайл.'
};
function errText(e) {
  if (!e) return 'Неизвестная ошибка.';
  const m = e.message || String(e);
  for (const k in ERRORS) if (m.includes(k)) return ERRORS[k];
  if (e.status === 429 || /rate limit/i.test(m)) return 'Слишком много попыток. Подождите минуту и повторите.';
  if (/Failed to fetch|NetworkError/i.test(m)) return 'Нет связи с сервером. Проверьте интернет.';
  return m;
}

function renderNotConfigured(el) {
  el.innerHTML = `<div class="card narrow"><h2>Сайт ещё не настроен</h2>
    <p class="muted">Откройте файл <code>js/config.js</code> и впишите публичный ключ Supabase (SUPABASE_PUBLISHABLE_KEY). Подробности — в README.</p></div>`;
}

/* Ошибка из ссылки для входа (например, ссылка устарела). */
function takeAuthErrorFromUrl() {
  const h = new URLSearchParams(location.hash.slice(1));
  const q = new URLSearchParams(location.search);
  const d = h.get('error_description') || q.get('error_description');
  if (d) history.replaceState(null, '', location.pathname);
  if (!d) return null;
  return /expired|invalid/i.test(d) ? 'Ссылка для входа устарела или уже использована. Запросите новую.' : d;
}

/* Вход по почте: ссылка в письме или одноразовый код. */
function renderLogin(el, { title = 'Вход', text = '' } = {}) {
  const urlErr = takeAuthErrorFromUrl();
  el.innerHTML = `
  <div class="card narrow">
    <h2>${esc(title)}</h2>
    <p class="muted">${esc(text || 'Введите почту — пришлём ссылку и код для входа. Пароль не нужен.')}</p>
    <div class="stack" id="loginStep1">
      <div><label class="f" for="loginEmail">Электронная почта</label>
        <input id="loginEmail" type="email" autocomplete="email" inputmode="email" maxlength="120" placeholder="name@gmail.com"></div>
      <div class="row"><button class="btn" id="sendLink">Получить код</button><span class="err small" id="loginErr">${esc(urlErr || '')}</span></div>
    </div>
    <div class="stack" id="loginStep2" hidden>
      <p>Письмо отправлено на <b id="sentTo"></b>. Нажмите ссылку в письме или введите код из него.</p>
      <div><label class="f" for="loginCode">Код из письма</label>
        <input id="loginCode" class="code-input" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="10"></div>
      <div class="row"><button class="btn" id="verifyCode">Войти</button>
        <button class="btn ghost" id="resend" disabled>Отправить ещё раз</button>
        <button class="linkbtn" id="changeEmail">Другая почта</button></div>
      <p class="err small" id="codeErr"></p>
      <p class="muted small">Письма нет? Проверьте папку «Спам». Код действует ограниченное время.</p>
    </div>
  </div>`;
  let email = '', timer;
  const cooldown = () => {
    let s = 60; const b = $('#resend'); b.disabled = true;
    clearInterval(timer);
    timer = setInterval(() => { s--; b.textContent = s > 0 ? `Отправить ещё раз (${s})` : 'Отправить ещё раз'; if (s <= 0) { b.disabled = false; clearInterval(timer); } }, 1000);
  };
  const send = async () => {
    const { error } = await sb.auth.signInWithOtp({
      email, options: { emailRedirectTo: location.origin + location.pathname, shouldCreateUser: true }
    });
    if (error) throw error;
  };
  $('#sendLink').onclick = async () => {
    email = $('#loginEmail').value.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { $('#loginErr').textContent = 'Проверьте адрес — например, name@gmail.com.'; return; }
    const b = $('#sendLink'); b.disabled = true; b.innerHTML = '<span class="spinner"></span> Отправляем…';
    try {
      await send();
      $('#sentTo').textContent = email; $('#loginStep1').hidden = true; $('#loginStep2').hidden = false; $('#loginCode').focus(); cooldown();
    } catch (e) { $('#loginErr').textContent = errText(e); }
    b.disabled = false; b.textContent = 'Получить код';
  };
  $('#loginEmail').onkeydown = e => { if (e.key === 'Enter') $('#sendLink').click(); };
  $('#resend').onclick = async () => { try { await send(); toast('Письмо отправлено ещё раз'); cooldown(); } catch (e) { $('#codeErr').textContent = errText(e); } };
  $('#changeEmail').onclick = () => { clearInterval(timer); $('#loginStep2').hidden = true; $('#loginStep1').hidden = false; };
  $('#verifyCode').onclick = async () => {
    const token = $('#loginCode').value.replace(/\s/g, '');
    if (!/^\d{6,10}$/.test(token)) { $('#codeErr').textContent = 'Код состоит из цифр — скопируйте его из письма.'; return; }
    const b = $('#verifyCode'); b.disabled = true;
    const { error } = await sb.auth.verifyOtp({ email, token, type: 'email' });
    b.disabled = false;
    if (error) $('#codeErr').textContent = /expired|invalid/i.test(error.message) ? 'Код неверный или устарел. Запросите новый.' : errText(error);
  };
  $('#loginCode').onkeydown = e => { if (e.key === 'Enter') $('#verifyCode').click(); };
}

/* Подписка на вход/выход. Колбэк вызывается асинхронно, чтобы не блокировать клиент Supabase. */
function onAuth(cb) {
  let lastUser;
  sb.auth.onAuthStateChange((event, session) => {
    const uid = session?.user?.id || null;
    if (event === 'INITIAL_SESSION' || uid !== lastUser) { lastUser = uid; setTimeout(() => cb(session), 0); }
  });
}

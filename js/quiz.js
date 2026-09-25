/* Страница игрока: вход, регистрация, прохождение квиза, рейтинг. */
const Q = { session: null, profile: null, isAdmin: false, list: [], view: 'play', busy: false };

document.title = (CFG.SITE_NAME || 'На слух') + ' — музыкальный квиз';
$('#siteName').textContent = CFG.SITE_NAME || 'На слух';

$$('#tabs button').forEach(b => (b.onclick = () => { Q.view = b.dataset.v; stopAudio(); route(); }));

function stopAudio() { $$('audio').forEach(a => a.pause()); }
function setTabs() { $$('#tabs button').forEach(b => (b.dataset.v === Q.view ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current'))); }

function renderWho() {
  const w = $('#who');
  if (!Q.session) { w.innerHTML = ''; return; }
  w.innerHTML = `${Q.profile ? `<button class="linkbtn" id="editProfile">${esc(Q.profile.nickname)}</button>` : ''}
    ${Q.isAdmin ? '<a href="admin.html">Админ-панель</a>' : ''}
    <button class="linkbtn" id="logout">Выйти</button>`;
  $('#logout').onclick = async () => { stopAudio(); await sb.auth.signOut(); };
  const ep = $('#editProfile'); if (ep) ep.onclick = () => { stopAudio(); renderProfileForm(Q.profile); };
}

async function route() {
  setTabs();
  const main = $('#main');
  if (Q.view === 'board') return renderBoard();
  if (!Q.session) return renderLogin(main, { title: 'Вход в квиз', text: 'Введите почту — пришлём ссылку и код для входа. Если вы здесь впервые, после входа останется придумать имя для рейтинга.' });
  if (!Q.profile) return renderProfileForm(null);
  await loadState();
  const next = Q.list.find(q => !q.answered);
  if (!Q.list.length) {
    main.innerHTML = `<div class="card"><h2>Фрагментов пока нет</h2><p class="muted">${Q.isAdmin ? 'Добавьте первый фрагмент в <a href="admin.html">админ-панели</a>.' : 'Организатор ещё не выложил музыку. Загляните позже.'}</p></div>`;
    return;
  }
  if (!next) return renderFinished();
  renderQuestion(next);
}

async function loadState() {
  const { data, error } = await sb.rpc('quiz_state');
  if (error) { toast(errText(error)); Q.list = []; return; }
  Q.list = data || [];
}

/* ---------- регистрация / профиль ---------- */
function renderProfileForm(existing) {
  const email = Q.session.user.email;
  $('#main').innerHTML = `
  <div class="card narrow">
    <h2>${existing ? 'Ваш профиль' : 'Почти готово'}</h2>
    <p class="muted">${existing ? 'Имя можно поменять в любой момент.' : 'Придумайте имя, под которым вас увидят в рейтинге.'}</p>
    <div class="stack">
      <div><label class="f">Почта</label><input type="email" value="${esc(email)}" disabled></div>
      <div><label class="f" for="nick">Имя в рейтинге</label>
        <input id="nick" type="text" maxlength="40" autocomplete="nickname" value="${esc(existing?.nickname || '')}"></div>
      <label class="row small"><input type="checkbox" id="showMe" ${existing?.show_in_rating === false ? '' : 'checked'}> Показывать моё имя в общем рейтинге</label>
      <p class="muted small" style="margin:0">Почта нужна только для входа, её видит лишь организатор квиза. Удалить свои данные можно в профиле в любой момент.</p>
      <div class="row"><button class="btn" id="saveProfile">${existing ? 'Сохранить' : 'Начать игру'}</button>
        ${existing ? '<button class="btn ghost" id="cancelProfile">Отмена</button>' : ''}
        <span class="err small" id="profErr"></span></div>
      ${existing ? `<div style="border-top:1px solid var(--line);padding-top:16px">
        <h3>Удалить мои данные</h3>
        <p class="muted small">Удалятся профиль, все ответы, место в рейтинге и почта. Отменить это нельзя.</p>
        <button class="btn danger sm" id="deleteMe">Удалить аккаунт</button></div>` : ''}
    </div>
  </div>`;
  if (existing) {
    $('#cancelProfile').onclick = route;
    $('#deleteMe').onclick = async () => {
      if (!confirm('Удалить аккаунт, все ответы и место в рейтинге? Отменить это нельзя.')) return;
      const { error } = await sb.rpc('delete_my_account');
      if (error) { toast(errText(error)); return; }
      toast('Данные удалены'); await sb.auth.signOut();
    };
  }
  $('#saveProfile').onclick = async () => {
    const nickname = $('#nick').value.trim();
    if (nickname.length < 2) { $('#profErr').textContent = 'Имя должно быть не короче 2 символов.'; return; }
    const row = { id: Q.session.user.id, nickname, show_in_rating: $('#showMe').checked };
    const { data, error } = existing
      ? await sb.from('profiles').update({ nickname, show_in_rating: row.show_in_rating }).eq('id', row.id).select().single()
      : await sb.from('profiles').insert(row).select().single();
    if (error) { $('#profErr').textContent = errText(error); return; }
    Q.profile = data; renderWho(); toast(existing ? 'Профиль сохранён' : 'Добро пожаловать!'); route();
  };
}

/* ---------- вопрос ---------- */
function renderQuestion(q) {
  const done = Q.list.filter(x => x.answered).length;
  const ok = Q.list.filter(x => x.is_correct).length;
  $('#main').innerHTML = `
  <div class="card">
    <div class="progress-line">
      <span class="qnum">Фрагмент ${done + 1} из ${Q.list.length}</span>
      <span class="score">${ok} <small>${plural(ok, 'верный ответ', 'верных ответа', 'верных ответов')}</small></span>
    </div>
    <div class="stage">
      <button class="disc" id="disc" aria-label="Слушать фрагмент">
        <span class="ring"></span><span class="vinyl"></span><span class="center" id="discIcon">${PLAY_ICON}</span>
      </button>
      <div>
        <p class="prompt">${esc(q.prompt || 'Что звучит?')}</p>
        <div class="opts" id="opts"><div class="placeholder">Варианты ответа появятся, когда вы включите фрагмент</div></div>
        <p class="hint" id="hint">${q.started
          ? 'Вы уже открывали этот фрагмент — время ответа идёт с первого запуска.'
          : 'Нажмите на пластинку. Время ответа засекается с этого момента.'}</p>
        <div class="feedback" id="fb" aria-live="polite"></div>
        <div id="reveal"></div>
      </div>
    </div>
    <audio id="aud" preload="auto"></audio>
  </div>`;

  const aud = $('#aud'), disc = $('#disc');
  let data = null, answered = false, raf;
  const tick = () => { if (aud.duration) disc.style.setProperty('--p', Math.min(1, aud.currentTime / aud.duration)); raf = requestAnimationFrame(tick); };
  const tryPlay = () => aud.play().catch(err => {
    if (err.name === 'NotAllowedError') $('#hint').textContent = 'Браузер не дал включить звук автоматически — нажмите на пластинку ещё раз.';
  });

  disc.onclick = async () => {
    if (data) { aud.paused ? tryPlay() : aud.pause(); return; }
    if (Q.busy) return; Q.busy = true;
    disc.classList.add('loading'); $('#discIcon').innerHTML = '<span class="spinner"></span>';
    const res = await sb.rpc('start_question', { p_question: q.id });
    Q.busy = false; disc.classList.remove('loading');
    if (res.error) {
      $('#discIcon').innerHTML = PLAY_ICON; toast(errText(res.error));
      if (/question_not_found/.test(res.error.message)) route();
      return;
    }
    data = res.data; q.started = true;
    $('#opts').innerHTML = data.options.map((o, i) =>
      `<button class="opt" data-i="${i}"><span class="k">${LETTERS[i]}</span><span>${esc(o)}</span></button>`).join('');
    $$('.opt').forEach(b => (b.onclick = () => answer(+b.dataset.i)));
    $('#hint').textContent = 'Выберите вариант. Фрагмент можно переслушать.';
    aud.src = audioUrl(data.audio_path);
    tryPlay();
  };
  aud.onplay = () => { disc.classList.add('playing'); $('#discIcon').innerHTML = PAUSE_ICON; disc.setAttribute('aria-label', 'Пауза'); cancelAnimationFrame(raf); tick(); };
  aud.onpause = aud.onended = () => {
    disc.classList.remove('playing'); $('#discIcon').innerHTML = PLAY_ICON; disc.setAttribute('aria-label', 'Слушать ещё раз');
    cancelAnimationFrame(raf); if (aud.ended) disc.style.setProperty('--p', 1);
  };
  aud.onerror = () => { if (aud.src) $('#hint').innerHTML = '<span class="err">Фрагмент не загрузился.</span> Проверьте интернет и нажмите на пластинку ещё раз.'; };

  async function answer(i) {
    if (answered) return; answered = true;
    $$('.opt').forEach(b => (b.disabled = true));
    $$('.opt')[i].innerHTML += ' <span class="spinner" style="margin-left:auto"></span>';
    const { data: r, error } = await sb.rpc('submit_answer', { p_question: q.id, p_choice: i });
    $$('.opt .spinner').forEach(s => s.remove());
    if (error) {
      answered = false; $$('.opt').forEach(b => (b.disabled = false)); toast(errText(error));
      if (/question_not_found/.test(error.message)) route();
      return;
    }
    $$('.opt').forEach(b => {
      const j = +b.dataset.i;
      b.classList.add(j === r.correct_index ? 'right' : j === r.choice ? 'wrong' : 'locked');
    });
    q.answered = true; q.is_correct = r.is_correct;
    $('#hint').textContent = '';
    $('#fb').innerHTML = `<strong class="${r.is_correct ? 'ok' : 'no'}">${r.is_correct ? 'Верно!' : 'Мимо.'}</strong>
      <span class="muted">${r.is_correct ? 'Ответ за ' + fmtMs(r.response_ms) : 'Правильно: ' + esc(data.options[r.correct_index])}</span>
      <button class="btn" id="nextQ" style="margin-left:auto">${Q.list.some(x => !x.answered) ? 'Следующий фрагмент' : 'Посмотреть итог'}</button>`;
    $('#nextQ').onclick = () => { aud.pause(); route(); };
    const url = /^https?:\/\/\S+$/i.test(r.reveal_url || '') ? r.reveal_url : null;
    if (r.reveal_text || url) {
      $('#reveal').innerHTML = `<div class="reveal"><span class="reveal-label">Это было</span>
        ${r.reveal_text ? `<p class="reveal-title">${esc(r.reveal_text)}</p>` : ''}
        ${url ? `<a class="btn ghost sm" href="${esc(url)}" target="_blank" rel="noopener noreferrer">Слушать полностью ↗</a>` : ''}</div>`;
      const link = $('#reveal a'); if (link) link.onclick = () => aud.pause();
    }
    $('#nextQ').focus();
  }
}

async function renderFinished() {
  const ok = Q.list.filter(x => x.is_correct).length, total = Q.list.length;
  const { data } = await sb.rpc('leaderboard', { p_limit: 10 });
  const me = data?.rows?.find(r => r.is_me);
  $('#main').innerHTML = `
  <div class="card">
    <div class="stage">
      <div class="disc" aria-hidden="true" style="--p:${total ? ok / total : 0};cursor:default"><span class="ring"></span><span class="vinyl"></span>
        <span class="center" style="font:900 28px var(--display)">${pct(ok, total)}%</span></div>
      <div>
        <p class="prompt">Все фрагменты прослушаны</p>
        <p>Вы угадали ${ok} из ${total}.${me ? ` Сейчас вы на ${me.rank}-м месте.` : ''}</p>
        <p class="muted">Когда появятся новые фрагменты, они будут ждать вас здесь.</p>
        <button class="btn" id="toBoard">Открыть рейтинг</button>
      </div>
    </div>
  </div>`;
  $('#toBoard').onclick = () => { Q.view = 'board'; route(); };
}

/* ---------- рейтинг (доступен без входа) ---------- */
async function renderBoard() {
  const main = $('#main');
  main.innerHTML = '<div class="card"><p class="muted"><span class="spinner"></span> Загружаем рейтинг…</p></div>';
  const { data, error } = await sb.rpc('leaderboard', { p_limit: 100 });
  if (Q.view !== 'board') return;
  if (error) { main.innerHTML = `<div class="card"><p class="err">${esc(errText(error))}</p></div>`; return; }
  const rows = data.rows || [];
  main.innerHTML = `
  <div class="section-head"><div><h2>Рейтинг</h2>
    <p class="muted small" style="margin:0">Сначала по числу верных ответов, при равенстве — по среднему времени. Фрагментов в игре: ${data.total_questions}.</p></div>
    ${Q.session ? '' : '<button class="btn" id="joinBtn">Играть</button>'}</div>
  ${rows.length ? `<div class="table-wrap"><table>
    <thead><tr><th>Место</th><th>Игрок</th><th class="num">Верно</th><th class="num">Отвечено</th><th class="num">Точность</th><th class="num">Ср. время</th></tr></thead>
    <tbody>${rows.map(r => `<tr class="${r.is_me ? 'me-row' : ''}"><td class="place">${r.rank}</td>
      <td>${r.nickname ? esc(r.nickname) : '<span class="muted">Скрытый игрок</span>'}${r.is_me ? ' <span class="muted small">— вы</span>' : ''}</td>
      <td class="num">${r.correct}</td><td class="num">${r.answered}</td><td class="num">${pct(r.correct, r.answered)}%</td><td class="num">${fmtMs(r.avg_ms)}</td></tr>`).join('')}</tbody>
  </table></div>` : '<div class="notice">Пока никто не ответил ни на один фрагмент. Станьте первым!</div>'}`;
  const j = $('#joinBtn'); if (j) j.onclick = () => { Q.view = 'play'; route(); };
}

/* ---------- запуск ---------- */
if (!CONFIGURED) renderNotConfigured($('#main'));
else onAuth(async session => {
  Q.session = session; Q.profile = null; Q.isAdmin = false;
  if (session) {
    const [p, a] = await Promise.all([
      sb.from('profiles').select('*').eq('id', session.user.id).maybeSingle(),
      sb.rpc('is_admin')
    ]);
    Q.profile = p.data || null; Q.isAdmin = !!a.data;
    if (location.hash.includes('access_token')) history.replaceState(null, '', location.pathname);
  }
  renderWho(); route();
});

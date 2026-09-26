/* Страница игрока: вход, регистрация, туры, прохождение и повтор тура, рейтинг. */
const Q = {
  session: null, profile: null, isAdmin: false,
  view: 'play',        // 'play' | 'board'
  roundId: null,       // открытый тур; null — список туров
  boardRound: null,    // тур, выбранный в рейтинге; null — общий
  busy: false
};

document.title = (CFG.SITE_NAME || 'На слух') + ' — музыкальный квиз';
$('#siteName').textContent = CFG.SITE_NAME || 'На слух';

$$('#tabs button').forEach(b => (b.onclick = () => {
  stopAudio(); Q.view = b.dataset.v; if (Q.view === 'play') Q.roundId = null; route();
}));

function stopAudio() { $$('audio').forEach(a => a.pause()); }
function setTabs() { $$('#tabs button').forEach(b => (b.dataset.v === Q.view ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current'))); }
const openRound = id => { stopAudio(); Q.view = 'play'; Q.roundId = id; route(); };
const toRounds = () => { stopAudio(); Q.view = 'play'; Q.roundId = null; route(); };
const loading = text => ($('#main').innerHTML = `<div class="card"><p class="muted"><span class="spinner"></span> ${esc(text)}</p></div>`);

/* Сводка по попыткам тура: текущая, первая (идёт в рейтинг), лучшая. */
function roundSummary(r) {
  const at = r.attempts || [];
  const cur = at.find(a => a.attempt === r.attempt) || { attempt: r.attempt, answered: 0, correct: 0 };
  const first = at.find(a => a.attempt === 1) || null;
  const done = at.filter(a => a.answered >= r.total);
  const best = done.length ? Math.max(...done.map(a => a.correct)) : null;
  return {
    cur, first, best,
    complete: cur.answered >= r.total,
    firstComplete: !!first && first.answered >= r.total,
    notStarted: r.attempt === 1 && cur.answered === 0
  };
}

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
  if (Q.roundId) return renderRound(Q.roundId);
  return renderRoundList();
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

/* ---------- список туров ---------- */
async function renderRoundList() {
  loading('Загружаем туры…');
  const { data, error } = await sb.rpc('quiz_rounds');
  if (Q.view !== 'play' || Q.roundId) return;
  const main = $('#main');
  if (error) { main.innerHTML = `<div class="card"><p class="err">${esc(errText(error))}</p></div>`; return; }
  const rounds = data || [];
  if (!rounds.length) {
    main.innerHTML = `<div class="card"><h2>Туров пока нет</h2><p class="muted">${Q.isAdmin ? 'Создайте тур и добавьте фрагменты в <a href="admin.html">админ-панели</a>.' : 'Организатор ещё не выложил музыку. Загляните позже.'}</p></div>`;
    return;
  }
  const sums = rounds.map(roundSummary);
  const doneCount = sums.filter(s => s.firstComplete).length;
  main.innerHTML = `
  <div class="section-head"><div><h2>Туры</h2>
    <p class="muted small" style="margin:0">Пройдено ${doneCount} из ${rounds.length}. В рейтинг идёт первая попытка каждого тура, повторные — для тренировки.</p></div></div>
  <div class="rounds">${rounds.map((r, i) => {
    const s = sums[i];
    let status, actions;
    if (s.notStarted) {
      status = `<span class="muted">Не начат</span>`;
      actions = `<button class="btn sm" data-open="${r.id}">Начать</button>`;
    } else if (!s.complete) {
      status = `Попытка ${r.attempt}: отвечено ${s.cur.answered} из ${r.total}`;
      actions = `<button class="btn sm" data-open="${r.id}">Продолжить</button>`;
    } else {
      status = `Результат: <b>${s.cur.correct} из ${r.total}</b>`;
      actions = `<button class="btn ghost sm" data-open="${r.id}">Итог</button><button class="btn sm" data-restart="${r.id}">Пройти заново</button>`;
    }
    const extra = r.attempt > 1 && s.first
      ? `<p class="small muted" style="margin:0">В рейтинге: ${s.first.correct} из ${r.total}${s.best != null ? ` · лучший: ${s.best}` : ''} · попыток: ${r.attempt}</p>` : '';
    const pctDone = s.notStarted ? 0 : (s.complete ? s.cur.correct / r.total : s.cur.answered / r.total);
    return `<div class="round-card ${s.complete ? 'done' : ''}">
      <div class="round-disc" style="--p:${pctDone}" aria-hidden="true"><span>${i + 1}</span></div>
      <div class="round-body">
        <h3 style="margin:0">${esc(r.title)}</h3>
        <p class="small muted" style="margin:0">${r.total} ${plural(r.total, 'фрагмент', 'фрагмента', 'фрагментов')}</p>
        <p class="small" style="margin:4px 0 0">${status}</p>${extra}
      </div>
      <div class="round-acts">${actions}</div>
    </div>`;
  }).join('')}</div>`;
  $$('[data-open]').forEach(b => (b.onclick = () => openRound(b.dataset.open)));
  $$('[data-restart]').forEach(b => (b.onclick = () => restartRound(b.dataset.restart, b)));
}

async function restartRound(id, btn) {
  if (btn) btn.disabled = true;
  const { error } = await sb.rpc('restart_round', { p_round: id });
  if (error) { if (btn) btn.disabled = false; toast(errText(error)); return; }
  toast('Новая попытка — удачи!');
  openRound(id);
}

/* ---------- тур ---------- */
async function renderRound(id) {
  loading('Загружаем тур…');
  const { data: st, error } = await sb.rpc('round_state', { p_round: id });
  if (Q.view !== 'play' || Q.roundId !== id) return;
  if (error) {
    toast(errText(error));
    if (/round_not_found/.test(error.message)) toRounds();
    else $('#main').innerHTML = `<div class="card"><p class="err">${esc(errText(error))}</p></div>`;
    return;
  }
  st.total = st.questions.length;
  const next = st.questions.find(q => !q.answered);
  if (!st.total) { toast('В этом туре пока нет фрагментов'); return toRounds(); }
  if (!next) return renderRoundResult(st);
  renderQuestion(next, st);
}

function renderQuestion(q, st) {
  const done = st.questions.filter(x => x.answered).length;
  const ok = st.questions.filter(x => x.is_correct).length;
  $('#main').innerHTML = `
  <div class="card">
    <p class="small" style="margin:0 0 12px"><button class="linkbtn" id="back">← Все туры</button></p>
    <div class="progress-line">
      <span class="qnum">${esc(st.title)} · фрагмент ${done + 1} из ${st.total}${st.attempt > 1 ? ` · попытка ${st.attempt}` : ''}</span>
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
  $('#back').onclick = toRounds;

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
    $('#hint').textContent = '';
    $('#fb').innerHTML = `<strong class="${r.is_correct ? 'ok' : 'no'}">${r.is_correct ? 'Верно!' : 'Мимо.'}</strong>
      <span class="muted">${r.is_correct ? 'Ответ за ' + fmtMs(r.response_ms) : 'Правильно: ' + esc(data.options[r.correct_index])}</span>
      <button class="btn" id="nextQ" style="margin-left:auto">${r.round_complete ? 'Итог тура' : 'Следующий фрагмент'}</button>`;
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

/* ---------- итог тура ---------- */
async function renderRoundResult(st) {
  const s = roundSummary({ ...st, total: st.total });
  const ok = s.cur.correct, total = st.total;
  const [lb, list] = await Promise.all([
    sb.rpc('leaderboard', { p_limit: 10, p_round: st.id }),
    sb.rpc('quiz_rounds')
  ]);
  if (Q.view !== 'play' || Q.roundId !== st.id) return;
  const me = lb.data?.rows?.find(r => r.is_me);
  const rounds = list.data || [];
  const idx = rounds.findIndex(r => r.id === st.id);
  const nextRound = rounds.slice(idx + 1).concat(rounds.slice(0, Math.max(idx, 0)))
    .find(r => !roundSummary(r).complete);
  $('#main').innerHTML = `
  <div class="card">
    <p class="small" style="margin:0 0 12px"><button class="linkbtn" id="back">← Все туры</button></p>
    <div class="stage">
      <div class="disc" aria-hidden="true" style="--p:${total ? ok / total : 0};cursor:default"><span class="ring"></span><span class="vinyl"></span>
        <span class="center" style="font:900 28px var(--display)">${pct(ok, total)}%</span></div>
      <div>
        <p class="qnum" style="margin:0 0 8px">${esc(st.title)}${st.attempt > 1 ? ` · попытка ${st.attempt}` : ''}</p>
        <p class="prompt">Тур пройден: ${ok} из ${total}</p>
        ${st.attempt > 1 && s.first
          ? `<p>В рейтинге учитывается первая попытка: <b>${s.first.correct} из ${total}</b>${s.best != null ? `. Лучший результат: ${s.best} из ${total}` : ''}.</p>`
          : `<p>${me ? `В рейтинге этого тура вы на ${me.rank}-м месте.` : ''} Пройти тур заново можно в любой момент — в рейтинг пойдёт этот, первый результат.</p>`}
        <div class="row" style="margin-top:16px">
          <button class="btn" id="again">Пройти заново</button>
          ${nextRound ? `<button class="btn ghost" id="nextRound">Следующий: ${esc(nextRound.title)}</button>` : ''}
          <button class="btn ghost" id="toBoard">Рейтинг тура</button>
        </div>
      </div>
    </div>
  </div>`;
  $('#back').onclick = toRounds;
  $('#again').onclick = () => restartRound(st.id, $('#again'));
  if (nextRound) $('#nextRound').onclick = () => openRound(nextRound.id);
  $('#toBoard').onclick = () => { Q.view = 'board'; Q.boardRound = st.id; route(); };
}

/* ---------- рейтинг (доступен без входа) ---------- */
async function renderBoard() {
  loading('Загружаем рейтинг…');
  const { data, error } = await sb.rpc('leaderboard', { p_limit: 100, p_round: Q.boardRound });
  if (Q.view !== 'board') return;
  const main = $('#main');
  if (error) { main.innerHTML = `<div class="card"><p class="err">${esc(errText(error))}</p></div>`; return; }
  const rows = data.rows || [], rounds = data.rounds || [];
  if (Q.boardRound && !rounds.some(r => r.id === Q.boardRound)) { Q.boardRound = null; return renderBoard(); }
  main.innerHTML = `
  <div class="section-head"><div><h2>Рейтинг</h2>
    <p class="muted small" style="margin:0">По первой попытке каждого тура: сначала число верных ответов, при равенстве — среднее время. Фрагментов: ${data.total_questions}.</p></div>
    ${Q.session ? '' : '<button class="btn" id="joinBtn">Играть</button>'}</div>
  ${rounds.length > 1 ? `<div class="chips" role="tablist" aria-label="Тур">
    <button class="chip" data-round="" ${Q.boardRound ? '' : 'aria-pressed="true"'}>Общий</button>
    ${rounds.map(r => `<button class="chip" data-round="${r.id}" ${Q.boardRound === r.id ? 'aria-pressed="true"' : ''}>${esc(r.title)}</button>`).join('')}
  </div>` : ''}
  ${rows.length ? `<div class="table-wrap"><table>
    <thead><tr><th>Место</th><th>Игрок</th><th class="num">Верно</th><th class="num">Отвечено</th><th class="num">Точность</th><th class="num">Ср. время</th></tr></thead>
    <tbody>${rows.map(r => `<tr class="${r.is_me ? 'me-row' : ''}"><td class="place">${r.rank}</td>
      <td>${r.nickname ? esc(r.nickname) : '<span class="muted">Скрытый игрок</span>'}${r.is_me ? ' <span class="muted small">— вы</span>' : ''}</td>
      <td class="num">${r.correct}</td><td class="num">${r.answered}</td><td class="num">${pct(r.correct, r.answered)}%</td><td class="num">${fmtMs(r.avg_ms)}</td></tr>`).join('')}</tbody>
  </table></div>` : '<div class="notice">Пока никто не ответил ни на один фрагмент. Станьте первым!</div>'}`;
  $$('[data-round]').forEach(b => (b.onclick = () => { Q.boardRound = b.dataset.round || null; renderBoard(); }));
  const j = $('#joinBtn'); if (j) j.onclick = () => { Q.view = 'play'; Q.roundId = null; route(); };
}

/* ---------- запуск ---------- */
if (!CONFIGURED) renderNotConfigured($('#main'));
else onAuth(async session => {
  Q.session = session; Q.profile = null; Q.isAdmin = false; Q.roundId = null;
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

/* Админ-панель: вопросы (загрузка и нарезка аудио, варианты, порядок) и статистика. */
const A = { session: null, view: 'questions', questions: [], stats: null, editing: false };
$('#siteName').textContent = (CFG.SITE_NAME || 'На слух') + ' · админ';

$$('#tabs button').forEach(b => (b.onclick = () => {
  if (A.editing && !confirm('Закрыть редактор без сохранения?')) return;
  A.editing = false; A.view = b.dataset.v; stopAudio(); route();
}));
function stopAudio() { $$('audio').forEach(a => a.pause()); }
function setTabs() { $$('#tabs button').forEach(b => (b.dataset.v === A.view ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current'))); }
const tz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } };

async function route() {
  setTabs();
  if (A.view === 'questions') { await loadQuestions(); renderQuestions(); }
  else renderStats();
}

/* ---------- данные ---------- */
async function loadQuestions() {
  const [q, s] = await Promise.all([
    sb.from('questions').select('*, question_keys(correct_index, reveal_text, reveal_url)').order('position').order('created_at'),
    sb.rpc('admin_stats', { p_tz: tz(), p_days: 14 })
  ]);
  if (q.error) { toast(errText(q.error)); A.questions = []; return; }
  const st = Object.fromEntries((s.data?.questions || []).map(x => [x.id, x]));
  A.stats = s.data || null;
  A.questions = q.data.map(x => {
    const k = Array.isArray(x.question_keys) ? x.question_keys[0] : x.question_keys;
    return { ...x, correct: k?.correct_index ?? null, reveal_text: k?.reveal_text || '', reveal_url: k?.reveal_url || '', answered: st[x.id]?.answered || 0, ok: st[x.id]?.correct || 0 };
  });
}

/* ---------- список вопросов ---------- */
function renderQuestions() {
  const qs = A.questions, active = qs.filter(q => q.is_active).length;
  $('#main').innerHTML = `
  <div class="section-head">
    <div><h2>Вопросы</h2><p class="muted small" style="margin:0">${qs.length} ${plural(qs.length, 'фрагмент', 'фрагмента', 'фрагментов')}, в игре: ${active}. Порядок в списке — порядок в квизе.</p></div>
    <div class="row"><a class="btn ghost" href="index.html">Открыть квиз</a><button class="btn" id="addQ">Добавить фрагмент</button></div>
  </div>
  ${qs.length ? `<div class="table-wrap">${qs.map((q, i) => `
    <div class="qrow ${q.is_active ? '' : 'off'}" data-id="${q.id}">
      <div class="ord"><button data-mv="-1" aria-label="Выше" ${i === 0 ? 'disabled' : ''}>▲</button><button data-mv="1" aria-label="Ниже" ${i === qs.length - 1 ? 'disabled' : ''}>▼</button></div>
      <div>
        <div class="row" style="gap:10px"><button class="mini-play" data-play="${esc(q.audio_path)}" aria-label="Прослушать">${PLAY_ICON}</button>
          <span class="title">${i + 1}. ${esc(q.prompt)}</span></div>
        <div class="meta">Ответ: <b style="color:var(--ok)">${esc(q.options[q.correct] ?? 'не отмечен')}</b>
          · вариантов: ${q.options.length}${q.fragment_seconds ? ` · ${Math.round(q.fragment_seconds)} с` : ''}
          · ответили: ${q.answered}, верно ${pct(q.ok, q.answered)}%${q.reveal_url ? ' · есть ссылка' : ''}${q.is_active ? '' : ' · <b>скрыт</b>'}</div>
      </div>
      <div class="acts">
        <button class="btn ghost sm" data-act="edit">Изменить</button>
        <button class="btn ghost sm" data-act="toggle">${q.is_active ? 'Скрыть' : 'Показать'}</button>
        <button class="btn danger sm" data-act="del">Удалить</button>
      </div>
    </div>`).join('')}</div>`
  : '<div class="notice">Здесь пока пусто. Нажмите «Добавить фрагмент», выберите аудиофайл, отметьте отрывок и впишите варианты ответа.</div>'}
  <audio id="adminAud" hidden></audio>`;

  $('#addQ').onclick = () => openEditor(null);
  const aud = $('#adminAud');
  $$('[data-play]').forEach(b => (b.onclick = () => {
    const src = audioUrl(b.dataset.play);
    if (aud.dataset.src === src && !aud.paused) { aud.pause(); return; }
    $$('[data-play]').forEach(x => (x.innerHTML = PLAY_ICON));
    aud.src = src; aud.dataset.src = src; aud.play().catch(() => toast('Не удалось воспроизвести'));
    b.innerHTML = PAUSE_ICON; aud.onended = aud.onpause = () => (b.innerHTML = PLAY_ICON);
  }));
  $$('.qrow').forEach(row => {
    const q = A.questions.find(x => x.id === row.dataset.id);
    row.querySelectorAll('[data-mv]').forEach(b => (b.onclick = () => moveQ(q, +b.dataset.mv)));
    row.querySelector('[data-act=edit]').onclick = () => openEditor(q);
    row.querySelector('[data-act=toggle]').onclick = async () => {
      const { error } = await sb.from('questions').update({ is_active: !q.is_active, updated_at: new Date().toISOString() }).eq('id', q.id);
      if (error) toast(errText(error)); else { toast(q.is_active ? 'Фрагмент скрыт' : 'Фрагмент снова в игре'); route(); }
    };
    row.querySelector('[data-act=del]').onclick = () => deleteQ(q);
  });
}

async function moveQ(q, dir) {
  const ids = A.questions.map(x => x.id), i = ids.indexOf(q.id), j = i + dir;
  if (j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  const { error } = await sb.rpc('admin_reorder', { p_ids: ids });
  if (error) toast(errText(error)); else route();
}

async function deleteQ(q) {
  if (!confirm(`Удалить фрагмент «${q.prompt}»?${q.answered ? `\n\nНа него уже ответили ${q.answered} чел. — их ответы на этот фрагмент тоже удалятся и пропадут из рейтинга.\nЕсли нужно лишь убрать его из игры, нажмите «Скрыть».` : ''}`)) return;
  const { error } = await sb.from('questions').delete().eq('id', q.id);
  if (error) { toast(errText(error)); return; }
  await sb.storage.from('fragments').remove([q.audio_path]);
  toast('Фрагмент удалён'); route();
}

/* ---------- редактор ---------- */
function openEditor(q) {
  stopAudio(); A.editing = true;
  const isNew = !q;
  const ed = { options: q ? [...q.options] : ['', '', '', ''], correct: q?.correct ?? 0 };
  $('#main').innerHTML = `
  <div class="card editor" style="max-width:720px">
    <h2>${isNew ? 'Новый фрагмент' : 'Изменить фрагмент'}</h2>
    <div class="stack">
      ${!isNew && q.answered ? `<div class="warn">На этот фрагмент уже ответили ${q.answered} чел. Их ответы хранятся как номер варианта: если поменять варианты местами или заменить музыку, старые ответы в статистике будут относиться к новому содержанию.</div>` : ''}
      <div><label class="f" for="ePrompt">Вопрос</label>
        <input id="ePrompt" type="text" maxlength="200" placeholder="Например: Кто исполняет эту песню?" value="${esc(q?.prompt || '')}">
        <p class="small muted" style="margin:6px 0 0">Если оставить пустым, игроки увидят «Что звучит?»</p></div>
      <div class="audio-box">
        <h3>Аудио</h3>
        ${isNew ? '' : `<p class="small muted">Текущий фрагмент:</p><audio controls preload="none" src="${esc(audioUrl(q.audio_path))}"></audio><p class="small muted">Чтобы заменить его, выберите новый файл.</p>`}
        <input type="file" id="eFile" accept="audio/*,.mp3,.wav,.m4a,.ogg,.flac,.aac">
        <div id="cutter" hidden>
          <audio id="srcAud" controls preload="metadata"></audio>
          <div class="row" style="align-items:flex-end">
            <div style="flex:3;min-width:200px"><label class="f" for="eStart">Начало отрывка: <span id="startLbl">0:00</span></label><input type="range" id="eStart" min="0" step="0.1" value="0"></div>
            <div style="flex:1;min-width:120px"><label class="f" for="eDur">Длина, сек</label><input type="number" id="eDur" min="3" max="60" value="15"></div>
          </div>
          <div class="row" style="margin-top:10px"><button class="btn ghost sm" id="preview">Прослушать отрывок</button><span class="small muted" id="cutInfo"></span></div>
          <p class="small muted" style="margin:8px 0 0">На сервер уходит только выбранный отрывок в MP3, целиком файл не загружается.</p>
        </div>
      </div>
      <div>
        <label class="f">Варианты ответа — отметьте правильный</label>
        <div id="eOpts"></div>
        <button class="btn ghost sm" id="addOpt">Добавить вариант</button>
      </div>
      <div class="audio-box">
        <h3>После ответа</h3>
        <p class="small muted" style="margin-top:-4px">Игрок увидит это сразу после ответа — верного или нет. До ответа эти данные не отдаются.</p>
        <div class="stack">
          <div><label class="f" for="eRevealText">Что это было</label>
            <input id="eRevealText" type="text" maxlength="300" placeholder="Например: Queen — Bohemian Rhapsody (1975)" value="${esc(q?.reveal_text || '')}"></div>
          <div><label class="f" for="eRevealUrl">Ссылка на произведение</label>
            <input id="eRevealUrl" type="url" maxlength="500" placeholder="https://…" value="${esc(q?.reveal_url || '')}">
            <p class="small muted" style="margin:6px 0 0">Найти: <button class="linkbtn" data-find="yt">YouTube</button> ·
              <button class="linkbtn" data-find="ym">Яндекс Музыка</button> ·
              <button class="linkbtn" data-find="sp">Spotify</button> — откроется поиск, скопируйте ссылку на трек сюда.</p></div>
        </div>
      </div>
      <label class="row small"><input type="checkbox" id="eActive" ${q && !q.is_active ? '' : 'checked'}> Показывать в квизе</label>
      <div class="row"><button class="btn" id="save">${isNew ? 'Сохранить фрагмент' : 'Сохранить изменения'}</button>
        <button class="btn ghost" id="cancel">Отмена</button><span id="saveMsg" class="small"></span></div>
    </div>
  </div>`;

  const syncOpts = () => $$('[data-o]').forEach(inp => (ed.options[+inp.dataset.o] = inp.value));
  const drawOpts = () => {
    $('#eOpts').innerHTML = ed.options.map((o, i) => `
      <div class="opt-edit"><input type="radio" name="corr" value="${i}" ${ed.correct === i ? 'checked' : ''} aria-label="Правильный — вариант ${LETTERS[i]}">
      <input type="text" data-o="${i}" maxlength="120" placeholder="Вариант ${LETTERS[i]}" value="${esc(o)}">
      <button class="btn ghost sm" data-rm="${i}" ${ed.options.length <= 2 ? 'disabled' : ''} aria-label="Убрать вариант ${LETTERS[i]}">✕</button></div>`).join('');
    $$('[name=corr]').forEach(r => (r.onchange = () => (ed.correct = +r.value)));
    $$('[data-rm]').forEach(b => (b.onclick = () => {
      syncOpts(); const i = +b.dataset.rm; ed.options.splice(i, 1);
      if (ed.correct === i) ed.correct = 0; else if (ed.correct > i) ed.correct--;
      drawOpts();
    }));
    $('#addOpt').disabled = ed.options.length >= 6;
  };
  drawOpts();
  $('#addOpt').onclick = () => { syncOpts(); if (ed.options.length < 6) { ed.options.push(''); drawOpts(); } };
  $('#cancel').onclick = () => { stopAudio(); A.editing = false; route(); };
  const SEARCH = {
    yt: t => 'https://www.youtube.com/results?search_query=' + encodeURIComponent(t),
    ym: t => 'https://music.yandex.ru/search?text=' + encodeURIComponent(t),
    sp: t => 'https://open.spotify.com/search/' + encodeURIComponent(t)
  };
  $$('[data-find]').forEach(b => (b.onclick = () => {
    syncOpts();
    const t = $('#eRevealText').value.trim() || (ed.options[ed.correct] || '').trim();
    if (!t) { toast('Сначала заполните «Что это было» или правильный вариант'); return; }
    window.open(SEARCH[b.dataset.find](t), '_blank', 'noopener');
  }));

  let file = null, url = null, stopT;
  $('#eFile').onchange = e => {
    file = e.target.files[0]; if (!file) return;
    if (url) URL.revokeObjectURL(url); url = URL.createObjectURL(file);
    const a = $('#srcAud'); a.src = url; $('#cutter').hidden = false; $('#cutInfo').textContent = '';
    a.onloadedmetadata = () => {
      const r = $('#eStart'); r.max = Math.max(0, a.duration - 3).toFixed(1);
      r.value = Math.min(30, +r.max).toFixed(1); r.oninput();
      $('#cutInfo').textContent = 'Длительность файла: ' + mmss(a.duration);
    };
    a.onerror = () => { $('#cutInfo').innerHTML = '<span class="err">Браузер не может прочитать этот файл. Попробуйте MP3, WAV, M4A или OGG.</span>'; };
  };
  $('#eStart').oninput = () => ($('#startLbl').textContent = mmss(+$('#eStart').value));
  $('#preview').onclick = () => {
    const a = $('#srcAud'); a.currentTime = +$('#eStart').value; a.play();
    clearTimeout(stopT); stopT = setTimeout(() => a.pause(), (+$('#eDur').value || 15) * 1000);
  };

  $('#save').onclick = async () => {
    syncOpts();
    const msg = $('#saveMsg'); const fail = t => { msg.className = 'small err'; msg.textContent = t; };
    msg.className = 'small';
    const opts = ed.options.map(s => s.trim());
    if (opts.length < 2 || opts.some(s => !s)) return fail('Заполните все варианты (минимум два) или удалите лишние.');
    if (new Set(opts.map(s => s.toLowerCase())).size !== opts.length) return fail('Варианты не должны повторяться.');
    if (isNew && !file) return fail('Выберите аудиофайл.');
    const revealText = $('#eRevealText').value.trim();
    const revealUrl = $('#eRevealUrl').value.trim();
    if (revealUrl && !/^https?:\/\/\S+$/i.test(revealUrl)) return fail('Ссылка должна начинаться с http:// или https://');

    $('#save').disabled = $('#cancel').disabled = true;
    let uploaded = null, frag = null;
    try {
      if (file) {
        $('#srcAud').pause();
        const dur = Math.max(3, Math.min(60, +$('#eDur').value || 15));
        frag = await cutToMp3(file, +$('#eStart').value, dur, p => (msg.textContent = `Готовим отрывок… ${Math.round(p * 100)}%`));
        msg.textContent = 'Загружаем аудио…';
        const path = `${crypto.randomUUID()}.mp3`;
        const up = await sb.storage.from('fragments').upload(path, frag.blob, { contentType: 'audio/mpeg', cacheControl: '31536000', upsert: false });
        if (up.error) throw up.error;
        uploaded = path;
      }
      msg.textContent = 'Сохраняем…';
      const { error } = await sb.rpc('admin_save_question', {
        p_id: q?.id || null,
        p_prompt: $('#ePrompt').value.trim(),
        p_options: opts,
        p_correct: ed.correct,
        p_audio_path: uploaded,
        p_fragment_seconds: frag ? Math.round(frag.dur * 100) / 100 : null,
        p_source_name: file ? file.name.slice(0, 200) : null,
        p_is_active: $('#eActive').checked,
        p_reveal_text: revealText || null,
        p_reveal_url: revealUrl || null
      });
      if (error) throw error;
      if (uploaded && q?.audio_path) await sb.storage.from('fragments').remove([q.audio_path]);
      if (url) URL.revokeObjectURL(url);
      A.editing = false; toast(isNew ? 'Фрагмент сохранён' : 'Изменения сохранены'); route();
    } catch (e) {
      if (uploaded) await sb.storage.from('fragments').remove([uploaded]);
      $('#save').disabled = $('#cancel').disabled = false;
      fail(/exceeded the maximum|too large|Payload/i.test(e.message || '') ? 'Отрывок слишком большой — сократите длину.' : 'Не удалось сохранить: ' + errText(e));
    }
  };
}

/* Вырезает отрывок из любого аудио, которое умеет браузер, и кодирует его в MP3 128 кбит/с
   с плавным началом и концом. Работает быстрее реального времени. */
async function cutToMp3(file, start, dur, onProgress) {
  const AC = window.AudioContext || window.webkitAudioContext;
  const ac = new AC();
  let buf;
  try { buf = await ac.decodeAudioData(await file.arrayBuffer()); }
  catch { throw new Error('не удалось прочитать аудиофайл — попробуйте MP3 или WAV'); }
  finally { ac.close && ac.close(); }

  start = Math.max(0, Math.min(start, buf.duration - 1));
  dur = Math.min(dur, buf.duration - start);
  const sr = 44100, ch = Math.min(2, buf.numberOfChannels);
  const off = new OfflineAudioContext(ch, Math.ceil(dur * sr), sr);
  const src = off.createBufferSource(); src.buffer = buf;
  const g = off.createGain(); const fade = Math.min(0.4, dur / 6);
  g.gain.setValueAtTime(0, 0); g.gain.linearRampToValueAtTime(1, fade);
  g.gain.setValueAtTime(1, dur - fade); g.gain.linearRampToValueAtTime(0, dur);
  src.connect(g).connect(off.destination); src.start(0, start, dur);
  const out = await off.startRendering();

  const toI16 = f32 => { const r = new Int16Array(f32.length); for (let i = 0; i < f32.length; i++) { const s = Math.max(-1, Math.min(1, f32[i])); r[i] = s < 0 ? s * 0x8000 : s * 0x7fff; } return r; };
  const L = toI16(out.getChannelData(0)), R = ch > 1 ? toI16(out.getChannelData(1)) : null;
  const enc = new lamejs.Mp3Encoder(ch, sr, 128), parts = [], block = 1152;
  for (let i = 0; i < L.length; i += block) {
    const b = R ? enc.encodeBuffer(L.subarray(i, i + block), R.subarray(i, i + block)) : enc.encodeBuffer(L.subarray(i, i + block));
    if (b.length) parts.push(new Uint8Array(b));
    if ((i / block) % 200 === 0) { onProgress(i / L.length); await new Promise(r => setTimeout(r)); }
  }
  const tail = enc.flush(); if (tail.length) parts.push(new Uint8Array(tail));
  onProgress(1);
  return { blob: new Blob(parts, { type: 'audio/mpeg' }), dur };
}

/* ---------- статистика ---------- */
async function renderStats() {
  const main = $('#main');
  main.innerHTML = '<div class="card"><p class="muted"><span class="spinner"></span> Считаем статистику…</p></div>';
  const { data: s, error } = await sb.rpc('admin_stats', { p_tz: tz(), p_days: 14 });
  if (A.view !== 'stats') return;
  if (error) { main.innerHTML = `<div class="card"><p class="err">${esc(errText(error))}</p></div>`; return; }
  const maxDay = Math.max(1, ...s.daily.map(d => d.count));
  main.innerHTML = `
  <div class="section-head"><h2>Статистика</h2>
    <div class="row"><button class="btn ghost" id="refresh">Обновить</button><button class="btn ghost" id="csv">Скачать CSV</button></div></div>
  <div class="stack">
    <div class="kpis">
      <div class="kpi"><b>${s.players}</b><span>${plural(s.players, 'зарегистрирован', 'зарегистрировано', 'зарегистрировано')}</span></div>
      <div class="kpi"><b>${s.active_players}</b><span>ответили хотя бы раз</span></div>
      <div class="kpi"><b>${s.answers}</b><span>${plural(s.answers, 'ответ', 'ответа', 'ответов')} всего</span></div>
      <div class="kpi"><b>${pct(s.correct, s.answers)}%</b><span>верных ответов</span></div>
      <div class="kpi"><b>${s.questions_active}</b><span>фрагментов в игре</span></div>
    </div>
    <div class="card"><h3>Ответы за 14 дней</h3>
      <div class="days">${s.daily.map(d => `<div title="${d.day}: ${d.count}"><span>${d.count || ''}</span><i style="height:${Math.round((d.count / maxDay) * 90)}%"></i><span>${d.day.slice(8)}.${d.day.slice(5, 7)}</span></div>`).join('')}</div>
    </div>
    <div><h3>По фрагментам</h3>
    ${s.questions.length ? `<div class="table-wrap"><table>
      <thead><tr><th>#</th><th>Вопрос</th><th class="num">Ответили</th><th>Точность</th><th class="num">Ср. время</th><th>Распределение ответов</th></tr></thead>
      <tbody>${s.questions.map((q, i) => `<tr><td>${i + 1}</td><td>${esc(q.prompt)}${q.is_active ? '' : ' <span class="muted small">(скрыт)</span>'}</td>
        <td class="num">${q.answered}</td>
        <td><div class="row" style="flex-wrap:nowrap"><div class="bar okc" style="flex:1"><span style="width:${pct(q.correct, q.answered)}%"></span></div><span class="small">${pct(q.correct, q.answered)}%</span></div></td>
        <td class="num">${fmtMs(q.avg_ms)}</td>
        <td><div class="dist">${q.options.map((o, j) => `<div class="${j === q.correct_index ? 'c' : ''}"><span>${esc(o)}</span><div class="bar ${j === q.correct_index ? 'okc' : ''}"><span style="width:${pct(q.dist[j], q.answered)}%"></span></div><span>${q.dist[j]}</span></div>`).join('')}</div></td></tr>`).join('')}</tbody>
    </table></div>` : '<div class="notice">Фрагментов пока нет.</div>'}</div>
    <div><h3>По игрокам</h3>
    ${s.player_list.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Игрок</th><th>Почта</th><th class="num">Отвечено</th><th class="num">Верно</th><th class="num">Точность</th><th class="num">Ср. время</th><th>Регистрация</th><th>Последний ответ</th><th></th></tr></thead>
      <tbody>${s.player_list.map(p => `<tr><td>${esc(p.nickname)}${p.show_in_rating ? '' : ' <span class="muted small">(скрыт)</span>'}</td>
        <td class="small">${esc(p.email)}</td><td class="num">${p.answered}</td><td class="num">${p.correct}</td><td class="num">${pct(p.correct, p.answered)}%</td>
        <td class="num">${fmtMs(p.avg_ms)}</td><td class="small">${fmtDate(p.registered_at)}</td><td class="small">${fmtDate(p.last_at)}</td>
        <td>${p.answered ? `<button class="btn ghost sm" data-reset="${p.id}" data-name="${esc(p.nickname)}">Сбросить ответы</button>` : ''}</td></tr>`).join('')}</tbody>
    </table></div>` : '<div class="notice">Пока никто не зарегистрировался. Поделитесь ссылкой на квиз.</div>'}</div>
  </div>`;
  $('#refresh').onclick = renderStats;
  $$('[data-reset]').forEach(b => (b.onclick = async () => {
    if (!confirm(`Сбросить все ответы игрока «${b.dataset.name}»? Он сможет пройти квиз заново.`)) return;
    const { error } = await sb.rpc('admin_reset_player', { p_user: b.dataset.reset });
    if (error) toast(errText(error)); else { toast('Ответы сброшены'); renderStats(); }
  }));
  $('#csv').onclick = exportCsv;
}
function fmtDate(iso) { if (!iso) return '—'; const d = new Date(iso); return d.toLocaleDateString('ru-RU') + ' ' + d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }); }

async function exportCsv() {
  const { data, error } = await sb.rpc('admin_export');
  if (error) { toast(errText(error)); return; }
  const lines = [['Игрок', 'Почта', 'Вопрос', 'Выбранный ответ', 'Правильный ответ', 'Верно', 'Время, с', 'Когда']];
  for (const r of data) lines.push([r.nickname, r.email, r.question, r.choice, r.correct, r.is_correct ? 'да' : 'нет', (r.response_ms / 1000).toFixed(1).replace('.', ','), fmtDate(r.answered_at)]);
  const csv = '\ufeff' + lines.map(l => l.map(v => '"' + String(v ?? '').replace(/"/g, '""') + '"').join(';')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `na-slukh-otvety-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ---------- запуск ---------- */
if (!CONFIGURED) renderNotConfigured($('#main'));
else onAuth(async session => {
  A.session = session;
  const who = $('#who'), tabs = $('#tabs');
  if (!session) {
    tabs.hidden = true; who.innerHTML = '';
    renderLogin($('#main'), { title: 'Вход для организаторов', text: 'Введите почту администратора — пришлём ссылку и код для входа.' });
    return;
  }
  who.innerHTML = `<span>${esc(session.user.email)}</span><button class="linkbtn" id="logout">Выйти</button>`;
  $('#logout').onclick = () => sb.auth.signOut();
  if (location.hash.includes('access_token')) history.replaceState(null, '', location.pathname);
  const { data: isAdmin } = await sb.rpc('is_admin');
  if (!isAdmin) {
    tabs.hidden = true;
    $('#main').innerHTML = `<div class="card narrow"><h2>Нет прав администратора</h2>
      <p class="muted">Учётная запись ${esc(session.user.email)} не входит в число организаторов. Если это ваша почта, добавьте её в администраторы через SQL-редактор Supabase:</p>
      <pre style="overflow-x:auto;background:var(--surface-2);padding:12px;border-radius:12px;font-size:13px">insert into public.admins (user_id)
select id from auth.users where email = '${esc(session.user.email)}'
on conflict do nothing;</pre>
      <p class="muted small">Затем обновите эту страницу.</p></div>`;
    return;
  }
  tabs.hidden = false; route();
});

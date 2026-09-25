-- =====================================================================
-- «На слух» — музыкальный квиз. Схема базы данных для Supabase.
-- Выполните целиком в Supabase → SQL Editor (см. README, шаг 5).
-- Скрипт можно запускать повторно: он не удаляет данные.
--
-- Главное про безопасность:
--   * правильные ответы лежат в отдельной таблице question_keys, которую
--     игроки не видят; ответ проверяется на сервере (submit_answer);
--   * варианты ответа и ссылка на аудио выдаются только после старта
--     вопроса (start_question), с этого же момента сервер считает время;
--   * все админские действия проверяют членство в таблице admins.
-- =====================================================================

-- ---------- Таблицы ----------

create table if not exists public.profiles (
  id             uuid primary key references auth.users(id) on delete cascade,
  nickname       text not null check (char_length(btrim(nickname)) between 2 and 40),
  show_in_rating boolean not null default true,
  created_at     timestamptz not null default now()
);

create table if not exists public.admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.questions (
  id               uuid primary key default gen_random_uuid(),
  prompt           text not null default 'Что звучит?' check (char_length(prompt) <= 200),
  options          text[] not null check (array_length(options, 1) between 2 and 6),
  audio_path       text not null,
  fragment_seconds numeric(6,2),
  source_name      text,
  position         integer not null default 0,
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create table if not exists public.question_keys (
  question_id   uuid primary key references public.questions(id) on delete cascade,
  correct_index integer not null check (correct_index >= 0)
);

create table if not exists public.question_starts (
  user_id     uuid not null references auth.users(id) on delete cascade,
  question_id uuid not null references public.questions(id) on delete cascade,
  started_at  timestamptz not null default now(),
  primary key (user_id, question_id)
);

create table if not exists public.answers (
  user_id     uuid not null references auth.users(id) on delete cascade,
  question_id uuid not null references public.questions(id) on delete cascade,
  choice      integer not null,
  is_correct  boolean not null,
  response_ms integer not null,
  answered_at timestamptz not null default now(),
  primary key (user_id, question_id)
);

create index if not exists answers_question_idx on public.answers(question_id);
create index if not exists answers_answered_at_idx on public.answers(answered_at);
create index if not exists questions_position_idx on public.questions(position, created_at);

-- ---------- Вспомогательная функция ----------

create or replace function public.is_admin()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (select 1 from public.admins where user_id = auth.uid());
$$;

-- ---------- Row Level Security ----------

alter table public.profiles        enable row level security;
alter table public.admins          enable row level security;
alter table public.questions       enable row level security;
alter table public.question_keys   enable row level security;
alter table public.question_starts enable row level security;
alter table public.answers         enable row level security;

drop policy if exists "profiles_select" on public.profiles;
create policy "profiles_select" on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_admin());
drop policy if exists "profiles_insert" on public.profiles;
create policy "profiles_insert" on public.profiles for insert to authenticated
  with check (id = auth.uid());
drop policy if exists "profiles_update" on public.profiles;
create policy "profiles_update" on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists "admins_select_self" on public.admins;
create policy "admins_select_self" on public.admins for select to authenticated
  using (user_id = auth.uid());

-- Игроки не читают таблицу вопросов напрямую — только через функции ниже.
drop policy if exists "questions_admin" on public.questions;
create policy "questions_admin" on public.questions for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists "keys_admin" on public.question_keys;
create policy "keys_admin" on public.question_keys for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists "starts_admin" on public.question_starts;
create policy "starts_admin" on public.question_starts for select to authenticated
  using (public.is_admin());

-- Свои ответы игрок видит; писать ответы можно только через submit_answer.
drop policy if exists "answers_select" on public.answers;
create policy "answers_select" on public.answers for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

grant usage on schema public to anon, authenticated;
grant select, insert, update on public.profiles to authenticated;
grant select on public.admins to authenticated;
grant select, insert, update, delete on public.questions, public.question_keys to authenticated;
grant select on public.question_starts, public.answers to authenticated;

-- ---------- Функции для игроков ----------

-- Список активных вопросов и статус каждого для текущего игрока.
-- Варианты и аудио здесь намеренно не отдаются.
create or replace function public.quiz_state()
returns jsonb
language sql stable security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', q.id,
           'prompt', q.prompt,
           'started', s.user_id is not null,
           'answered', a.user_id is not null,
           'is_correct', a.is_correct
         ) order by q.position, q.created_at), '[]'::jsonb)
  from public.questions q
  left join public.question_starts s on s.question_id = q.id and s.user_id = auth.uid()
  left join public.answers a         on a.question_id = q.id and a.user_id = auth.uid()
  where q.is_active;
$$;

-- Старт вопроса: фиксирует время начала и отдаёт варианты и путь к аудио.
create or replace function public.start_question(p_question uuid)
returns jsonb
language plpgsql volatile security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_q   public.questions%rowtype;
begin
  if v_uid is null then raise exception 'not_authenticated'; end if;
  if not exists (select 1 from public.profiles where id = v_uid) then
    raise exception 'no_profile';
  end if;
  select * into v_q from public.questions where id = p_question and is_active;
  if not found then raise exception 'question_not_found'; end if;

  insert into public.question_starts (user_id, question_id)
  values (v_uid, v_q.id)
  on conflict do nothing;

  return jsonb_build_object(
    'id', v_q.id,
    'prompt', v_q.prompt,
    'options', to_jsonb(v_q.options),
    'audio_path', v_q.audio_path
  );
end;
$$;

-- Ответ: проверка на сервере, время считается от start_question.
create or replace function public.submit_answer(p_question uuid, p_choice integer)
returns jsonb
language plpgsql volatile security definer
set search_path = public
as $$
declare
  v_uid     uuid := auth.uid();
  v_q       public.questions%rowtype;
  v_started timestamptz;
  v_correct integer;
  v_ms      integer;
  v_a       public.answers%rowtype;
begin
  if v_uid is null then raise exception 'not_authenticated'; end if;
  select * into v_q from public.questions where id = p_question and is_active;
  if not found then raise exception 'question_not_found'; end if;

  select correct_index into v_correct from public.question_keys where question_id = v_q.id;
  if not found then raise exception 'question_has_no_key'; end if;

  select * into v_a from public.answers where user_id = v_uid and question_id = v_q.id;
  if not found then
    if p_choice is null or p_choice < 0 or p_choice >= array_length(v_q.options, 1) then
      raise exception 'invalid_choice';
    end if;
    select started_at into v_started from public.question_starts
      where user_id = v_uid and question_id = v_q.id;
    if not found then raise exception 'not_started'; end if;

    v_ms := least(extract(epoch from (clock_timestamp() - v_started)) * 1000, 2147483647)::integer;

    insert into public.answers (user_id, question_id, choice, is_correct, response_ms)
    values (v_uid, v_q.id, p_choice, p_choice = v_correct, v_ms)
    on conflict do nothing;

    select * into v_a from public.answers where user_id = v_uid and question_id = v_q.id;
  end if;

  return jsonb_build_object(
    'choice', v_a.choice,
    'is_correct', v_a.is_correct,
    'correct_index', v_correct,
    'response_ms', v_a.response_ms
  );
end;
$$;

-- Публичный рейтинг. Скрытые игроки видны без имени; себя игрок видит всегда.
create or replace function public.leaderboard(p_limit integer default 100)
returns jsonb
language sql stable security definer
set search_path = public
as $$
  with s as (
    select p.id, p.nickname, p.show_in_rating,
           count(*)::int                                  as answered,
           count(*) filter (where a.is_correct)::int      as correct,
           round(avg(a.response_ms))::int                 as avg_ms
    from public.profiles p
    join public.answers a on a.user_id = p.id
    group by p.id
  ), r as (
    select s.*, rank() over (order by correct desc, avg_ms asc nulls last) as rnk
    from s
  )
  select jsonb_build_object(
    'total_questions', (select count(*) from public.questions where is_active),
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
               'rank', rnk,
               'nickname', case when show_in_rating or id = auth.uid() then nickname end,
               'hidden', not show_in_rating,
               'answered', answered,
               'correct', correct,
               'avg_ms', avg_ms,
               'is_me', id = auth.uid()
             ) order by rnk, nickname)
      from r
      where rnk <= greatest(p_limit, 1) or id = auth.uid()
    ), '[]'::jsonb)
  );
$$;

-- Игрок удаляет свои данные: ответы, профиль и учётную запись.
create or replace function public.delete_my_account()
returns void
language plpgsql volatile security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'not_authenticated'; end if;
  delete from public.answers         where user_id = v_uid;
  delete from public.question_starts where user_id = v_uid;
  delete from public.profiles        where id = v_uid;
  delete from public.admins          where user_id = v_uid;
  begin
    delete from auth.users where id = v_uid;
  exception when insufficient_privilege then
    null;  -- если прав на auth.users нет, остаётся только почта; удалите её в Studio → Authentication
  end;
end;
$$;

-- ---------- Функции для администраторов ----------

create or replace function public.admin_save_question(
  p_id               uuid,
  p_prompt           text,
  p_options          text[],
  p_correct          integer,
  p_audio_path       text,
  p_fragment_seconds numeric,
  p_source_name      text,
  p_is_active        boolean
)
returns uuid
language plpgsql volatile security definer
set search_path = public
as $$
declare
  v_id  uuid := p_id;
  v_n   integer := coalesce(array_length(p_options, 1), 0);
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  if v_n < 2 or v_n > 6 then raise exception 'options_count'; end if;
  if exists (select 1 from unnest(p_options) o where btrim(o) = '') then
    raise exception 'empty_option';
  end if;
  if p_correct is null or p_correct < 0 or p_correct >= v_n then
    raise exception 'invalid_correct';
  end if;

  if v_id is null then
    if p_audio_path is null then raise exception 'audio_required'; end if;
    insert into public.questions (prompt, options, audio_path, fragment_seconds, source_name, is_active, position)
    values (coalesce(nullif(btrim(p_prompt), ''), 'Что звучит?'), p_options, p_audio_path,
            p_fragment_seconds, p_source_name, coalesce(p_is_active, true),
            coalesce((select max(position) + 1 from public.questions), 0))
    returning id into v_id;
  else
    update public.questions set
      prompt           = coalesce(nullif(btrim(p_prompt), ''), 'Что звучит?'),
      options          = p_options,
      audio_path       = coalesce(p_audio_path, audio_path),
      fragment_seconds = case when p_audio_path is null then fragment_seconds else p_fragment_seconds end,
      source_name      = case when p_audio_path is null then source_name else p_source_name end,
      is_active        = coalesce(p_is_active, is_active),
      updated_at       = now()
    where id = v_id;
    if not found then raise exception 'question_not_found'; end if;
  end if;

  insert into public.question_keys (question_id, correct_index)
  values (v_id, p_correct)
  on conflict (question_id) do update set correct_index = excluded.correct_index;

  return v_id;
end;
$$;

create or replace function public.admin_reorder(p_ids uuid[])
returns void
language plpgsql volatile security definer
set search_path = public
as $$
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  update public.questions q
     set position = t.ord - 1
    from unnest(p_ids) with ordinality as t(id, ord)
   where q.id = t.id;
end;
$$;

create or replace function public.admin_reset_player(p_user uuid)
returns void
language plpgsql volatile security definer
set search_path = public
as $$
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  delete from public.answers         where user_id = p_user;
  delete from public.question_starts where user_id = p_user;
end;
$$;

create or replace function public.admin_stats(p_tz text default 'UTC', p_days integer default 14)
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_tz text := p_tz;
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  if not exists (select 1 from pg_timezone_names where name = v_tz) then v_tz := 'UTC'; end if;

  return jsonb_build_object(
    'players',        (select count(*) from public.profiles),
    'active_players', (select count(distinct user_id) from public.answers),
    'answers',        (select count(*) from public.answers),
    'correct',        (select count(*) from public.answers where is_correct),
    'questions_active', (select count(*) from public.questions where is_active),
    'daily', (
      select jsonb_agg(jsonb_build_object('day', d::date, 'count', coalesce(c.n, 0)) order by d)
      from generate_series((now() at time zone v_tz)::date - (greatest(p_days, 1) - 1),
                           (now() at time zone v_tz)::date, interval '1 day') d
      left join (
        select (answered_at at time zone v_tz)::date as day, count(*) n
        from public.answers group by 1
      ) c on c.day = d::date
    ),
    'questions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', q.id,
        'prompt', q.prompt,
        'is_active', q.is_active,
        'options', to_jsonb(q.options),
        'correct_index', k.correct_index,
        'answered', coalesce(st.n, 0),
        'correct', coalesce(st.ok, 0),
        'avg_ms', st.avg_ms,
        'dist', (
          select jsonb_agg(coalesce(dc.n, 0) order by i)
          from generate_series(0, array_length(q.options, 1) - 1) i
          left join (select choice, count(*) n from public.answers
                     where question_id = q.id group by choice) dc on dc.choice = i
        )
      ) order by q.position, q.created_at)
      from public.questions q
      left join public.question_keys k on k.question_id = q.id
      left join (
        select question_id, count(*) n, count(*) filter (where is_correct) ok,
               round(avg(response_ms))::int avg_ms
        from public.answers group by question_id
      ) st on st.question_id = q.id
    ), '[]'::jsonb),
    'player_list', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id,
        'nickname', p.nickname,
        'email', u.email,
        'show_in_rating', p.show_in_rating,
        'registered_at', p.created_at,
        'answered', coalesce(st.n, 0),
        'correct', coalesce(st.ok, 0),
        'avg_ms', st.avg_ms,
        'last_at', st.last_at
      ) order by coalesce(st.ok, 0) desc, coalesce(st.n, 0) desc, p.created_at)
      from public.profiles p
      join auth.users u on u.id = p.id
      left join (
        select user_id, count(*) n, count(*) filter (where is_correct) ok,
               round(avg(response_ms))::int avg_ms, max(answered_at) last_at
        from public.answers group by user_id
      ) st on st.user_id = p.id
    ), '[]'::jsonb)
  );
end;
$$;

-- Все ответы построчно — для выгрузки в CSV.
create or replace function public.admin_export()
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'nickname', p.nickname,
      'email', u.email,
      'question', q.prompt,
      'choice', q.options[a.choice + 1],
      'correct', q.options[k.correct_index + 1],
      'is_correct', a.is_correct,
      'response_ms', a.response_ms,
      'answered_at', a.answered_at
    ) order by a.answered_at)
    from public.answers a
    join public.questions q     on q.id = a.question_id
    join public.profiles p      on p.id = a.user_id
    join auth.users u           on u.id = a.user_id
    left join public.question_keys k on k.question_id = q.id
  ), '[]'::jsonb);
end;
$$;

-- ---------- Права на функции ----------

revoke execute on function
  public.quiz_state(), public.start_question(uuid), public.submit_answer(uuid, integer), public.delete_my_account(),
  public.admin_save_question(uuid, text, text[], integer, text, numeric, text, boolean),
  public.admin_reorder(uuid[]), public.admin_reset_player(uuid),
  public.admin_stats(text, integer), public.admin_export()
  from public, anon;

grant execute on function
  public.is_admin(), public.quiz_state(), public.start_question(uuid), public.submit_answer(uuid, integer), public.delete_my_account(),
  public.admin_save_question(uuid, text, text[], integer, text, numeric, text, boolean),
  public.admin_reorder(uuid[]), public.admin_reset_player(uuid),
  public.admin_stats(text, integer), public.admin_export()
  to authenticated;

grant execute on function public.leaderboard(integer) to anon, authenticated;

-- ---------- Хранилище аудиофрагментов ----------
-- Публичный бакет: файлы доступны по ссылке, но список файлов не читается,
-- а имена — случайные UUID. Загружать и удалять могут только админы.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('fragments', 'fragments', true, 5242880, array['audio/mpeg'])
on conflict (id) do update
  set public = true, file_size_limit = 5242880, allowed_mime_types = array['audio/mpeg'];

drop policy if exists "fragments_admin_insert" on storage.objects;
create policy "fragments_admin_insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'fragments' and public.is_admin());

drop policy if exists "fragments_admin_update" on storage.objects;
create policy "fragments_admin_update" on storage.objects for update to authenticated
  using (bucket_id = 'fragments' and public.is_admin());

drop policy if exists "fragments_admin_delete" on storage.objects;
create policy "fragments_admin_delete" on storage.objects for delete to authenticated
  using (bucket_id = 'fragments' and public.is_admin());

-- Удалять файлы через API Supabase можно только если политика SELECT
-- разрешает их видеть — даём её только админам.
drop policy if exists "fragments_admin_select" on storage.objects;
create policy "fragments_admin_select" on storage.objects for select to authenticated
  using (bucket_id = 'fragments' and public.is_admin());

-- =====================================================================
-- Первый администратор. Сначала войдите на сайт с этой почтой,
-- затем выполните (подставив адрес):
--
--   insert into public.admins (user_id)
--   select id from auth.users where email = 'you@gmail.com'
--   on conflict do nothing;
-- =====================================================================

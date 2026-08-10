-- ============================================================================
-- Chat Manager — 0007_chat_ref_and_workspace_tokens
--
-- MUAMMO: chat qaysi loyihaga tegishli ekanini qayerdan bilamiz?
--   · claude.ai MCP serverga chat ID BERMAYDI (izolyatsiya cheklovi)
--   · `mcp-session-id` bor, lekin u transport sessiyasi — uzoq suhbatda
--     qayta ulanishda o'zgarishi mumkin, unga tayanib bo'lmaydi
--
-- YECHIM: identifikatorni O'ZIMIZ yasaymiz va uni SUHBATNING O'ZIGA
-- joylaymiz. `link_chat` javobida qaytgan `chat_ref` tool natijasi sifatida
-- suhbat kontekstiga kiradi — ya'ni model uni keyingi chaqiruvlarda ko'rib
-- turadi. Tashqi ID'ga umuman bog'liq emasmiz.
--
-- Aniqlash kaskadi (har pog'ona oldingisidan zaifroq, birga mustahkam):
--   1. chat_ref        — aniq moslik
--   2. external_id     — mcp-session-id yoki repo yo'li
--   3. label           — workspace'da AYNAN BITTA mos linked sessiya bo'lsa
--   4. hech biri       — yangi `pending` sessiya (yozmaydi, opt-in qoidasi)
--
-- Ikkinchi o'zgarish: token endi WORKSPACE darajasida ham bo'la oladi
-- (`cm_ws_...`). Bitta connector — hamma loyihalar. Loyihani `link_chat`
-- hal qiladi. Eski `cm_live_...` loyiha-tokenlari ishlashda davom etadi.
--
-- DIQQAT: bu migratsiya open_session/link_session imzolarini o'zgartiradi.
-- `ingest` va `mcp` funksiyalarini SHU migratsiya bilan birga deploy qiling.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Sxema o'zgarishlari
-- ----------------------------------------------------------------------------

-- Token endi loyihasiz ham bo'lishi mumkin (workspace darajasi)
alter table public.connect_tokens
  alter column project_id drop not null;

alter table public.connect_tokens
  add column if not exists scope text not null default 'project'
    check (scope in ('project', 'workspace'));

-- Loyihasi aniqlanmagan (pending) sessiya qonuniy holat: chat bor, lekin
-- hali qaysi loyihaga tegishli ekani noma'lum.
alter table public.chat_sessions
  alter column project_id drop not null;

alter table public.chat_sessions
  add column if not exists chat_ref text;

-- Eski unikallik (project_id, source, external_id) ikki sababdan yaramaydi:
--   a) project_id endi NULL bo'lishi mumkin, NULL'lar bir-biriga teng emas —
--      bitta chat uchun cheksiz pending qator paydo bo'lardi
--   b) to'g'ri qoida: bitta chat = bitta loyiha, ya'ni kalit workspace darajasida
alter table public.chat_sessions
  drop constraint if exists chat_sessions_project_id_source_external_id_key;

create unique index if not exists chat_sessions_external_idx
  on public.chat_sessions (workspace_id, source, external_id)
  where external_id is not null;

create unique index if not exists chat_sessions_chat_ref_idx
  on public.chat_sessions (chat_ref)
  where chat_ref is not null;

create index if not exists chat_sessions_label_idx
  on public.chat_sessions (workspace_id, source, lower(label))
  where status = 'linked';

-- ----------------------------------------------------------------------------
-- 2. chat_ref generatori + mavjud sessiyalarga backfill
-- ----------------------------------------------------------------------------
create or replace function app.new_chat_ref()
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ref text;
begin
  loop
    v_ref := 'chat_' || encode(extensions.gen_random_bytes(4), 'hex');
    exit when not exists (
      select 1 from public.chat_sessions cs where cs.chat_ref = v_ref
    );
  end loop;
  return v_ref;
end;
$$;

do $$
declare r record;
begin
  for r in select id from public.chat_sessions where chat_ref is null loop
    update public.chat_sessions set chat_ref = app.new_chat_ref() where id = r.id;
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- 3. Token yechish — endi scope ham qaytaradi
-- ----------------------------------------------------------------------------
drop function if exists app.resolve_token(text);

create function app.resolve_token(raw_token text)
returns table (
  out_project_id   uuid,
  out_workspace_id uuid,
  out_store_raw    boolean,
  out_scope        text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  h text := encode(extensions.digest(raw_token, 'sha256'), 'hex');
begin
  return query
  with upd as (
    update public.connect_tokens t
       set last_used_at = now()
     where t.token_hash = h
       and t.revoked_at is null
       -- loyiha-token: loyiha tirik bo'lishi shart. workspace-token: shart emas
       and (t.project_id is null or exists (
             select 1 from public.projects p2
              where p2.id = t.project_id and p2.archived_at is null))
    returning t.project_id as pid, t.workspace_id as wid, t.scope as scp
  )
  select u.pid, u.wid,
         coalesce(
           (select (p.settings ->> 'store_raw')::boolean
              from public.projects p where p.id = u.pid),
           false),
         u.scp
    from upd u;
end;
$$;

-- ----------------------------------------------------------------------------
-- 4. Workspace darajasidagi token yaratish
-- ----------------------------------------------------------------------------
create or replace function public.create_workspace_token(
  p_workspace uuid,
  p_channel   text,
  p_label     text default null
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  raw_tok text;
begin
  if not app.can_write(p_workspace) then
    raise exception 'Ruxsat yo''q';
  end if;
  if p_channel not in ('hook', 'mcp', 'extension') then
    raise exception 'Noto''g''ri kanal: %', p_channel;
  end if;

  raw_tok := 'cm_ws_' || encode(extensions.gen_random_bytes(24), 'hex');

  insert into public.connect_tokens
    (workspace_id, project_id, token_hash, token_prefix, label, channel, scope)
  values
    (p_workspace, null,
     encode(extensions.digest(raw_tok, 'sha256'), 'hex'),
     left(raw_tok, 14), p_label, p_channel, 'workspace');

  return raw_tok;   -- BIR MARTA
end;
$$;
grant execute on function public.create_workspace_token(uuid, text, text) to authenticated;

-- ----------------------------------------------------------------------------
-- 5. ASOSIY: sessiyani topish yoki yaratish — aniqlash kaskadi
-- ----------------------------------------------------------------------------
drop function if exists app.find_or_create_session(uuid, text, uuid, text, text, text, text, text);

create function app.find_or_create_session(
  p_ws          uuid,
  p_scope       text,
  p_tok_project uuid,
  p_source      text,
  p_external_id text,
  p_chat_ref    text,
  p_label       text,
  p_title       text
)
returns table (out_session_id uuid, out_resolved_by text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id   uuid;
  v_by   text;
  v_cnt  int;
begin
  -- Loyiha-token bo'lsa qidiruv faqat o'sha loyiha ichida. Aks holda bitta
  -- loyihaning tokeni bilan boshqa loyihaning sessiyasiga tegib bo'lardi.

  -- (1) chat_ref — eng ishonchli
  if p_chat_ref is not null and btrim(p_chat_ref) <> '' then
    select cs.id into v_id
      from public.chat_sessions cs
     where cs.chat_ref = btrim(p_chat_ref)
       and cs.workspace_id = p_ws
       and (p_scope = 'workspace' or cs.project_id is not distinct from p_tok_project
            or cs.project_id is null);
    if v_id is not null then
      v_by := 'chat_ref';
      -- transport sessiyasi almashgan bo'lishi mumkin — yangilab qo'yamiz,
      -- shunda 2-pog'ona keyingi safar ham ishlaydi
      if p_external_id is not null then
        update public.chat_sessions cs
           set external_id = p_external_id
         where cs.id = v_id
           and cs.external_id is distinct from p_external_id
           and not exists (
             select 1 from public.chat_sessions o
              where o.workspace_id = p_ws and o.source = p_source
                and o.external_id = p_external_id and o.id <> v_id);
      end if;
      return query select v_id, v_by;
      return;
    end if;
  end if;

  -- (2) external_id — mcp-session-id yoki repo yo'li
  if p_external_id is not null and btrim(p_external_id) <> '' then
    select cs.id into v_id
      from public.chat_sessions cs
     where cs.workspace_id = p_ws
       and cs.source = p_source
       and cs.external_id = p_external_id
       and (p_scope = 'workspace' or cs.project_id is not distinct from p_tok_project
            or cs.project_id is null);
    if v_id is not null then
      return query select v_id, 'external_id'::text;
      return;
    end if;
  end if;

  -- (3) label — AYNAN BITTA mos linked sessiya bo'lsagina.
  -- Ikkitasi bo'lsa jim turamiz: noto'g'ri chatga yozishdan ko'ra yangi
  -- pending yaratish xavfsizroq.
  if p_label is not null and btrim(p_label) <> '' then
    -- min(uuid) Postgres'da yo'q — avval sanaymiz, keyin olamiz
    select count(*) into v_cnt
      from public.chat_sessions cs
     where cs.workspace_id = p_ws
       and cs.source = p_source
       and cs.status = 'linked'
       and lower(cs.label) = lower(btrim(p_label))
       and (p_scope = 'workspace' or cs.project_id is not distinct from p_tok_project);

    if v_cnt = 1 then
      select cs.id into v_id
        from public.chat_sessions cs
       where cs.workspace_id = p_ws
         and cs.source = p_source
         and cs.status = 'linked'
         and lower(cs.label) = lower(btrim(p_label))
         and (p_scope = 'workspace' or cs.project_id is not distinct from p_tok_project);
      update public.chat_sessions cs
         set external_id = coalesce(p_external_id, cs.external_id)
       where cs.id = v_id
         and (p_external_id is null or not exists (
           select 1 from public.chat_sessions o
            where o.workspace_id = p_ws and o.source = p_source
              and o.external_id = p_external_id and o.id <> v_id));
      return query select v_id, 'label'::text;
      return;
    end if;
  end if;

  -- (4) Yangi sessiya — har doim `pending`. Loyiha faqat token loyiha
  -- darajasida bo'lsa ma'lum; workspace tokenda link_chat aytadi.
  insert into public.chat_sessions
    (workspace_id, project_id, source, external_id, title, label, chat_ref, status)
  values
    (p_ws,
     case when p_scope = 'project' then p_tok_project else null end,
     p_source, nullif(btrim(coalesce(p_external_id, '')), ''),
     p_title, nullif(btrim(coalesce(p_label, '')), ''),
     app.new_chat_ref(), 'pending')
  returning id into v_id;

  return query select v_id, 'new'::text;
end;
$$;

-- ----------------------------------------------------------------------------
-- 6. open_session — yangi imzo
-- ----------------------------------------------------------------------------
drop function if exists app.open_session(text, text, text, text);
drop function if exists app.open_session(text, text, text, text, text, text);

create function app.open_session(
  p_token       text,
  p_source      text,
  p_external_id text,
  p_chat_ref    text default null,
  p_label       text default null,
  p_title       text default null
)
returns table (
  out_session_id   uuid,
  out_chat_ref     text,
  out_project_id   uuid,
  out_project_name text,
  out_workspace_id uuid,
  out_status       text,
  out_cursor_seq   bigint,
  out_store_raw    boolean,
  out_resolved_by  text,
  out_scope        text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  t_project uuid; t_ws uuid; t_raw boolean; t_scope text;
  s_id uuid; s_by text;
begin
  select r.out_project_id, r.out_workspace_id, r.out_store_raw, r.out_scope
    into t_project, t_ws, t_raw, t_scope
    from app.resolve_token(p_token) r;

  if t_ws is null then
    raise exception 'invalid_token' using errcode = '28000';
  end if;

  select f.out_session_id, f.out_resolved_by into s_id, s_by
    from app.find_or_create_session(
      t_ws, t_scope, t_project, p_source, p_external_id, p_chat_ref, p_label, p_title) f;

  return query
    select cs.id, cs.chat_ref, cs.project_id, p.name, cs.workspace_id,
           cs.status, cs.cursor_seq,
           coalesce((p.settings ->> 'store_raw')::boolean, t_raw),
           s_by, t_scope
      from public.chat_sessions cs
      left join public.projects p on p.id = cs.project_id
     where cs.id = s_id;
end;
$$;

-- ----------------------------------------------------------------------------
-- 7. link_session — loyihani biriktiradi va chat_ref qaytaradi
-- ----------------------------------------------------------------------------
drop function if exists app.link_session(text, text, text, text);
drop function if exists app.link_session(text, text, text, text, text, text);
drop function if exists app.link_session(text, text, text, text, uuid, text);

create function app.link_session(
  p_token       text,
  p_source      text,
  p_external_id text,
  p_chat_ref    text default null,
  p_project_id  uuid default null,
  p_label       text default null
)
returns table (
  out_chat_ref     text,
  out_project_id   uuid,
  out_project_name text,
  out_status       text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  t_project uuid; t_ws uuid; t_scope text; t_raw boolean;
  s_id uuid; s_by text;
  target uuid;
begin
  select r.out_project_id, r.out_workspace_id, r.out_store_raw, r.out_scope
    into t_project, t_ws, t_raw, t_scope
    from app.resolve_token(p_token) r;

  if t_ws is null then
    raise exception 'invalid_token' using errcode = '28000';
  end if;

  target := coalesce(p_project_id, t_project);

  if target is null then
    raise exception 'project_required'
      using hint = 'Workspace tokeni bilan loyiha ID sini ko''rsatish shart';
  end if;

  -- Loyiha shu workspace'ga tegishlimi? Aks holda bir tenant boshqasining
  -- loyihasiga yozib yuborardi.
  if not exists (
    select 1 from public.projects p
     where p.id = target and p.workspace_id = t_ws and p.archived_at is null
  ) then
    raise exception 'project_not_found';
  end if;

  -- Loyiha-token boshqa loyihaga ulay olmaydi
  if t_scope = 'project' and target is distinct from t_project then
    raise exception 'token_scope_mismatch';
  end if;

  select f.out_session_id, f.out_resolved_by into s_id, s_by
    from app.find_or_create_session(
      t_ws, t_scope, t_project, p_source, p_external_id, p_chat_ref, p_label, null) f;

  update public.chat_sessions cs
     set project_id = target,
         status     = 'linked',
         label      = coalesce(nullif(btrim(coalesce(p_label, '')), ''), cs.label)
   where cs.id = s_id;

  return query
    select cs.chat_ref, cs.project_id, p.name, cs.status
      from public.chat_sessions cs
      join public.projects p on p.id = cs.project_id
     where cs.id = s_id;
end;
$$;

-- ----------------------------------------------------------------------------
-- 8. Loyihalar ro'yxati — MCP `chat_manager_projects` uchun
-- ----------------------------------------------------------------------------
create or replace function app.list_projects(p_token text)
returns table (out_id uuid, out_name text, out_nodes int, out_open int)
language plpgsql
security definer
set search_path = ''
as $$
declare
  t_project uuid; t_ws uuid; t_raw boolean; t_scope text;
begin
  select r.out_project_id, r.out_workspace_id, r.out_store_raw, r.out_scope
    into t_project, t_ws, t_raw, t_scope
    from app.resolve_token(p_token) r;

  if t_ws is null then
    raise exception 'invalid_token' using errcode = '28000';
  end if;

  return query
    select p.id, p.name,
           (select count(*)::int from public.nodes n where n.project_id = p.id),
           (select count(*)::int from public.nodes n
             where n.project_id = p.id and n.status in ('todo', 'in_progress'))
      from public.projects p
     where p.workspace_id = t_ws
       and p.archived_at is null
       and (t_scope = 'workspace' or p.id = t_project)
     order by p.created_at;
end;
$$;

-- ----------------------------------------------------------------------------
-- 9. public.cm_* o'ramlari — PostgREST faqat public sxemani ochadi
-- ----------------------------------------------------------------------------
drop function if exists public.cm_open_session(text, text, text, text);
drop function if exists public.cm_open_session(text, text, text, text, text, text);
drop function if exists public.cm_link_session(text, text, text, text);
drop function if exists public.cm_link_session(text, text, text, text, uuid, text);
drop function if exists public.cm_list_projects(text);

create function public.cm_open_session(
  p_token text, p_source text, p_external_id text,
  p_chat_ref text default null, p_label text default null, p_title text default null)
returns table (
  out_session_id uuid, out_chat_ref text, out_project_id uuid, out_project_name text,
  out_workspace_id uuid, out_status text, out_cursor_seq bigint,
  out_store_raw boolean, out_resolved_by text, out_scope text)
language sql security definer set search_path = '' as $$
  select * from app.open_session(p_token, p_source, p_external_id,
                                 p_chat_ref, p_label, p_title);
$$;

create function public.cm_link_session(
  p_token text, p_source text, p_external_id text,
  p_chat_ref text default null, p_project_id uuid default null, p_label text default null)
returns table (out_chat_ref text, out_project_id uuid, out_project_name text, out_status text)
language sql security definer set search_path = '' as $$
  select * from app.link_session(p_token, p_source, p_external_id,
                                 p_chat_ref, p_project_id, p_label);
$$;

create function public.cm_list_projects(p_token text)
returns table (out_id uuid, out_name text, out_nodes int, out_open int)
language sql security definer set search_path = '' as $$
  select * from app.list_projects(p_token);
$$;

revoke all on function public.cm_open_session(text, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.cm_link_session(text, text, text, text, uuid, text) from public, anon, authenticated;
revoke all on function public.cm_list_projects(text)                              from public, anon, authenticated;
revoke all on function app.find_or_create_session(uuid, text, uuid, text, text, text, text, text)
                                                                                  from public, anon, authenticated;
revoke all on function app.new_chat_ref()                                         from public, anon, authenticated;
revoke all on function app.list_projects(text)                                    from public, anon, authenticated;

grant execute on function public.cm_open_session(text, text, text, text, text, text) to service_role;
grant execute on function public.cm_link_session(text, text, text, text, uuid, text) to service_role;
grant execute on function public.cm_list_projects(text)                              to service_role;

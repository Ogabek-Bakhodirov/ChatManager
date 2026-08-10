-- ============================================================================
-- Chat Manager — 0001_chat_manager_init
-- Multi-tenant asos: workspaces + RLS 1-kundan.
-- Qarorlar: opt-in chat ulash, bir loyiha ↔ ko'p chat, xom matn saqlanmaydi
-- (faqat tugun boshiga ≤200 belgilik iqtibos).
-- Postgres 15+ / Supabase.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0. Kengaytmalar
-- ----------------------------------------------------------------------------
create schema if not exists extensions;
create extension if not exists pgcrypto  with schema extensions;  -- gen_random_uuid, digest
create extension if not exists pg_trgm   with schema extensions;  -- fuzzy title matching

-- Yordamchi funksiyalar uchun alohida schema — public toza qoladi
create schema if not exists app;
revoke all on schema app from public;
grant usage on schema app to authenticated, service_role;


-- ============================================================================
-- 1. TENANT QATLAMI
-- ============================================================================

create table public.workspaces (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(btrim(name)) between 1 and 120),
  plan        text not null default 'free' check (plan in ('free','pro','team')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
comment on table public.workspaces is 'Tenant chegarasi. Har bir user ro''yxatdan o''tganda avtomatik yaratiladi.';

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id      uuid not null references auth.users(id)        on delete cascade,
  role         text not null default 'owner'
                 check (role in ('owner','admin','member','viewer')),
  created_at   timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index workspace_members_user_idx on public.workspace_members (user_id);


-- ============================================================================
-- 2. YORDAMCHI FUNKSIYALAR
--    Barchasi `security definer` + `search_path = ''` (injection himoyasi)
-- ============================================================================

-- RLS'ning yuragi. STABLE + definer => policy'lar ichida tez ishlaydi.
create or replace function app.is_member(ws uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1 from public.workspace_members m
    where m.workspace_id = ws
      and m.user_id = (select auth.uid())
  );
$$;

-- Yozish huquqi (viewer o'zgartira olmaydi)
create or replace function app.can_write(ws uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1 from public.workspace_members m
    where m.workspace_id = ws
      and m.user_id = (select auth.uid())
      and m.role in ('owner','admin','member')
  );
$$;

-- Sarlavhani normallashtirish: stable_key va fuzzy match uchun asos.
-- "  Supabase SXEMAsini  yozish! " -> "supabase sxemasini yozish"
create or replace function app.normalize_title(t text)
returns text
language sql
immutable
set search_path = ''
as $$
  select btrim(regexp_replace(lower(coalesce(t,'')), '[^a-z0-9Ѐ-ӿ]+', ' ', 'g'));
$$;

-- updated_at avtomatik
create or replace function app.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Yangi user -> workspace + owner a'zoligi
create or replace function app.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  ws_id uuid;
  ws_name text;
begin
  ws_name := coalesce(
    nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''),
    split_part(coalesce(new.email, 'workspace'), '@', 1)
  ) || ' workspace';

  insert into public.workspaces (name) values (ws_name) returning id into ws_id;
  insert into public.workspace_members (workspace_id, user_id, role)
    values (ws_id, new.id, 'owner');
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function app.handle_new_user();


-- ============================================================================
-- 3. LOYIHALAR VA ULANISH TOKENLARI
-- ============================================================================

create table public.projects (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name         text not null check (length(btrim(name)) between 1 and 200),
  -- store_raw: xom xabar matni saqlanadimi (default NO — faqat iqtibos)
  -- auto_apply_threshold: shu confidence'dan yuqori op'lar avtomatik qo'llanadi
  -- ghost_threshold: bundan pastlari ghost, undan ham pasti tashlanadi
  settings     jsonb not null default
                 '{"store_raw": false, "auto_apply_threshold": 0.8, "ghost_threshold": 0.5}'::jsonb,
  archived_at  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index projects_workspace_idx on public.projects (workspace_id) where archived_at is null;

create trigger projects_touch
  before update on public.projects
  for each row execute function app.touch_updated_at();

-- Xom token HECH QACHON saqlanmaydi — faqat sha256 hash.
create table public.connect_tokens (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id   uuid not null references public.projects(id)   on delete cascade,
  token_hash   text not null unique,
  token_prefix text not null,              -- UI'da ko'rsatish uchun: "cm_live_a1b2…"
  label        text,                       -- "MacBook — claude code"
  channel      text not null check (channel in ('hook','mcp','extension')),
  last_used_at timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz not null default now()
);
create index connect_tokens_project_idx on public.connect_tokens (project_id) where revoked_at is null;

-- Token tekshiruvi. Faqat service_role chaqiradi (Edge Function).
create or replace function app.resolve_token(raw_token text)
returns table (out_project_id uuid, out_workspace_id uuid, out_store_raw boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  h text := encode(extensions.digest(raw_token, 'sha256'), 'hex');
begin
  -- Data-modifying statement RETURN QUERY ichida faqat CTE orqali ishlaydi
  return query
  with upd as (
    update public.connect_tokens t
       set last_used_at = now()
     where t.token_hash = h
       and t.revoked_at is null
       and exists (select 1 from public.projects p2
                    where p2.id = t.project_id and p2.archived_at is null)
    returning t.project_id as pid, t.workspace_id as wid
  )
  select u.pid, u.wid,
         coalesce((p.settings ->> 'store_raw')::boolean, false)
    from upd u
    join public.projects p on p.id = u.pid;
end;
$$;
revoke all on function app.resolve_token(text) from public, authenticated;

-- Token YARATISH faqat shu funksiya orqali. Xom token bir marta qaytadi va
-- boshqa hech qayerda yo'q. Frontend connect_tokens'ga INSERT qila olmaydi.
create or replace function public.create_connect_token(
  p_project uuid,
  p_channel text,
  p_label   text default null
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  ws       uuid;
  raw_tok  text;
begin
  select p.workspace_id into ws
    from public.projects p
   where p.id = p_project and p.archived_at is null;

  if ws is null then
    raise exception 'Loyiha topilmadi';
  end if;
  if not app.can_write(ws) then
    raise exception 'Ruxsat yo''q';
  end if;
  if p_channel not in ('hook','mcp','extension') then
    raise exception 'Noto''g''ri kanal: %', p_channel;
  end if;

  raw_tok := 'cm_live_' || encode(extensions.gen_random_bytes(24), 'hex');

  insert into public.connect_tokens
    (workspace_id, project_id, token_hash, token_prefix, label, channel)
  values
    (ws, p_project,
     encode(extensions.digest(raw_tok, 'sha256'), 'hex'),
     left(raw_tok, 16),
     p_label, p_channel);

  return raw_tok;   -- BIR MARTA. Qayta ko'rsatib bo'lmaydi.
end;
$$;
grant execute on function public.create_connect_token(uuid, text, text) to authenticated;


-- ============================================================================
-- 4. CHAT SESSIYALARI — OPT-IN
--    status='pending' bo'lsa /ingest hech narsa qabul qilmaydi (409 not_linked)
-- ============================================================================

create table public.chat_sessions (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  project_id    uuid not null references public.projects(id)   on delete cascade,
  source        text not null check (source in
                  ('claude_code','claude_web','cowork','chatgpt','gemini','manual')),
  external_id   text,                    -- host tomonidagi session_id / cwd hash
  title         text,
  label         text,                    -- user beradigan nom: "Backend suhbati"
  color         text not null default '#6366f1',
  status        text not null default 'pending'
                  check (status in ('pending','linked','paused','unlinked')),
  linked_at     timestamptz,
  cursor_seq    bigint not null default 0,   -- oxirgi qayta ishlangan xabar tartibi
  last_synced_at timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (project_id, source, external_id)
);
create index chat_sessions_project_idx on public.chat_sessions (project_id, status);

create trigger chat_sessions_touch
  before update on public.chat_sessions
  for each row execute function app.touch_updated_at();

-- linked_at ni status bilan sinxron ushlash
create or replace function app.sync_link_state()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = 'linked' and (old.status is distinct from 'linked') then
    new.linked_at := coalesce(new.linked_at, now());
  end if;
  return new;
end;
$$;

create trigger chat_sessions_link_state
  before update on public.chat_sessions
  for each row execute function app.sync_link_state();


-- ============================================================================
-- 5. XABAR INDEKSI
--    Default: content = NULL (xom matn saqlanmaydi).
--    Faqat projects.settings.store_raw = true bo'lsa Edge Function to'ldiradi.
--    content_hash esa DOIM yoziladi — idempotentlik va dublikat uchun.
-- ============================================================================

create table public.messages (
  id           text not null,                -- host beradigan barqaror ID
  session_id   uuid not null references public.chat_sessions(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id)    on delete cascade,
  role         text not null check (role in ('user','assistant','tool')),
  seq          bigint not null,
  content      text,                         -- odatda NULL
  content_hash text not null,
  char_count   int not null default 0,
  created_at   timestamptz not null default now(),
  primary key (session_id, id)
);
create index messages_seq_idx on public.messages (session_id, seq);
create unique index messages_dedupe_idx on public.messages (session_id, content_hash);
comment on column public.messages.content is
  'Default NULL. Faqat projects.settings.store_raw = true bo''lganda to''ldiriladi.';


-- ============================================================================
-- 6. DARAXT TUGUNLARI
-- ============================================================================

create table public.nodes (
  id                 uuid primary key default gen_random_uuid(),
  workspace_id       uuid not null references public.workspaces(id) on delete cascade,
  project_id         uuid not null references public.projects(id)   on delete cascade,
  parent_id          uuid references public.nodes(id) on delete cascade,

  title              text not null check (length(btrim(title)) between 1 and 500),
  description        text,
  type               text not null default 'task'
                       check (type in ('milestone','task','subtask','note','blocker')),
  status             text not null default 'todo'
                       check (status in ('todo','in_progress','done','blocked','cancelled')),

  -- Dublikatga qarshi: loyiha ichida unique
  stable_key         text not null,

  -- Ishonch va ghost mexanizmi
  confidence         real not null default 1.0 check (confidence between 0 and 1),
  is_ghost           boolean not null default false,
  ghost_strikes      int not null default 0,

  -- Joylashuv
  position           int not null default 0,
  canvas_x           real,
  canvas_y           real,                  -- to'ldirilgan bo'lsa avto-layout tegmaydi

  -- Manba (bir loyiha ↔ ko'p chat)
  origin_session_id  uuid references public.chat_sessions(id) on delete set null,
  touched_by_sessions uuid[] not null default '{}',

  -- Evidence: xom chat o'rniga faqat qisqa iqtibos
  evidence_quote     text check (evidence_quote is null or length(evidence_quote) <= 200),
  evidence_message_id text,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  done_at            timestamptz
);

create unique index nodes_stable_key_idx on public.nodes (project_id, stable_key);
create index nodes_tree_idx    on public.nodes (project_id, parent_id, position);
create index nodes_status_idx  on public.nodes (project_id, status) where is_ghost = false;
create index nodes_title_trgm  on public.nodes using gin (title extensions.gin_trgm_ops);
create index nodes_sessions_idx on public.nodes using gin (touched_by_sessions);

create trigger nodes_touch
  before update on public.nodes
  for each row execute function app.touch_updated_at();

-- --------------------------------------------------------------------------
-- Yaxlitlik: workspace mosligi, ota-ona bir loyihada, sikl yo'q, stable_key
-- --------------------------------------------------------------------------
create or replace function app.check_node_integrity()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  p_ws   uuid;
  p_proj uuid;
  cur    uuid;
  hops   int := 0;
  parent_key text := '';
begin
  -- workspace_id loyihadan olinadi, ishonch faqat serverga emas
  select p.workspace_id into p_ws from public.projects p where p.id = new.project_id;
  if p_ws is null then
    raise exception 'nodes: project % topilmadi', new.project_id;
  end if;
  new.workspace_id := p_ws;

  if new.parent_id is not null then
    if new.parent_id = new.id then
      raise exception 'nodes: tugun o''ziga ota-ona bo''la olmaydi';
    end if;

    select n.project_id, n.stable_key into p_proj, parent_key
      from public.nodes n where n.id = new.parent_id;
    if p_proj is null then
      raise exception 'nodes: parent % topilmadi', new.parent_id;
    end if;
    if p_proj <> new.project_id then
      raise exception 'nodes: ota-ona boshqa loyihada';
    end if;

    -- sikl tekshiruvi (yangilashda muhim)
    cur := new.parent_id;
    while cur is not null and hops < 100 loop
      if cur = new.id then
        raise exception 'nodes: daraxtda sikl hosil bo''ldi';
      end if;
      select n.parent_id into cur from public.nodes n where n.id = cur;
      hops := hops + 1;
    end loop;
  end if;

  -- stable_key: berilmagan bo'lsa ota-ona yo'li + normallashgan sarlavhadan
  if new.stable_key is null or btrim(new.stable_key) = '' then
    new.stable_key := left(
      coalesce(nullif(parent_key,'') || ' > ', '') || app.normalize_title(new.title),
      500);
  end if;

  -- done_at
  if new.status = 'done' and (tg_op = 'INSERT' or old.status is distinct from 'done') then
    new.done_at := now();
  elsif new.status <> 'done' then
    new.done_at := null;
  end if;

  return new;
end;
$$;

create trigger nodes_integrity
  before insert or update on public.nodes
  for each row execute function app.check_node_integrity();


-- ============================================================================
-- 7. HODISALAR (append-only) VA SYNC MONITORINGI
-- ============================================================================

create table public.node_events (
  id           bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id   uuid not null references public.projects(id)   on delete cascade,
  node_id      uuid,                        -- FK yo'q: tugun o'chsa ham tarix qoladi
  session_id   uuid references public.chat_sessions(id) on delete set null,
  op           text not null check (op in
                 ('add_node','set_status','rename','move','delete','merge','ghost_expired')),
  payload      jsonb not null default '{}'::jsonb,
  confidence   real,
  actor        text not null default 'ai' check (actor in ('ai','user','system')),
  created_at   timestamptz not null default now()
);
create index node_events_feed_idx on public.node_events (project_id, created_at desc);
create index node_events_node_idx on public.node_events (node_id);

create table public.sync_runs (
  id                bigint generated always as identity primary key,
  workspace_id      uuid not null references public.workspaces(id) on delete cascade,
  project_id        uuid not null references public.projects(id)   on delete cascade,
  session_id        uuid references public.chat_sessions(id) on delete set null,
  trigger           text not null check (trigger in
                      ('stop_hook','session_end','mcp_tool','extension','manual','reconcile')),
  messages_in       int not null default 0,
  ops_out           int not null default 0,
  ops_applied       int not null default 0,
  prefilter_skipped boolean not null default false,
  model             text,
  input_tokens      int not null default 0,
  output_tokens     int not null default 0,
  cost_usd          numeric(12,6) not null default 0,
  duration_ms       int,
  error             text,
  created_at        timestamptz not null default now()
);
create index sync_runs_project_idx on public.sync_runs (project_id, created_at desc);

-- Billing/limit uchun oylik yig'indi
create or replace view public.v_workspace_usage
with (security_invoker = true) as
  select workspace_id,
         date_trunc('month', created_at) as month,
         count(*)                        as runs,
         sum(input_tokens)               as input_tokens,
         sum(output_tokens)              as output_tokens,
         sum(cost_usd)                   as cost_usd
    from public.sync_runs
   group by 1, 2;


-- ============================================================================
-- 8. OPERATSION FUNKSIYALAR
-- ============================================================================

-- Ikki chat bir vaqtda sync qilsa — navbat. Tranzaksiya oxirida o'zi bo'shaydi.
create or replace function app.lock_project(p_project uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  select pg_advisory_xact_lock(hashtextextended(p_project::text, 0));
$$;

-- Fuzzy merge: "Auth yozish" ~ "Auth flow yozish" -> bitta tugun
create or replace function app.find_similar_node(
  p_project   uuid,
  p_parent    uuid,
  p_title     text,
  p_threshold real default 0.75
)
returns uuid
language sql
security definer
stable
set search_path = ''
as $$
  select n.id
    from public.nodes n
   where n.project_id = p_project
     and n.parent_id is not distinct from p_parent
     and extensions.similarity(app.normalize_title(n.title), app.normalize_title(p_title)) >= p_threshold
   order by extensions.similarity(app.normalize_title(n.title), app.normalize_title(p_title)) desc
   limit 1;
$$;

-- Ghost tozalash: 3 sikl tasdiqlanmagan taxminlar o'chadi
create or replace function app.sweep_ghosts(p_project uuid, p_max_strikes int default 3)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  removed int;
begin
  with gone as (
    delete from public.nodes n
     where n.project_id = p_project
       and n.is_ghost = true
       and n.ghost_strikes >= p_max_strikes
    returning n.id, n.workspace_id, n.project_id, n.title
  )
  insert into public.node_events (workspace_id, project_id, node_id, op, payload, actor)
  select g.workspace_id, g.project_id, g.id, 'ghost_expired',
         jsonb_build_object('title', g.title), 'system'
    from gone g;

  get diagnostics removed = row_count;
  return removed;
end;
$$;


-- ============================================================================
-- 9. RLS — HAR BIR JADVALDA
--    Frontend faqat anon/authenticated kalit bilan keladi.
--    Edge Function service_role bilan keladi va RLS'ni aylanib o'tadi,
--    lekin app.resolve_token() orqali o'zi tekshiradi.
-- ============================================================================

alter table public.workspaces        enable row level security;
alter table public.workspace_members enable row level security;
alter table public.projects          enable row level security;
alter table public.connect_tokens    enable row level security;
alter table public.chat_sessions     enable row level security;
alter table public.messages          enable row level security;
alter table public.nodes             enable row level security;
alter table public.node_events       enable row level security;
alter table public.sync_runs         enable row level security;

-- workspaces
create policy workspaces_select on public.workspaces
  for select to authenticated using (app.is_member(id));
create policy workspaces_update on public.workspaces
  for update to authenticated using (app.can_write(id)) with check (app.can_write(id));

-- workspace_members: o'z a'zoligini va workspace sheriklarini ko'radi
create policy members_select on public.workspace_members
  for select to authenticated using (app.is_member(workspace_id));

-- projects
create policy projects_select on public.projects
  for select to authenticated using (app.is_member(workspace_id));
create policy projects_insert on public.projects
  for insert to authenticated with check (app.can_write(workspace_id));
create policy projects_update on public.projects
  for update to authenticated using (app.can_write(workspace_id))
                                with check (app.can_write(workspace_id));
create policy projects_delete on public.projects
  for delete to authenticated using (app.can_write(workspace_id));

-- connect_tokens: hash hech qachon frontendga chiqmasligi kerak ->
-- faqat metadata ustunlarini ochamiz (grant orqali, quyida)
create policy tokens_select on public.connect_tokens
  for select to authenticated using (app.is_member(workspace_id));
create policy tokens_write on public.connect_tokens
  for all to authenticated using (app.can_write(workspace_id))
                            with check (app.can_write(workspace_id));

-- chat_sessions: user ulaydi/pauza qiladi -> to'liq huquq
create policy sessions_select on public.chat_sessions
  for select to authenticated using (app.is_member(workspace_id));
create policy sessions_write on public.chat_sessions
  for all to authenticated using (app.can_write(workspace_id))
                            with check (app.can_write(workspace_id));

-- messages: faqat o'qish (yozish Edge Function ishi)
create policy messages_select on public.messages
  for select to authenticated using (app.is_member(workspace_id));

-- nodes: user canvas'da suradi, tahrirlaydi, o'chiradi
create policy nodes_select on public.nodes
  for select to authenticated using (app.is_member(workspace_id));
create policy nodes_write on public.nodes
  for all to authenticated using (app.can_write(workspace_id))
                            with check (app.can_write(workspace_id));

-- node_events: append-only -> UPDATE/DELETE policy YO'Q (ataylab)
create policy events_select on public.node_events
  for select to authenticated using (app.is_member(workspace_id));
create policy events_insert on public.node_events
  for insert to authenticated with check (app.can_write(workspace_id));

-- sync_runs: faqat o'qish
create policy runs_select on public.sync_runs
  for select to authenticated using (app.is_member(workspace_id));


-- ============================================================================
-- 10. GRANT'LAR — token_hash frontendga umuman ko'rinmaydi
-- ============================================================================

grant usage on schema public to authenticated;

-- MUHIM: Supabase `public` sxemasidagi har bir yangi jadvalga anon va
-- authenticated uchun avtomatik ALL PRIVILEGES beradi. Ustun darajasidagi
-- grant'lar buni CHEKLAMAYDI — avval hammasini olib tashlash SHART.
revoke all on public.workspaces        from anon, authenticated;
revoke all on public.workspace_members from anon, authenticated;
revoke all on public.projects          from anon, authenticated;
revoke all on public.connect_tokens    from anon, authenticated;
revoke all on public.chat_sessions     from anon, authenticated;
revoke all on public.messages          from anon, authenticated;
revoke all on public.nodes             from anon, authenticated;
revoke all on public.node_events       from anon, authenticated;
revoke all on public.sync_runs         from anon, authenticated;
revoke all on public.v_workspace_usage from anon, authenticated;

-- Kelajakdagi jadvallar ham avtomatik ochilib qolmasin
alter default privileges in schema public revoke all on tables    from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;

grant select                         on public.workspaces        to authenticated;
grant update (name)                  on public.workspaces        to authenticated;
grant select                         on public.workspace_members to authenticated;
grant select, insert, update, delete on public.projects          to authenticated;
grant select, insert, update, delete on public.chat_sessions     to authenticated;
grant select                         on public.messages          to authenticated;
grant select, insert, update, delete on public.nodes             to authenticated;
grant select, insert                 on public.node_events       to authenticated;
grant select                         on public.sync_runs         to authenticated;
grant select                         on public.v_workspace_usage to authenticated;

-- connect_tokens: token_hash HAR TOMONLAMA yopiq.
-- INSERT umuman berilmaydi — token faqat create_connect_token() orqali tug'iladi.
-- UPDATE faqat ikkita ustunga: bekor qilish va nom o'zgartirish.
grant select (id, workspace_id, project_id, token_prefix, label, channel,
              last_used_at, revoked_at, created_at)
  on public.connect_tokens to authenticated;
grant update (label, revoked_at) on public.connect_tokens to authenticated;
grant delete                     on public.connect_tokens to authenticated;

grant execute on function app.is_member(uuid)  to authenticated;
grant execute on function app.can_write(uuid)  to authenticated;
grant execute on function app.normalize_title(text) to authenticated;


-- ============================================================================
-- 11. REALTIME — canvas jonli yangilanadi
-- ============================================================================
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.nodes;
    alter publication supabase_realtime add table public.node_events;
    alter publication supabase_realtime add table public.chat_sessions;
  end if;
end $$;

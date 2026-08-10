-- ============================================================================
-- Chat Manager — 0004_ingest_rpcs
-- Ingest quvurining baza tomoni. Hammasi service_role uchun (Edge Function).
--
--   app.open_session()  — token -> sessiya (yaratadi yoki topadi), cursor qaytaradi
--   app.link_session()  — sessiyani 'linked' qiladi (opt-in)
--   app.record_messages() — xabar indeksini yozadi, delta uchun seq beradi
--   app.apply_ops()     — operatsiyalarni ATOMIK qo'llaydi (asosiy funksiya)
--   app.tree_compact()  — Pass B uchun daraxtning ixcham matni
-- ============================================================================

-- Qayta yugurtirish mumkin bo'lishi uchun: `create or replace` chiquvchi
-- ustunlar o'zgarganda ishlamaydi, shuning uchun avval o'chiramiz.
drop function if exists app.open_session(text, text, text, text);
drop function if exists app.link_session(text, text, text, text);
drop function if exists app.record_messages(uuid, jsonb, boolean);
drop function if exists app.apply_ops(uuid, jsonb, bigint);
drop function if exists app.tree_compact(uuid, int);

-- ----------------------------------------------------------------------------
-- 1. Sessiya ochish. Yangi sessiya 'pending' bo'lib tug'iladi — opt-in qoidasi.
-- ----------------------------------------------------------------------------
create or replace function app.open_session(
  p_token       text,
  p_source      text,
  p_external_id text,
  p_title       text default null
)
-- Chiquvchi ustunlar `out_` prefiksi bilan: aks holda ular PL/pgSQL o'zgaruvchisi
-- sifatida jadval ustunlari bilan to'qnashadi (on conflict (project_id, ...)).
returns table (
  out_session_id   uuid,
  out_project_id   uuid,
  out_workspace_id uuid,
  out_status       text,
  out_cursor_seq   bigint,
  out_store_raw    boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  t_project uuid;
  t_ws      uuid;
  t_raw     boolean;
  s_id      uuid;
begin
  select r.out_project_id, r.out_workspace_id, r.out_store_raw
    into t_project, t_ws, t_raw
    from app.resolve_token(p_token) r;

  if t_project is null then
    raise exception 'invalid_token' using errcode = '28000';
  end if;

  insert into public.chat_sessions (workspace_id, project_id, source, external_id, title)
       values (t_ws, t_project, p_source, p_external_id, p_title)
  on conflict (project_id, source, external_id) do update
          set title = coalesce(excluded.title, public.chat_sessions.title)
    returning id into s_id;

  return query
    select cs.id, cs.project_id, cs.workspace_id, cs.status, cs.cursor_seq, t_raw
      from public.chat_sessions cs where cs.id = s_id;
end;
$$;

-- ----------------------------------------------------------------------------
-- 2. Sessiyani ulash — user ochiq roziligi
-- ----------------------------------------------------------------------------
create or replace function app.link_session(
  p_token       text,
  p_source      text,
  p_external_id text,
  p_label       text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  t_project uuid;
  s_id      uuid;
begin
  select r.out_project_id into t_project from app.resolve_token(p_token) r;
  if t_project is null then
    raise exception 'invalid_token' using errcode = '28000';
  end if;

  update public.chat_sessions cs
     set status = 'linked',
         label  = coalesce(p_label, cs.label)
   where cs.project_id = t_project
     and cs.source = p_source
     and cs.external_id is not distinct from p_external_id
  returning cs.id into s_id;

  return s_id;
end;
$$;

-- ----------------------------------------------------------------------------
-- 3. Xabar indeksi. content faqat store_raw=true bo'lsa yoziladi.
--    Takroriy xabarlar (content_hash) jimgina tashlanadi -> idempotent.
-- ----------------------------------------------------------------------------
create or replace function app.record_messages(
  p_session   uuid,
  p_messages  jsonb,      -- [{id, role, seq, content}]
  p_store_raw boolean default false
)
returns bigint             -- eng katta seq
language plpgsql
security definer
set search_path = ''
as $$
declare
  t_ws  uuid;
  maxseq bigint;
begin
  select cs.workspace_id into t_ws from public.chat_sessions cs where cs.id = p_session;
  if t_ws is null then
    raise exception 'session_not_found';
  end if;

  insert into public.messages (id, session_id, workspace_id, role, seq,
                               content, content_hash, char_count)
  select m ->> 'id',
         p_session,
         t_ws,
         m ->> 'role',
         (m ->> 'seq')::bigint,
         case when p_store_raw then m ->> 'content' else null end,
         md5(coalesce(m ->> 'content', '')),
         length(coalesce(m ->> 'content', ''))
    from jsonb_array_elements(p_messages) m
  on conflict do nothing;

  select max(msg.seq) into maxseq from public.messages msg where msg.session_id = p_session;
  return coalesce(maxseq, 0);
end;
$$;

-- ----------------------------------------------------------------------------
-- 4. Daraxtning ixcham matni — Pass B promptiga tushadi
-- ----------------------------------------------------------------------------
create or replace function app.tree_compact(p_project uuid, p_max_nodes int default 300)
returns text
language sql
security definer
stable
set search_path = ''
as $$
  with recursive t as (
    select n.id, n.parent_id, n.title, n.status, n.is_ghost, n.position,
           0 as depth, lpad('', 0) as pad
      from public.nodes n
     where n.project_id = p_project and n.parent_id is null
    union all
    select c.id, c.parent_id, c.title, c.status, c.is_ghost, c.position,
           t.depth + 1, repeat('  ', t.depth + 1)
      from public.nodes c join t on c.parent_id = t.id
     where t.depth < 6
  )
  select coalesce(string_agg(
           pad || id::text || ' [' || status || case when is_ghost then ' ~ghost' else '' end
                || '] ' || title,
           E'\n' order by depth, position, title), '(bo''sh)')
    from (select * from t limit p_max_nodes) x;
$$;

-- ----------------------------------------------------------------------------
-- 5. ASOSIY: operatsiyalarni atomik qo'llash
--
--    p_ops formati (Edge Function ref'larni allaqachon UUID'ga aylantirgan):
--    [
--      {"op":"add_node","temp_id":"t1","parent_id":"<uuid>|null",
--       "parent_temp":"t0|null","title":"...","type":"task","status":"todo",
--       "confidence":0.9,"evidence":"...","evidence_message_id":"msg_08"},
--      {"op":"set_status","node_id":"<uuid>","status":"done","confidence":0.95,...},
--      {"op":"rename","node_id":"<uuid>","title":"...","confidence":0.8,...},
--      {"op":"move","node_id":"<uuid>","parent_id":"<uuid>|null","confidence":0.7,...}
--    ]
-- ----------------------------------------------------------------------------
create or replace function app.apply_ops(
  p_session    uuid,
  p_ops        jsonb,
  p_cursor     bigint default null
)
returns table (applied int, skipped int, ghosts int, expired int)
language plpgsql
security definer
set search_path = ''
as $$
declare
  t_project   uuid;
  t_ws        uuid;
  auto_thr    real;
  ghost_thr   real;
  op          jsonb;
  tempmap     jsonb := '{}'::jsonb;
  v_applied   int := 0;
  v_skipped   int := 0;
  v_ghosts    int := 0;
  v_expired   int := 0;
  v_parent    uuid;
  v_conf      real;
  v_ghost     boolean;
  v_new_id    uuid;
  v_node      uuid;
  v_pos       int;
  touched     uuid[] := '{}';
begin
  select cs.project_id, cs.workspace_id into t_project, t_ws
    from public.chat_sessions cs where cs.id = p_session;
  if t_project is null then
    raise exception 'session_not_found';
  end if;

  -- Ikki chat bir vaqtda sync qilsa navbat. Tranzaksiya oxirida o'zi bo'shaydi.
  perform app.lock_project(t_project);

  select coalesce((p.settings ->> 'auto_apply_threshold')::real, 0.8),
         coalesce((p.settings ->> 'ghost_threshold')::real, 0.5)
    into auto_thr, ghost_thr
    from public.projects p where p.id = t_project;

  for op in select * from jsonb_array_elements(coalesce(p_ops, '[]'::jsonb))
  loop
    v_conf := coalesce((op ->> 'confidence')::real, 0.5);

    -- Ishonch juda past — umuman yozilmaydi
    if v_conf < ghost_thr then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    v_ghost := (v_conf < auto_thr);

    -- ---------------- add_node ----------------
    if op ->> 'op' = 'add_node' then
      v_parent := null;
      if op ->> 'parent_temp' is not null then
        v_parent := (tempmap ->> (op ->> 'parent_temp'))::uuid;
      elsif op ->> 'parent_id' is not null then
        v_parent := (op ->> 'parent_id')::uuid;
      end if;

      -- ota-ona boshqa loyihada bo'lsa ildizga tushiramiz
      if v_parent is not null and not exists (
           select 1 from public.nodes n
            where n.id = v_parent and n.project_id = t_project) then
        v_parent := null;
      end if;

      select coalesce(max(n.position), -1) + 1 into v_pos
        from public.nodes n
       where n.project_id = t_project and n.parent_id is not distinct from v_parent;

      begin
        insert into public.nodes
          (project_id, parent_id, title, description, type, status,
           confidence, is_ghost, position, origin_session_id, touched_by_sessions,
           evidence_quote, evidence_message_id)
        values
          (t_project, v_parent,
           left(btrim(op ->> 'title'), 500),
           op ->> 'description',
           coalesce(op ->> 'type', 'task'),
           coalesce(op ->> 'status', 'todo'),
           v_conf, v_ghost, v_pos, p_session, array[p_session],
           left(op ->> 'evidence', 200),
           op ->> 'evidence_message_id')
        returning id into v_new_id;
      exception when unique_violation then
        -- stable_key band: bu ish allaqachon bor. Yangi yaratmaymiz, statusni
        -- yangilaymiz (Pass B o'tkazib yuborgan holat uchun himoya).
        select n.id into v_new_id
          from public.nodes n
         where n.project_id = t_project
           and n.stable_key = left(
                 coalesce((select nn.stable_key || ' > ' from public.nodes nn
                            where nn.id = v_parent), '')
                 || app.normalize_title(op ->> 'title'), 500);

        if v_new_id is not null and op ->> 'status' is not null then
          update public.nodes n
             set status = op ->> 'status',
                 touched_by_sessions =
                   (select array_agg(distinct s) from unnest(n.touched_by_sessions || p_session) s)
           where n.id = v_new_id;
        end if;

        -- MUHIM: temp_id ni MAVJUD tugunga bog'lash shart. Aks holda shu
        -- javobdagi farzand op'lari ota-onasiz qolib, ildizga dublikat
        -- bo'lib tushadi.
        if v_new_id is not null and op ->> 'temp_id' is not null then
          tempmap := tempmap || jsonb_build_object(op ->> 'temp_id', v_new_id::text);
          touched := touched || v_new_id;
        end if;

        v_skipped := v_skipped + 1;
        continue;
      end;

      if op ->> 'temp_id' is not null then
        tempmap := tempmap || jsonb_build_object(op ->> 'temp_id', v_new_id::text);
      end if;

      touched := touched || v_new_id;
      if v_ghost then v_ghosts := v_ghosts + 1; end if;
      v_applied := v_applied + 1;

      insert into public.node_events
        (workspace_id, project_id, node_id, session_id, op, payload, confidence, actor)
      values
        (t_ws, t_project, v_new_id, p_session, 'add_node',
         jsonb_build_object('title', op ->> 'title', 'status', op ->> 'status',
                            'evidence', op ->> 'evidence'),
         v_conf, 'ai');

    -- ---------------- mavjud tugun ustidagi operatsiyalar ----------------
    else
      v_node := (op ->> 'node_id')::uuid;

      if v_node is null or not exists (
           select 1 from public.nodes n
            where n.id = v_node and n.project_id = t_project) then
        v_skipped := v_skipped + 1;
        continue;
      end if;

      if op ->> 'op' = 'set_status' then
        update public.nodes n
           set status = op ->> 'status',
               is_ghost = false,             -- tasdiqlandi
               ghost_strikes = 0,
               touched_by_sessions =
                 (select array_agg(distinct s) from unnest(n.touched_by_sessions || p_session) s)
         where n.id = v_node;

      elsif op ->> 'op' = 'rename' then
        update public.nodes n
           set title = left(btrim(op ->> 'title'), 500),
               stable_key = null,            -- trigger qayta hisoblaydi
               touched_by_sessions =
                 (select array_agg(distinct s) from unnest(n.touched_by_sessions || p_session) s)
         where n.id = v_node;

      elsif op ->> 'op' = 'move' then
        v_parent := null;
        if op ->> 'parent_temp' is not null then
          v_parent := (tempmap ->> (op ->> 'parent_temp'))::uuid;
        elsif op ->> 'parent_id' is not null then
          v_parent := (op ->> 'parent_id')::uuid;
        end if;
        update public.nodes n set parent_id = v_parent, stable_key = null
         where n.id = v_node;

      else
        v_skipped := v_skipped + 1;
        continue;
      end if;

      touched := touched || v_node;
      v_applied := v_applied + 1;

      insert into public.node_events
        (workspace_id, project_id, node_id, session_id, op, payload, confidence, actor)
      values
        (t_ws, t_project, v_node, p_session, op ->> 'op',
         op - 'node_id' - 'confidence', v_conf, 'ai');
    end if;
  end loop;

  -- Bu siklda tegilmagan ghost'larga strike
  update public.nodes n
     set ghost_strikes = n.ghost_strikes + 1
   where n.project_id = t_project
     and n.is_ghost = true
     and not (n.id = any(touched));

  v_expired := app.sweep_ghosts(t_project);

  -- Cursor'ni surish
  if p_cursor is not null then
    update public.chat_sessions cs
       set cursor_seq = greatest(cs.cursor_seq, p_cursor),
           last_synced_at = now()
     where cs.id = p_session;
  end if;

  return query select v_applied, v_skipped, v_ghosts, v_expired;
end;
$$;

-- ----------------------------------------------------------------------------
-- 6. Huquqlar: bu funksiyalar faqat service_role (Edge Function) uchun
-- ----------------------------------------------------------------------------
revoke all on function app.open_session(text, text, text, text)      from public, anon, authenticated;
revoke all on function app.link_session(text, text, text, text)      from public, anon, authenticated;
revoke all on function app.record_messages(uuid, jsonb, boolean)     from public, anon, authenticated;
revoke all on function app.apply_ops(uuid, jsonb, bigint)            from public, anon, authenticated;
revoke all on function app.tree_compact(uuid, int)                   from public, anon, authenticated;

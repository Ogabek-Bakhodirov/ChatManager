-- ============================================================================
-- 0009_node_notes_and_context.sql
--
-- MUAMMO: tugun sarlavhasi ("Kursor xatosini tuzatish") suhbatni eslashga
-- yetmaydi. Nima qaror qilindi, nega shunday qilindi — bularning hech biri
-- saqlanmaydi. `evidence_quote` bor, lekin u 200 belgilik parcha.
--
-- YECHIM ikki qatlamli:
--   1. nodes.note — extractor yozadigan 2-3 gapli xulosa. Har doim bor.
--   2. public.node_context() — tugun chiqqan xabar va uning atrofidagilar.
--      Faqat projects.settings.store_raw = true bo'lganda matn qaytadi.
--
-- Bu migratsiya qayta yugurtirilsa ham xavfsiz.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Xulosa maydoni
-- ----------------------------------------------------------------------------
alter table public.nodes
  add column if not exists note text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'nodes_note_len'
  ) then
    alter table public.nodes
      add constraint nodes_note_len check (note is null or length(note) <= 800);
  end if;
end $$;

comment on column public.nodes.note is
  'Extractor yozgan qisqa xulosa: nima qaror qilindi va nega. <= 800 belgi.';

-- node_events.op ro'yxatiga `annotate` qo'shiladi. Bu bo'lmasa apply_ops
-- xulosani yozib, keyin hodisa qatorida check constraint'ga urilib qoladi.
alter table public.node_events drop constraint if exists node_events_op_check;
alter table public.node_events
  add constraint node_events_op_check check (op in (
    'add_node', 'set_status', 'rename', 'move', 'delete', 'merge',
    'ghost_expired', 'annotate'
  ));

-- ----------------------------------------------------------------------------
-- 2. apply_ops — note yoziladi, `annotate` op'i qo'shildi
--
--    Yangi op:
--      {"op":"annotate","node_id":"<uuid>","note":"...","evidence":"...",
--       "evidence_message_id":"m12","confidence":0.9}
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
           evidence_quote, evidence_message_id, note)
        values
          (t_project, v_parent,
           left(btrim(op ->> 'title'), 500),
           op ->> 'description',
           coalesce(op ->> 'type', 'task'),
           coalesce(op ->> 'status', 'todo'),
           v_conf, v_ghost, v_pos, p_session, array[p_session],
           left(op ->> 'evidence', 200),
           op ->> 'evidence_message_id',
           nullif(left(op ->> 'note', 800), ''))
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

      elsif op ->> 'op' = 'annotate' then
        -- Faqat xulosa/iqtibos yangilanadi. Amal pastda umumiy blokda.
        null;

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

      -- Xulosani boyitish. Qoida: bo'sh bo'lsa to'ldiramiz; bor bo'lsa faqat
      -- yangisi UZUNROQ bo'lganda almashtiramiz. Aks holda keyingi sync'dagi
      -- bir og'iz izoh oldin yozilgan to'liq xulosani o'chirib yuborardi.
      if coalesce(op ->> 'note', '') <> '' then
        update public.nodes n
           set note = left(op ->> 'note', 800)
         where n.id = v_node
           and (n.note is null or length(n.note) < length(op ->> 'note'));
      end if;

      -- Iqtibos faqat bo'sh bo'lsa yoziladi: birinchi manba eng ishonchlisi.
      if coalesce(op ->> 'evidence', '') <> '' then
        update public.nodes n
           set evidence_quote = left(op ->> 'evidence', 200),
               evidence_message_id =
                 coalesce(n.evidence_message_id, op ->> 'evidence_message_id')
         where n.id = v_node and n.evidence_quote is null;
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
-- 3. node_context — tugun chiqqan joydagi suhbat parchasi
--
--    Nega alohida funksiya: brauzer uchta so'rov qilishi kerak bo'lardi
--    (tugun -> xabar seq -> atrofdagilar). Bu bitta chaqiruvda beradi va
--    a'zolikni serverda tekshiradi.
--
--    content NULL qaytishi normal holat: loyihada store_raw o'chiq bo'lsa
--    xabar matni umuman saqlanmagan. UI shuni ko'rsatib, yoqishni taklif qiladi.
-- ----------------------------------------------------------------------------
drop function if exists public.node_context(uuid, int);

create or replace function public.node_context(p_node uuid, p_span int default 2)
returns table (
  out_id       text,
  out_role     text,
  out_seq      bigint,
  out_content  text,
  out_is_anchor boolean
)
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_ws      uuid;
  v_session uuid;
  v_msg     text;
  v_seq     bigint;
  v_span    int := least(greatest(coalesce(p_span, 2), 0), 10);
begin
  select n.workspace_id, n.origin_session_id, n.evidence_message_id
    into v_ws, v_session, v_msg
    from public.nodes n
   where n.id = p_node;

  if v_ws is null then
    return;                                   -- tugun yo'q
  end if;

  -- security definer: a'zolikni O'ZIMIZ tekshiramiz, RLS bu yerda ishlamaydi
  if not app.is_member(v_ws) then
    raise exception 'not_a_member';
  end if;

  if v_session is null or v_msg is null then
    return;                                   -- manba xabar noma'lum
  end if;

  select m.seq into v_seq
    from public.messages m
   where m.session_id = v_session and m.id = v_msg;

  if v_seq is null then
    return;
  end if;

  return query
    select m.id, m.role, m.seq, m.content, (m.seq = v_seq)
      from public.messages m
     where m.session_id = v_session
       and m.seq between v_seq - v_span and v_seq + v_span
     order by m.seq;
end;
$$;

revoke all on function public.node_context(uuid, int) from public, anon;
grant execute on function public.node_context(uuid, int) to authenticated;

-- ----------------------------------------------------------------------------
-- 4. Tekshiruv
-- ----------------------------------------------------------------------------
do $$
declare
  n_ok  boolean;
  f_ok  boolean;
  a_ok  boolean;
begin
  select exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'nodes' and column_name = 'note'
  ) into n_ok;

  select exists (
    select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = 'public' and p.proname = 'node_context'
  ) into f_ok;

  select exists (
    select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = 'app' and p.proname = 'apply_ops'
       and pg_get_functiondef(p.oid) like '%annotate%'
  ) into a_ok;

  raise notice '0009: nodes.note=%  node_context=%  apply_ops.annotate=%',
    n_ok, f_ok, a_ok;

  if not (n_ok and f_ok and a_ok) then
    raise exception '0009 to''liq qo''llanmadi';
  end if;
end $$;

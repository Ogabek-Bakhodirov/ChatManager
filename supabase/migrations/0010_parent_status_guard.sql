-- ============================================================================
-- 0010_parent_status_guard.sql
--
-- AUDIT O10: extractor ostida ochiq (todo/in_progress/blocked) farzandlari
-- bor tugunni 'done' qilib qo'yadi. Jonli holat: "3-bosqich canvas v2" done
-- bo'ldi, ostida 5 ta todo turardi. Qoida endi bazada: bunday tugunga 'done'
-- kelsa 'in_progress' yoziladi. Qoida faqat apply_ops (AI yo'li) uchun —
-- foydalanuvchi UI orqali to'g'ridan-to'g'ri UPDATE bilan xohlaganini qiladi.
--
-- Qayta yugurtirish xavfsiz (create or replace).
-- ============================================================================

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
        -- OTA QOIDASI (audit O10): ostida ochiq farzandlari bor tugunga 'done'
        -- kelsa, u ASLIDA tugallanmagan. Extractor jonli holatda "3-bosqich"ni
        -- 5 ta ochiq todo farzandi turganda yopib qo'ygan edi. Bunday holatda
        -- 'done' o'rniga 'in_progress' yoziladi (progress signali saqlanadi);
        -- oxirgi farzand yopilganda keyingi sync otani ham to'g'ri yopadi.
        if op ->> 'status' = 'done' and exists (
             select 1 from public.nodes c
              where c.parent_id = v_node
                and c.status not in ('done', 'cancelled')) then
          update public.nodes n
             set status = case when n.status = 'todo' then 'in_progress'
                               else n.status end,
                 is_ghost = false,
                 ghost_strikes = 0,
                 touched_by_sessions =
                   (select array_agg(distinct s) from unnest(n.touched_by_sessions || p_session) s)
           where n.id = v_node;
        else
          update public.nodes n
             set status = op ->> 'status',
                 is_ghost = false,             -- tasdiqlandi
                 ghost_strikes = 0,
                 touched_by_sessions =
                   (select array_agg(distinct s) from unnest(n.touched_by_sessions || p_session) s)
           where n.id = v_node;
        end if;

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

-- Tekshiruv
do $$
begin
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'app' and p.proname = 'apply_ops'
       and pg_get_functiondef(p.oid) like '%OTA QOIDASI%'
  ) then
    raise exception '0010 qo''llanmadi';
  end if;
  raise notice '0010: ota tugun qoidasi joyida';
end $$;

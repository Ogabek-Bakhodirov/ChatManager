-- ==========================================================================
-- Loosend — 0012_gardener
--
-- MUAMMO: yozish bor, bog'bonchilik yo'q. Struktura faqat daraxt bo'sh
-- bo'lganda quriladi (PASS_B_STRUCTURE); keyin har sync o'z bandlarini
-- ildizga tashlayveradi. Natija jonli bazada ko'rinib turibdi: 60+ ildiz,
-- "#118 caching" aslida "#117 tejash"ning bolasi, bitta benchmark task uch
-- nusxada (#116 #122 #129).
--
-- NIMA QILADI: app.tidy_ops() — daraxtni qayta tashkil qiluvchi op'lar
-- (move/merge) uchun alohida ijrochi.
--
-- Nega apply_ops emas:
--   1. apply_ops'da bitta xato butun tranzaksiyani yiqitadi. Sync uchun bu
--      to'g'ri (yo hammasi, yo hech narsa). Gardener uchun noto'g'ri: model
--      taklif qilgan 12 harakatdan bittasi sikl hosil qilsa, qolgan 11 tasi
--      baribir qo'llanishi kerak. Bu yerda har op o'z exception blokida.
--   2. Auditda farq ko'rinishi kerak: gardener 'system', qo'lda buyruq
--      'user', sync 'ai'. apply_ops actor'ni qattiq 'ai' qilib yozadi.
--
-- MERGE SEMANTIKASI (yo'qotishsiz):
--   absorb'ning bolalari -> keep ostiga; keep'ning bo'sh maydonlari
--   (note, evidence) absorb'dan to'ldiriladi; absorb'ning hodisalar tarixi
--   keep'ga ko'chiriladi (node_events.node_id FK emas — tarix yashaydi);
--   faqat shundan keyin absorb o'chiriladi. Hech qanday matn yo'qolmaydi.
--
-- IDEMPOTENT: qayta yugurtirsa xato bermaydi.
-- ==========================================================================

begin;

create or replace function app.tidy_ops(
  p_project uuid,
  p_session uuid,          -- null bo'lishi mumkin (gardener sessiyasiz yuradi)
  p_ops     jsonb,         -- [{"op":"move","node":u,"parent":u|null},
                           --  {"op":"merge","keep":u,"absorb":u}]
  p_actor   text default 'system'
)
returns table (moved int, merged int, rejected int)
language plpgsql
security definer
set search_path = ''
as $$
declare
  t_ws       uuid;
  op         jsonb;
  v_moved    int := 0;
  v_merged   int := 0;
  v_rejected int := 0;
  v_node     uuid;
  v_parent   uuid;
  v_keep     uuid;
  v_absorb   uuid;
  v_pos      int;
  k_note     text;
  k_ev       text;
  a_note     text;
  a_ev       text;
  a_title    text;
  a_sess     uuid[];
begin
  if p_actor not in ('system', 'user') then
    raise exception 'tidy_ops: actor % mumkin emas', p_actor;
  end if;

  select p.workspace_id into t_ws from public.projects p where p.id = p_project;
  if t_ws is null then
    raise exception 'tidy_ops: loyiha % topilmadi', p_project;
  end if;

  -- Sync bilan bir xil qulf — gardener va sync bir daraxtni bir vaqtda
  -- o'zgartirmasin.
  perform app.lock_project(p_project);

  for op in select * from jsonb_array_elements(coalesce(p_ops, '[]'::jsonb))
  loop
    begin
      -- ================================================== move ============
      if op ->> 'op' = 'move' then
        v_node   := (op ->> 'node')::uuid;
        v_parent := nullif(op ->> 'parent', '')::uuid;

        if v_node is null then raise exception 'move: node yo''q'; end if;
        if v_node = v_parent then raise exception 'move: o''ziga'; end if;
        if not exists (select 1 from public.nodes n
                        where n.id = v_node and n.project_id = p_project) then
          raise exception 'move: tugun boshqa loyihada yoki yo''q';
        end if;
        -- parent tekshiruvi va sikl — nodes_integrity trigger'ida. U raise
        -- qilsa shu blokning exception qismi op'ni rejected qiladi, xolos.

        select coalesce(max(n.position), -1) + 1 into v_pos
          from public.nodes n
         where n.project_id = p_project
           and n.parent_id is not distinct from v_parent;

        update public.nodes n
           set parent_id  = v_parent,
               position   = v_pos,
               stable_key = null              -- trigger yangi yo'ldan qayta hisoblaydi
         where n.id = v_node;

        insert into public.node_events
          (workspace_id, project_id, node_id, session_id, op, payload, actor)
        values
          (t_ws, p_project, v_node, p_session, 'move',
           jsonb_build_object('parent_id', v_parent, 'via', 'tidy'), p_actor);

        v_moved := v_moved + 1;

      -- ================================================== merge ===========
      elsif op ->> 'op' = 'merge' then
        v_keep   := (op ->> 'keep')::uuid;
        v_absorb := (op ->> 'absorb')::uuid;

        if v_keep is null or v_absorb is null then
          raise exception 'merge: keep/absorb yo''q';
        end if;
        if v_keep = v_absorb then raise exception 'merge: o''ziga'; end if;
        if not exists (select 1 from public.nodes n
                        where n.id = v_keep and n.project_id = p_project)
           or not exists (select 1 from public.nodes n
                        where n.id = v_absorb and n.project_id = p_project) then
          raise exception 'merge: tugun boshqa loyihada yoki yo''q';
        end if;

        -- keep absorb'ning avlodi bo'lsa, bolalarni ko'chirish sikl yasaydi.
        -- Trigger baribir ushlaydi, lekin yarim ko'chgan holatni exception
        -- ichida qoldirmaslik uchun oldindan tekshiramiz.
        if exists (
          with recursive up as (
            select id, parent_id from public.nodes where id = v_keep
            union all
            select n.id, n.parent_id
              from public.nodes n join up on n.id = up.parent_id
          )
          select 1 from up where id = v_absorb
        ) then
          raise exception 'merge: keep absorb ichida — sikl';
        end if;

        select n.note, n.evidence_quote into k_note, k_ev
          from public.nodes n where n.id = v_keep;
        select n.note, n.evidence_quote, n.title, n.touched_by_sessions
          into a_note, a_ev, a_title, a_sess
          from public.nodes n where n.id = v_absorb;

        -- 1) bolalar keep ostiga
        update public.nodes n
           set parent_id = v_keep, stable_key = null
         where n.parent_id = v_absorb;

        -- 2) keep'ning bo'sh maydonlari to'ldiriladi (bor narsa yutmaydi)
        update public.nodes n
           set note           = coalesce(k_note, a_note),
               evidence_quote = coalesce(k_ev, a_ev),
               touched_by_sessions =
                 (select coalesce(array_agg(distinct s), '{}')
                    from unnest(n.touched_by_sessions || a_sess) s)
         where n.id = v_keep;

        -- 3) tarix keep'ga ko'chadi — absorb bilan bo'lgan hamma hodisa
        --    endi keep sahifasida ko'rinadi
        update public.node_events e
           set node_id = v_keep
         where e.node_id = v_absorb;

        -- 4) merge hodisasi (nima yutilgani yozilib qoladi)
        insert into public.node_events
          (workspace_id, project_id, node_id, session_id, op, payload, actor)
        values
          (t_ws, p_project, v_keep, p_session, 'merge',
           jsonb_build_object('absorbed_id', v_absorb,
                              'absorbed_title', a_title), p_actor);

        -- 5) endi absorb o'chadi (bolasiz, tarixi ko'chgan)
        delete from public.nodes n where n.id = v_absorb;

        v_merged := v_merged + 1;

      else
        raise exception 'tidy_ops: noma''lum op %', op ->> 'op';
      end if;

    exception when others then
      -- BITTA op yiqildi — qolganlari davom etadi. Gardener taklifi
      -- maslahat, qonun emas.
      v_rejected := v_rejected + 1;
    end;
  end loop;

  return query select v_moved, v_merged, v_rejected;
end;
$$;

revoke all on function app.tidy_ops(uuid, uuid, jsonb, text)
  from public, anon, authenticated;

-- Edge Function uchun o'ram
create or replace function public.cm_tidy(
  p_project uuid,
  p_session uuid,
  p_ops     jsonb,
  p_actor   text default 'system'
)
returns table (moved int, merged int, rejected int)
language sql security definer set search_path = '' as $$
  select * from app.tidy_ops(p_project, p_session, p_ops, p_actor);
$$;

revoke all on function public.cm_tidy(uuid, uuid, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.cm_tidy(uuid, uuid, jsonb, text) to service_role;

commit;

-- ==========================================================================
-- O'Z-O'ZINI TEKSHIRISH
-- ==========================================================================

do $$
declare
  ws    uuid;
  proj  uuid;
  n_a   uuid;  -- ota (faza)
  n_b   uuid;  -- ildizda adashgan bola
  n_c   uuid;  -- dublikat 1 (note bor)
  n_d   uuid;  -- dublikat 2 (note yo'q, bolasi bor)
  n_e   uuid;  -- n_d ning bolasi
  r     record;
  ev    int;
  txt   text;
begin
  insert into public.workspaces (name) values ('tidy-test') returning id into ws;
  insert into public.projects (workspace_id, name) values (ws, 'T') returning id into proj;

  insert into public.nodes (project_id, title, stable_key)
    values (proj, 'Faza: tejash', 'a') returning id into n_a;
  insert into public.nodes (project_id, title, stable_key)
    values (proj, 'prompt caching', 'b') returning id into n_b;
  insert into public.nodes (project_id, title, stable_key, note)
    values (proj, 'benchmark yozish', 'c', 'asl note') returning id into n_c;
  insert into public.nodes (project_id, title, stable_key)
    values (proj, 'benchmark sunatish', 'd') returning id into n_d;
  insert into public.nodes (project_id, parent_id, title, stable_key)
    values (proj, n_d, 'fixture tayyorlash', 'e') returning id into n_e;

  -- ---- T1: oddiy move ----------------------------------------------------
  select * into r from app.tidy_ops(proj, null, jsonb_build_array(
    jsonb_build_object('op','move','node',n_b,'parent',n_a)), 'system');
  if r.moved <> 1 or r.rejected <> 0 then
    raise exception 'T1 yiqildi: moved=% rejected=%', r.moved, r.rejected;
  end if;
  if (select parent_id from public.nodes where id = n_b) is distinct from n_a then
    raise exception 'T1 yiqildi: parent o''zgarmadi';
  end if;

  -- ---- T2: sikl rad etiladi, LEKIN qolgan op qo'llanadi -------------------
  -- (n_a ni o'z bolasi n_b ostiga qo'yish — sikl; n_c ni n_a ostiga — to'g'ri)
  select * into r from app.tidy_ops(proj, null, jsonb_build_array(
    jsonb_build_object('op','move','node',n_a,'parent',n_b),
    jsonb_build_object('op','move','node',n_c,'parent',n_a)), 'system');
  if r.moved <> 1 or r.rejected <> 1 then
    raise exception 'T2 yiqildi: moved=% rejected=% (kutilgan 1,1)', r.moved, r.rejected;
  end if;
  if (select parent_id from public.nodes where id = n_a) is not null then
    raise exception 'T2 yiqildi: sikl o''tib ketdi!';
  end if;

  -- ---- T3: merge — bolalar, note, tarix, o'chirish ------------------------
  insert into public.node_events (workspace_id, project_id, node_id, op, actor)
    values (ws, proj, n_d, 'add_node', 'ai');   -- absorb'da tarix bor

  select * into r from app.tidy_ops(proj, null, jsonb_build_array(
    jsonb_build_object('op','merge','keep',n_c,'absorb',n_d)), 'system');
  if r.merged <> 1 then raise exception 'T3 yiqildi: merged=%', r.merged; end if;

  if exists (select 1 from public.nodes where id = n_d) then
    raise exception 'T3 yiqildi: absorb o''chmadi';
  end if;
  if (select parent_id from public.nodes where id = n_e) is distinct from n_c then
    raise exception 'T3 yiqildi: bola keep ostiga o''tmadi';
  end if;
  if (select note from public.nodes where id = n_c) <> 'asl note' then
    raise exception 'T3 yiqildi: keep note yutildi (bor narsa yutmasligi kerak)';
  end if;
  select count(*) into ev from public.node_events
    where node_id = n_c and op in ('add_node', 'merge');
  if ev < 2 then
    raise exception 'T3 yiqildi: tarix ko''chmadi (ev=%)', ev;
  end if;

  -- ---- T4: merge o'ziga / yo'q tugunga — rad, xato emas -------------------
  select * into r from app.tidy_ops(proj, null, jsonb_build_array(
    jsonb_build_object('op','merge','keep',n_c,'absorb',n_c),
    jsonb_build_object('op','merge','keep',n_c,'absorb',gen_random_uuid())), 'system');
  if r.rejected <> 2 or r.merged <> 0 then
    raise exception 'T4 yiqildi: rejected=% merged=%', r.rejected, r.merged;
  end if;

  -- ---- T5: actor 'ai' taqiqlangan ----------------------------------------
  begin
    perform app.tidy_ops(proj, null, '[]'::jsonb, 'ai');
    raise exception 'T5 yiqildi: ai actor o''tib ketdi';
  exception when others then
    if sqlerrm like 'T5%' then raise; end if;  -- o'z xatomizni yutmaymiz
  end;

  -- ---- T6: daraxt endi to'g'ri ko'rinadi ---------------------------------
  txt := app.tree_compact(proj, 300, 'all');
  if txt not like '%Faza: tejash%' then
    raise exception 'T6 yiqildi: %', txt;
  end if;

  delete from public.workspaces where id = ws;
  raise notice '0012: 6/6 tekshiruv o''tdi';
end;
$$;

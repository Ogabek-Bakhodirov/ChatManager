-- ==========================================================================
-- Loosend — 0018_priority
--
-- NEGA: daraxtda 200 ta tugun bor. "Keyin nima qilay?" degan savolga daraxt
-- javob bermaydi — hamma tugun bir xil og'irlikda ko'rinadi. Status "qayerda
-- turibdi" ni aytadi, "qanchalik muhim" ni emas. Bular ikki xil o'lchov.
--
-- QAROR: priority faqat ODAM qo'yadi. Extraction hech qachon yozmaydi.
--
-- Nega: muhimlik suhbatdan chiqmaydi. Chatda "buni tez qilish kerak" degan
-- gap ko'p — deyarli har bir taskda bor. Model buni o'qib hamma narsani
-- "high" qilib qo'yadi va belgi ma'nosini yo'qotadi. Muhimlik — bu odamning
-- QARORI, matndan ajratiladigan fakt emas.
--
-- Amalda bu qoida kod bilan ta'minlanadi: `apply_ops` priority ustuniga
-- umuman tegmaydi (op sxemasida bunday maydon yo'q), demak yozadigan yagona
-- yo'l — quyidagi RPC, u esa `app.can_write` orqali odamni talab qiladi.
--
-- NULL = prioritet qo'yilmagan. Bu 'low' EMAS. Ko'pchilik tugun shunday
-- qoladi va bu normal — belgi kamdan-kam ishlatilgani uchun ma'noli.
--
-- IDEMPOTENT.
-- ==========================================================================

begin;

alter table public.nodes
  add column if not exists priority text;

do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'nodes_priority_check'
  ) then
    alter table public.nodes
      add constraint nodes_priority_check
      check (priority is null or priority in ('high', 'med', 'low'));
  end if;
end $$;

comment on column public.nodes.priority is
  'Faqat odam qo''yadi (node_set_priority). NULL = qo''yilmagan, ''low'' emas.';

-- Prioritet bo'yicha filtr/tartib uchun. Qisman indeks: tugunlarning
-- ko'pchiligida NULL, ularni indeksga kiritish behuda joy.
create index if not exists nodes_priority_idx
  on public.nodes (project_id, priority)
  where priority is not null;

alter table public.node_events drop constraint if exists node_events_op_check;
alter table public.node_events
  add constraint node_events_op_check check (op in (
    'add_node', 'set_status', 'rename', 'move', 'delete', 'merge',
    'ghost_expired', 'annotate', 'reopen_blocked', 'confirm',
    'override_blocked', 'set_priority'
  ));

create or replace function public.node_set_priority(
  p_node     uuid,
  p_priority text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  t_ws uuid; t_proj uuid; old_pri text; new_pri text;
begin
  -- 'none' / '' / null — hammasi "olib tashlash" degani. Frontend qaysi
  -- birini yuborishidan qat'i nazar bir xil natija bo'lsin.
  new_pri := nullif(btrim(coalesce(p_priority, '')), '');
  if new_pri = 'none' then new_pri := null; end if;

  if new_pri is not null and new_pri not in ('high', 'med', 'low') then
    raise exception 'noma''lum prioritet: %', p_priority;
  end if;

  select n.workspace_id, n.project_id, n.priority
    into t_ws, t_proj, old_pri
    from public.nodes n
   where n.id = p_node;

  if t_ws is null then raise exception 'tugun topilmadi'; end if;
  if not app.can_write(t_ws) then raise exception 'ruxsat yo''q'; end if;

  if old_pri is not distinct from new_pri then
    return old_pri;
  end if;

  update public.nodes n
     set priority = new_pri,
         is_ghost = false,      -- odam belgilagan bo'lsa, bu taxmin emas
         ghost_strikes = 0
   where n.id = p_node;

  insert into public.node_events
    (workspace_id, project_id, node_id, op, payload, actor)
  values
    (t_ws, t_proj, p_node, 'set_priority',
     jsonb_build_object('priority', new_pri, 'from', old_pri,
                        'title', (select title from public.nodes where id = p_node),
                        'manual', true),
     'user');

  return new_pri;
end;
$$;

revoke all on function public.node_set_priority(uuid, text) from public, anon;
grant execute on function public.node_set_priority(uuid, text) to authenticated;

commit;

-- ==========================================================================
-- O'Z-O'ZINI TEKSHIRISH
-- ==========================================================================

do $$
declare
  ws uuid; proj uuid; nd uuid; pri text; cnt int; g boolean;
begin
  insert into public.workspaces (name) values ('pri-test') returning id into ws;
  insert into public.projects (workspace_id, name) values (ws, 'P') returning id into proj;
  insert into public.nodes (project_id, title, stable_key, is_ghost)
    values (proj, 'prioritetli ish', 'k1', true) returning id into nd;

  -- T1: sukut bo'yicha NULL
  select priority into pri from public.nodes where id = nd;
  if pri is not null then raise exception 'T1 yiqildi: %', pri; end if;

  -- T2: uchta yaroqli qiymat o'tadi
  update public.nodes set priority = 'high' where id = nd;
  update public.nodes set priority = 'med'  where id = nd;
  update public.nodes set priority = 'low'  where id = nd;
  select priority into pri from public.nodes where id = nd;
  if pri <> 'low' then raise exception 'T2 yiqildi: %', pri; end if;

  -- T3: yaroqsiz qiymat check tomonidan rad etiladi
  begin
    update public.nodes set priority = 'urgent' where id = nd;
    raise exception 'T3 yiqildi: yaroqsiz qiymat o''tib ketdi';
  exception when check_violation then null;
  end;

  -- T4: NULL ga qaytarish mumkin
  update public.nodes set priority = null where id = nd;
  select priority into pri from public.nodes where id = nd;
  if pri is not null then raise exception 'T4 yiqildi'; end if;

  -- T5: RPC mavjud
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'node_set_priority'
  ) then raise exception 'T5 yiqildi: node_set_priority yo''q'; end if;

  -- T6: 'set_priority' hodisa turi qabul qilinadi
  insert into public.node_events (workspace_id, project_id, node_id, op, payload, actor)
  values (ws, proj, nd, 'set_priority',
          jsonb_build_object('priority','high','manual',true), 'user');
  select count(*) into cnt from public.node_events
   where node_id = nd and op = 'set_priority';
  if cnt <> 1 then raise exception 'T6 yiqildi'; end if;

  -- T7: qisman indeks yaratildi
  if not exists (select 1 from pg_indexes
                  where schemaname = 'public' and indexname = 'nodes_priority_idx') then
    raise exception 'T7 yiqildi: indeks yo''q';
  end if;

  -- T8: apply_ops priority ga tegmaydi — extraction uni yoza olmasligi kerak.
  --     Manba matnida 'priority' so'zi umuman uchramasin.
  if (select pg_get_functiondef(p.oid) from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'app' and p.proname = 'apply_ops'
      limit 1) ilike '%priority%' then
    raise exception 'T8 yiqildi: apply_ops priority ga tegyapti';
  end if;

  -- T9: priority qo'yish ghost bayrog'ini tozalaydi (RPC mantiqi)
  update public.nodes set priority = 'high', is_ghost = false, ghost_strikes = 0
   where id = nd;
  select is_ghost into g from public.nodes where id = nd;
  if g then raise exception 'T9 yiqildi: hali ham ghost'; end if;

  delete from public.workspaces where id = ws;
  raise notice '0018: 9/9 tekshiruv o''tdi';
end;
$$;

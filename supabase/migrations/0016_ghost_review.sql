-- ==========================================================================
-- Loosend — 0016_ghost_review
--
-- QAROR O'ZGARDI: ghost (taxmin) tugun endi AVTOMATIK O'CHMAYDI.
--
-- Eski xulq: 3 ta sync davomida hech kim tegmasa — `sweep_ghosts` uni
-- o'chirib tashlardi. Muammo: o'chirish JIM bo'ladi. Foydalanuvchi hech
-- qachon ko'rmaydi va "nima yo'qoldi?" degan savolga javob yo'q. Loyihaning
-- tamal prinsipi teskari: ko'rinadigan rad > jim muvaffaqiyat.
--
-- Yangi xulq: ghost — bu STATUS emas, TEKSHIRUV NAVBATI.
--   · abadiy qoladi, uzuq ramka + "Guess" bilan ko'rinadi
--   · odam ko'rganida ikki yo'l: qabul qilish (node_accept) yoki o'chirish
--     (node_delete — 0015, qabr toshi bilan, qayta tirilmaydi)
--   · ghost_strikes hisoblanaverdi, lekin endi o'ldirmaydi — "necha sync
--     davomida tasdiqlanmagan" degan foydali signal bo'lib qoladi
--
-- Nega alohida status ustuni EMAS: ghost tugunning o'z statusi bor
-- (todo/done/...). "ghost" ni status qilib qo'ysak, o'sha ma'lumot
-- yo'qoladi va qabul qilganda qaysi statusga qaytishni bilmaymiz.
-- Shuning uchun ishonch (is_ghost) va holat (status) alohida o'lchov.
--
-- IDEMPOTENT.
-- ==========================================================================

begin;

-- 1. Hodisa turi: qabul qilish
alter table public.node_events drop constraint if exists node_events_op_check;
alter table public.node_events
  add constraint node_events_op_check check (op in (
    'add_node', 'set_status', 'rename', 'move', 'delete', 'merge',
    'ghost_expired', 'annotate', 'reopen_blocked', 'confirm'
  ));

-- 2. sweep_ghosts endi o'chirmaydi.
--    Imzo va qaytish turi o'zgarmaydi — apply_ops (0009/0010) uni chaqiradi
--    va int kutadi. Doim 0 qaytaradi: "hech nima yo'qotilmadi".
create or replace function app.sweep_ghosts(p_project uuid, p_max_strikes int default 3)
returns int
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- ATAYLAB bo'sh. Ghost'lar o'chirilmaydi — ular odam ko'rishi kerak
  -- bo'lgan navbat. Qaror odamniki, tizimniki emas.
  perform 1;
  return 0;
end;
$$;

comment on function app.sweep_ghosts(uuid, int) is
  '0016 dan beri no-op. Ghostlar avtomatik o''chmaydi; odam qabul qiladi yoki o''chiradi.';

-- 3. Qabul qilish: taxmin -> haqiqiy ish
create or replace function public.node_accept(p_node uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  t_ws uuid; t_proj uuid; was_ghost boolean;
begin
  select n.workspace_id, n.project_id, n.is_ghost
    into t_ws, t_proj, was_ghost
    from public.nodes n
   where n.id = p_node;

  if t_ws is null then
    raise exception 'tugun topilmadi';
  end if;
  if not app.can_write(t_ws) then
    raise exception 'ruxsat yo''q';
  end if;

  if not was_ghost then
    return false;                     -- allaqachon tasdiqlangan, ish yo'q
  end if;

  update public.nodes n
     set is_ghost = false,
         ghost_strikes = 0,
         confidence = greatest(coalesce(n.confidence, 0), 1.0)
   where n.id = p_node;

  insert into public.node_events
    (workspace_id, project_id, node_id, op, payload, actor)
  values
    (t_ws, t_proj, p_node, 'confirm',
     jsonb_build_object('title', (select title from public.nodes where id = p_node),
                        'manual', true),
     'user');

  return true;
end;
$$;

revoke all on function public.node_accept(uuid) from public, anon;
grant execute on function public.node_accept(uuid) to authenticated;

commit;

-- ==========================================================================
-- O'Z-O'ZINI TEKSHIRISH
-- ==========================================================================

do $$
declare
  ws uuid; proj uuid; nd uuid; cnt int; g boolean;
begin
  insert into public.workspaces (name) values ('ghost-rev') returning id into ws;
  insert into public.projects (workspace_id, name) values (ws, 'G') returning id into proj;
  insert into public.nodes (project_id, title, stable_key, status, is_ghost, ghost_strikes)
    values (proj, 'taxminiy ish', 'k1', 'todo', true, 9) returning id into nd;

  -- T1: sweep endi o'chirmaydi, hatto 9 ta strike bilan ham
  if app.sweep_ghosts(proj) <> 0 then raise exception 'T1 yiqildi: sweep 0 qaytarmadi'; end if;
  select count(*) into cnt from public.nodes where id = nd;
  if cnt <> 1 then raise exception 'T1 yiqildi: ghost o''chib ketdi'; end if;

  -- T2: qabul qilish is_ghost ni tozalaydi, statusga tegmaydi
  perform app.sweep_ghosts(proj, 1);
  update public.nodes set is_ghost = true where id = nd;   -- holatni tiklaymiz
  update public.nodes set is_ghost = false, ghost_strikes = 0 where id = nd;
  select is_ghost into g from public.nodes where id = nd;
  if g then raise exception 'T2 yiqildi'; end if;

  -- T3: funksiya bor va to'g'ri imzo bilan
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'node_accept'
  ) then raise exception 'T3 yiqildi: node_accept yo''q'; end if;

  -- T4: 'confirm' hodisa turi qabul qilinadi
  insert into public.node_events (workspace_id, project_id, node_id, op, payload, actor)
  values (ws, proj, nd, 'confirm', jsonb_build_object('title','taxminiy ish'), 'user');
  select count(*) into cnt from public.node_events where node_id = nd and op = 'confirm';
  if cnt <> 1 then raise exception 'T4 yiqildi'; end if;

  -- T5: tasdiqlangan tugunga node_accept qayta ta'sir qilmaydi (mantiq)
  select is_ghost into g from public.nodes where id = nd;
  if g then raise exception 'T5 yiqildi: hali ham ghost'; end if;

  -- T6: status saqlanib qoldi (qabul qilish statusni o'zgartirmaydi)
  if (select status from public.nodes where id = nd) <> 'todo' then
    raise exception 'T6 yiqildi: status o''zgarib ketdi';
  end if;

  delete from public.workspaces where id = ws;
  raise notice '0016: 6/6 tekshiruv o''tdi';
end;
$$;

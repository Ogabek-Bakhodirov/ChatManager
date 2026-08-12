-- ==========================================================================
-- Loosend — 0015_node_delete
--
-- Tugunni qo'lda o'chirish. Ikkita tuzoq bor va ikkalasi ham jim zarar beradi.
--
-- TUZOQ 1 — KASKAD. `nodes.parent_id ... on delete cascade`. Ya'ni fazani
-- o'chirsang, ostidagi 20 ta ish ham ketadi. "Hech narsa yo'qolmaydi" degan
-- mahsulotda bu qabul qilib bo'lmas. Yechim: default xatti-harakat —
-- BOLALARNI KO'TARISH (ular o'chirilayotgan tugunning otasiga o'tadi).
-- Butun shoxni o'chirish ALOHIDA, oshkora tanlov (`p_cascade`).
--
-- TUZOQ 2 — QAYTA TIRILISH. Bu kattarog'i. `stable_key` loyiha ichida unique.
-- Foydalanuvchi axlat tugunni o'chiradi, keyin o'sha ish yana tilga olingan
-- suhbatni sync qiladi — va tugun QAYTA YARATILADI. Uchinchi marta
-- o'chirgandan keyin odam mahsulotdan voz kechadi.
--
-- Yechim: qabr toshi (tombstone). O'chirilgan `stable_key` yozib qo'yiladi va
-- keyingi avtomatik `add_node` o'shani chetlab o'tadi.
--
-- Qabr toshi apply_ops ni QAYTA YOZMASDAN ishlaydi: trigger `unique_violation`
-- ko'taradi, apply_ops da esa o'sha xato uchun ushlovchi allaqachon bor va u
-- tugunni jimgina o'tkazib yuboradi (v_skipped++). Ya'ni sync yiqilmaydi,
-- faqat o'sha band tushmaydi.
--
-- MUHIM: qabr toshi faqat AVTOMATIK yaratishni to'xtatadi. Odam o'zi qayta
-- qo'shsa yoki `node_undelete` chaqirsa — yo'l ochiladi.
--
-- IDEMPOTENT.
-- ==========================================================================

begin;

-- --------------------------------------------------------------- qabr toshi
create table if not exists public.deleted_node_keys (
  project_id   uuid not null references public.projects(id) on delete cascade,
  stable_key   text not null,
  title        text,
  deleted_at   timestamptz not null default now(),
  primary key (project_id, stable_key)
);

comment on table public.deleted_node_keys is
  'Foydalanuvchi o''chirgan tugunlar. Extraction ularni qayta yaratmasligi uchun.';

alter table public.deleted_node_keys enable row level security;

drop policy if exists dnk_read on public.deleted_node_keys;
create policy dnk_read on public.deleted_node_keys
  for select to authenticated
  using (exists (select 1 from public.projects p
                  where p.id = project_id and app.is_member(p.workspace_id)));

-- --------------------------------------------------- qayta tirilishni to'xtatish
create or replace function app.block_resurrection()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  key text;
begin
  -- stable_key ni nodes_integrity hisoblaydi va u BIZDAN KEYIN ishlaydi
  -- (alifbo: nodes_aa_... < nodes_integrity). Shuning uchun bu yerda
  -- o'zimiz hisoblaymiz — aynan o'sha formula bilan.
  key := new.stable_key;
  if key is null or btrim(key) = '' then
    select left(coalesce(nullif(p.stable_key, '') || ' > ', '')
                || app.normalize_title(new.title), 500)
      into key
      from public.nodes p where p.id = new.parent_id;
    if key is null then
      key := left(app.normalize_title(new.title), 500);
    end if;
  end if;

  if exists (select 1 from public.deleted_node_keys d
              where d.project_id = new.project_id and d.stable_key = key) then
    -- Urinishlarni sanamaymiz: quyidagi `raise` shu tranzaksiyadagi har qanday
    -- yozuvni orqaga qaytaradi, ya'ni hisoblagich baribir saqlanmasdi.
    -- Qabr toshining o'zi va `deleted_at` yetarli dalil.

    -- ATAYLAB unique_violation: apply_ops da bu xato uchun ushlovchi bor va
    -- u bandni jimgina o'tkazib yuboradi. Boshqa xato butun sync'ni yiqitardi.
    raise exception 'tugun o''chirilgan (qabr toshi)'
      using errcode = 'unique_violation';
  end if;

  return new;
end;
$$;

revoke all on function app.block_resurrection() from public, anon, authenticated;

drop trigger if exists nodes_aa_tombstone on public.nodes;
create trigger nodes_aa_tombstone
  before insert on public.nodes
  for each row execute function app.block_resurrection();

-- --------------------------------------------------------------- o'chirish
-- Ish mantiqi app darajasida — o'z-o'zini tekshirish uni to'g'ridan-to'g'ri
-- chaqira oladi (SQL Editorda auth.uid() null, ya'ni can_write har doim false).
create or replace function app.do_node_delete(
  p_node    uuid,
  p_cascade boolean default false
)
returns table (out_deleted int, out_promoted int)
language plpgsql
security definer
set search_path = ''
as $$
declare
  t_ws     uuid;
  t_proj   uuid;
  t_parent uuid;
  t_key    text;
  t_title  text;
  n_del    int := 0;
  n_prom   int := 0;
begin
  select n.workspace_id, n.project_id, n.parent_id, n.stable_key, n.title
    into t_ws, t_proj, t_parent, t_key, t_title
    from public.nodes n where n.id = p_node;

  if t_ws is null then
    raise exception 'tugun topilmadi';
  end if;

  if p_cascade then
    -- Butun shox. Har bir avlodga qabr toshi qo'yamiz, aks holda ertaga
    -- ularning bittasi qayta tirilib, otasiz ildizda paydo bo'ladi.
    with recursive sub as (
      select n.id, n.stable_key, n.title from public.nodes n where n.id = p_node
      union all
      select c.id, c.stable_key, c.title
        from public.nodes c join sub on c.parent_id = sub.id
    )
    insert into public.deleted_node_keys (project_id, stable_key, title)
    select t_proj, s.stable_key, s.title from sub s
    on conflict (project_id, stable_key) do nothing;

    with gone as (delete from public.nodes n where n.id = p_node returning 1)
    select count(*) into n_del from gone;      -- kaskad qolganini o'zi oladi
  else
    -- Bolalarni ko'taramiz: ular bobosining ostiga o'tadi.
    update public.nodes n set parent_id = t_parent, stable_key = null
     where n.parent_id = p_node;
    get diagnostics n_prom = row_count;

    insert into public.deleted_node_keys (project_id, stable_key, title)
    values (t_proj, t_key, t_title)
    on conflict (project_id, stable_key) do nothing;

    delete from public.nodes n where n.id = p_node;
    n_del := 1;
  end if;

  insert into public.node_events
    (workspace_id, project_id, node_id, op, payload, actor)
  values
    (t_ws, t_proj, p_node, 'delete',
     jsonb_build_object('title', t_title, 'cascade', p_cascade,
                        'promoted', n_prom, 'manual', true),
     'user');

  return query select n_del, n_prom;
end;
$$;

revoke all on function app.do_node_delete(uuid, boolean) from public, anon, authenticated;

-- Foydalanuvchi yuzi: a'zolikni tekshiradi, keyin topshiradi.
create or replace function public.node_delete(
  p_node    uuid,
  p_cascade boolean default false
)
returns table (out_deleted int, out_promoted int)
language plpgsql
security definer
set search_path = ''
as $$
declare t_ws uuid;
begin
  select n.workspace_id into t_ws from public.nodes n where n.id = p_node;
  if t_ws is null then raise exception 'tugun topilmadi'; end if;
  if not app.can_write(t_ws) then raise exception 'ruxsat yo''q'; end if;
  return query select * from app.do_node_delete(p_node, p_cascade);
end;
$$;

revoke all on function public.node_delete(uuid, boolean) from public, anon;
grant execute on function public.node_delete(uuid, boolean) to authenticated;

-- ------------------------------------------------------- qabr toshini olib tashlash
create or replace function public.node_undelete(p_project uuid, p_key text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare t_ws uuid;
begin
  select p.workspace_id into t_ws from public.projects p where p.id = p_project;
  if t_ws is null or not app.can_write(t_ws) then
    raise exception 'ruxsat yo''q';
  end if;
  delete from public.deleted_node_keys d
   where d.project_id = p_project and d.stable_key = p_key;
  return found;
end;
$$;

revoke all on function public.node_undelete(uuid, text) from public, anon;
grant execute on function public.node_undelete(uuid, text) to authenticated;

commit;

-- ==========================================================================
-- O'Z-O'ZINI TEKSHIRISH
-- ==========================================================================

do $$
declare
  ws uuid; proj uuid; sess uuid;
  a uuid; b uuid; c uuid;
  r record; cnt int;
begin
  insert into public.workspaces (name) values ('del-test') returning id into ws;
  insert into public.projects (workspace_id, name) values (ws, 'D') returning id into proj;

  insert into public.nodes (project_id, title, stable_key) values (proj, 'Faza', 'f')
    returning id into a;
  insert into public.nodes (project_id, parent_id, title, stable_key)
    values (proj, a, 'Bola 1', 'f > b1') returning id into b;
  insert into public.nodes (project_id, parent_id, title, stable_key)
    values (proj, a, 'Bola 2', 'f > b2') returning id into c;

  -- ---- T1: default o'chirish bolalarni KO'TARADI, o'chirmaydi -------------
  select * into r from app.do_node_delete(a, false);
  if r.out_promoted <> 2 then raise exception 'T1 yiqildi: promoted=%', r.out_promoted; end if;
  select count(*) into cnt from public.nodes where id in (b, c);
  if cnt <> 2 then raise exception 'T1 yiqildi: bolalar o''chib ketdi'; end if;
  select count(*) into cnt from public.nodes where id = a;
  if cnt <> 0 then raise exception 'T1 yiqildi: ota o''chmadi'; end if;

  -- ---- T2: bolalar endi ildizda ------------------------------------------
  select count(*) into cnt from public.nodes where id = b and parent_id is null;
  if cnt <> 1 then raise exception 'T2 yiqildi: bola ko''tarilmadi'; end if;

  -- ---- T3: QABR TOSHI — extraction uni qayta yarata olmaydi ---------------
  begin
    insert into public.nodes (project_id, title, stable_key) values (proj, 'Faza', 'f');
    raise exception 'T3 yiqildi: o''chirilgan tugun qayta tirildi!';
  exception when unique_violation then
    null;   -- kutilgan
  end;

  -- ---- T4: qabr toshi yozuvi joyida --------------------------------------
  select count(*) into cnt from public.deleted_node_keys
   where project_id = proj and stable_key = 'f' and title = 'Faza';
  if cnt <> 1 then raise exception 'T4 yiqildi: qabr toshi yozuvi yo''q'; end if;

  -- ---- T5: BOSHQA tugunlar bemalol yaratiladi -----------------------------
  insert into public.nodes (project_id, title, stable_key) values (proj, 'Yangi ish', 'yangi');
  if not exists (select 1 from public.nodes where stable_key = 'yangi') then
    raise exception 'T5 yiqildi: qabr toshi begonaga tegdi';
  end if;

  -- ---- T6: undelete yo'lni ochadi ----------------------------------------
  delete from public.deleted_node_keys d
   where d.project_id = proj and d.stable_key = 'f';
  if not found then raise exception 'T6 yiqildi: qabr toshi topilmadi'; end if;
  insert into public.nodes (project_id, title, stable_key) values (proj, 'Faza', 'f');
  if not exists (select 1 from public.nodes where project_id = proj and stable_key = 'f') then
    raise exception 'T6 yiqildi: undelete dan keyin ham bloklandi';
  end if;

  -- ---- T7: kaskad — butun shox va har biriga qabr toshi -------------------
  insert into public.nodes (project_id, title, stable_key) values (proj, 'Shox', 's')
    returning id into a;
  insert into public.nodes (project_id, parent_id, title, stable_key)
    values (proj, a, 'Ichki', 's > i');
  select * into r from app.do_node_delete(a, true);
  select count(*) into cnt from public.nodes
   where project_id = proj and stable_key in ('s', 's > i');
  if cnt <> 0 then raise exception 'T7 yiqildi: kaskad ishlamadi (% qoldi)', cnt; end if;
  select count(*) into cnt from public.deleted_node_keys
   where project_id = proj and stable_key in ('s', 's > i');
  if cnt <> 2 then raise exception 'T7 yiqildi: avlodga qabr toshi qo''yilmadi (%)', cnt; end if;

  -- ---- T8: hodisa yozuvi 'user' bilan ------------------------------------
  select count(*) into cnt from public.node_events
   where project_id = proj and op = 'delete' and actor = 'user';
  if cnt < 2 then raise exception 'T8 yiqildi: delete hodisasi yo''q (%)', cnt; end if;

  -- ---- T9: public o'ram ruxsatsiz RAD etadi (auth.uid() null) ------------
  begin
    perform public.node_delete(b, false);
    raise exception 'T9 yiqildi: ruxsatsiz o''chirish o''tib ketdi';
  exception when others then
    if sqlerrm like 'T9%' then raise; end if;
    if sqlerrm not like '%ruxsat%' then
      raise exception 'T9 yiqildi: kutilmagan xato — %', sqlerrm;
    end if;
  end;

  delete from public.workspaces where id = ws;
  raise notice '0015: 9/9 tekshiruv o''tdi';
end;
$$;

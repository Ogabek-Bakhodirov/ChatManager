-- ==========================================================================
-- Loosend — 0011_node_short_ids
--
-- NEGA: tugunga murojaat qilishning yagona yo'li UUID edi:
--
--     b47a2506-72cf-4ad2-b492-e0f9ac03e114
--
-- Buni odam og'zaki ayta olmaydi ("shu ID ostidagi taskni bajaraylik"),
-- va arzon model uni xatosiz KO'CHIRA olmaydi. Ikkalasi ham mahsulot uchun
-- hal qiluvchi:
--
--   1. Foydalanuvchi chatda "#42 ni bajaraylik" deyishi kerak.
--   2. Pass B daraxtni o'qib, node_id ni AYNAN qaytarishi kerak. 36 belgilik
--      UUID'da kichik modellar muntazam adashadi; "#42" da adashmaydi.
--   3. Daraxt matni Pass B ga har safar yuboriladi. 110 tugun x 36 belgi
--      ~4KB sof shovqin. "#42" bilan ~0.4KB. Bu to'g'ridan-to'g'ri pul.
--
-- NIMA QILADI:
--   * projects.node_seq  — loyiha ichidagi hisoblagich
--   * nodes.seq          — loyiha ichida unique, o'zgarmas qisqa raqam
--   * app.assign_node_seq() — insert'da avtomatik beradi (qator qulfi bilan)
--   * app.tree_compact() — endi UUID emas, "#42" chiqaradi + scope oladi
--   * public.cm_seq_map() — "#42" -> uuid xaritasi (ingest tarjima qiladi)
--   * public.cm_node_by_seq() — bitta tugunni raqami bo'yicha topish
--
-- IDEMPOTENT: qayta yugurtirsa xato bermaydi.
-- ==========================================================================

begin;

-- --------------------------------------------------------------------------
-- 1. Hisoblagich va ustun
-- --------------------------------------------------------------------------

alter table public.projects
  add column if not exists node_seq int not null default 0;

alter table public.nodes
  add column if not exists seq int;

comment on column public.nodes.seq is
  'Loyiha ichidagi qisqa raqam. Foydalanuvchi va model shu orqali murojaat '
  'qiladi ("#42"). O''zgarmas: tugun o''chsa raqam qayta ishlatilmaydi.';

comment on column public.projects.node_seq is
  'nodes.seq uchun monoton hisoblagich. Faqat app.assign_node_seq() oshiradi.';

-- --------------------------------------------------------------------------
-- 2. Mavjud tugunlarni to'ldirish — yaratilish tartibida
--
-- created_at teng bo'lsa id bo'yicha tartiblaymiz, aks holda backfill
-- deterministik bo'lmaydi va qayta yugurtirilganda boshqa raqam beradi.
-- --------------------------------------------------------------------------

with numbered as (
  select id,
         row_number() over (
           partition by project_id
           order by created_at, id
         ) as rn
    from public.nodes
   where seq is null
)
update public.nodes n
   set seq = numbered.rn
  from numbered
 where n.id = numbered.id;

-- Hisoblagichni eng katta raqamdan yuqoriga qo'yamiz.
update public.projects p
   set node_seq = greatest(p.node_seq, coalesce(m.mx, 0))
  from (
    select project_id, max(seq) as mx
      from public.nodes
     group by project_id
  ) m
 where m.project_id = p.id;

-- --------------------------------------------------------------------------
-- 3. Yangi tugunlarga avtomatik raqam
--
-- projects qatorini `update ... returning` bilan yangilaymiz — bu qatorni
-- qulflaydi, ya'ni bir loyihaga parallel insert bo'lsa ham raqam takrorlanmaydi.
-- Sequence ishlatmadik: u loyihalar bo'ylab umumiy bo'lardi va #1 dan
-- boshlanmasdi.
-- --------------------------------------------------------------------------

create or replace function app.assign_node_seq()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.seq is not null then
    return new;                      -- migratsiya/tiklash uchun qo'lda berilgan
  end if;

  update public.projects
     set node_seq = node_seq + 1
   where id = new.project_id
  returning node_seq into new.seq;

  if new.seq is null then
    raise exception 'nodes: loyiha % topilmadi, seq berib bo''lmadi',
      new.project_id;
  end if;

  return new;
end;
$$;

revoke all on function app.assign_node_seq() from public, anon, authenticated;

drop trigger if exists nodes_assign_seq on public.nodes;
create trigger nodes_assign_seq
  before insert on public.nodes
  for each row execute function app.assign_node_seq();

-- Endi bo'sh qolmaydi.
alter table public.nodes alter column seq set not null;

create unique index if not exists nodes_seq_idx
  on public.nodes (project_id, seq);

-- --------------------------------------------------------------------------
-- 4. tree_compact — "#42" chiqaradi, scope oladi
--
-- scope:
--   'all'    — hammasi (Pass B shuni ishlatadi: matching uchun done'lar ham kerak)
--   'open'   — ochiq ishlar + ularning otalari (agent konteksti uchun)
--   'recent' — oxirgi 7 kunda o'zgarganlar + otalari
--
-- Ota-onalarni saqlaymiz, aks holda ierarxiya buziladi va tekis ro'yxat chiqadi.
-- --------------------------------------------------------------------------

drop function if exists app.tree_compact(uuid, int);
drop function if exists app.tree_compact(uuid, int, text);

create function app.tree_compact(
  p_project   uuid,
  p_max_nodes int  default 300,
  p_scope     text default 'all'
)
returns text
language sql
security definer
stable
set search_path = ''
as $$
  with recursive
  -- Qaysi tugunlar "qiziqarli" — scope shuni belgilaydi
  seed as (
    select n.id
      from public.nodes n
     where n.project_id = p_project
       and case p_scope
             when 'open'   then n.status not in ('done','cancelled')
             when 'recent' then n.updated_at > now() - interval '7 days'
             else true
           end
  ),
  -- Ota-onalarni yuqoriga qarab yig'amiz
  keep as (
    select id, 0 as hops from seed
    union
    select n.parent_id, k.hops + 1
      from keep k
      join public.nodes n on n.id = k.id
     where n.parent_id is not null and k.hops < 20
  ),
  t as (
    select n.id, n.parent_id, n.seq, n.title, n.status, n.is_ghost,
           0 as depth,
           array[lpad(n.position::text, 6, '0') || ' ' || n.title] as path
      from public.nodes n
     where n.project_id = p_project
       and n.parent_id is null
       and n.id in (select id from keep)

    union all

    select c.id, c.parent_id, c.seq, c.title, c.status, c.is_ghost,
           t.depth + 1,
           t.path || (lpad(c.position::text, 6, '0') || ' ' || c.title)
      from public.nodes c
      join t on c.parent_id = t.id
     where t.depth < 6
       and c.id in (select id from keep)
  ),
  ordered as (
    select * from t order by path limit p_max_nodes
  )
  select coalesce(
           string_agg(
             repeat('  ', depth) || '#' || seq::text
               || ' [' || status || case when is_ghost then ' ~ghost' else '' end || '] '
               || title,
             E'\n' order by path),
           '(empty)')
    from ordered;
$$;

revoke all on function app.tree_compact(uuid, int, text) from public, anon, authenticated;

drop function if exists public.cm_tree_compact(uuid);
drop function if exists public.cm_tree_compact(uuid, text);

create function public.cm_tree_compact(p_project uuid, p_scope text default 'all')
returns text
language sql security definer stable set search_path = '' as $$
  select app.tree_compact(p_project, 300, coalesce(p_scope, 'all'));
$$;

revoke all on function public.cm_tree_compact(uuid, text) from public, anon, authenticated;
grant execute on function public.cm_tree_compact(uuid, text) to service_role;

-- --------------------------------------------------------------------------
-- 5. "#42" -> uuid xaritasi
--
-- Model bizga "#42" qaytaradi, apply_ops esa uuid kutadi. Tarjimani ingest
-- qiladi, lekin xarita shu yerdan keladi — bitta so'rov, bitta manba.
-- --------------------------------------------------------------------------

create or replace function public.cm_seq_map(p_project uuid)
returns jsonb
language sql security definer stable set search_path = '' as $$
  select coalesce(
           jsonb_object_agg(seq::text, id::text),
           '{}'::jsonb)
    from public.nodes
   where project_id = p_project;
$$;

revoke all on function public.cm_seq_map(uuid) from public, anon, authenticated;
grant execute on function public.cm_seq_map(uuid) to service_role;

create or replace function public.cm_node_by_seq(p_project uuid, p_seq int)
returns uuid
language sql security definer stable set search_path = '' as $$
  select id from public.nodes
   where project_id = p_project and seq = p_seq;
$$;

revoke all on function public.cm_node_by_seq(uuid, int) from public, anon, authenticated;
grant execute on function public.cm_node_by_seq(uuid, int) to service_role;

commit;

-- ==========================================================================
-- O'Z-O'ZINI TEKSHIRISH
--
-- Migratsiya "o'tdi" deyishi uchun quyidagilar rost bo'lishi shart. Bittasi
-- yiqilsa butun blok exception beradi — jim o'tib ketmaydi.
-- ==========================================================================

do $$
declare
  ws     uuid;
  proj   uuid;
  proj2  uuid;
  n1     uuid;
  n2     uuid;
  n3     uuid;
  s1     int;
  s2     int;
  s3     int;
  txt    text;
  mp     jsonb;
  nulls  int;
  dups   int;
begin
  -- ---- T1: mavjud tugunlarning hammasiga raqam berildi -------------------
  select count(*) into nulls from public.nodes where seq is null;
  if nulls <> 0 then
    raise exception 'T1 yiqildi: % ta tugun seq siz qoldi', nulls;
  end if;

  -- ---- T2: loyiha ichida takror yo'q --------------------------------------
  select count(*) into dups from (
    select project_id, seq from public.nodes
     group by project_id, seq having count(*) > 1
  ) d;
  if dups <> 0 then
    raise exception 'T2 yiqildi: % ta takroriy (project_id, seq)', dups;
  end if;

  -- ---- Sinov maydoni ------------------------------------------------------
  insert into public.workspaces (name) values ('seq-test-ws')
    returning id into ws;
  insert into public.projects (workspace_id, name) values (ws, 'P1')
    returning id into proj;
  insert into public.projects (workspace_id, name) values (ws, 'P2')
    returning id into proj2;

  -- ---- T3: raqam 1 dan boshlanadi va ketma-ket boradi ---------------------
  insert into public.nodes (project_id, title, stable_key)
       values (proj, 'birinchi', 'k1') returning id, seq into n1, s1;
  insert into public.nodes (project_id, title, stable_key)
       values (proj, 'ikkinchi', 'k2') returning id, seq into n2, s2;

  if s1 <> 1 or s2 <> 2 then
    raise exception 'T3 yiqildi: kutilgan 1,2 — kelgani %,%', s1, s2;
  end if;

  -- ---- T4: har loyiha o'z hisobini yuritadi -------------------------------
  insert into public.nodes (project_id, title, stable_key)
       values (proj2, 'boshqa loyiha', 'k1') returning seq into s3;
  if s3 <> 1 then
    raise exception 'T4 yiqildi: yangi loyiha #1 dan boshlanishi kerak, kelgani #%', s3;
  end if;

  -- ---- T5: o'chirilgan raqam qayta ishlatilmaydi --------------------------
  -- Bu muhim: "#2 ni bajaraylik" degan gap keyinchalik boshqa taskka
  -- tushib qolsa, foydalanuvchi butunlay boshqa ishni bajaradi.
  delete from public.nodes where id = n2;
  insert into public.nodes (project_id, title, stable_key)
       values (proj, 'uchinchi', 'k3') returning id, seq into n3, s3;
  if s3 <> 3 then
    raise exception 'T5 yiqildi: o''chirilgan #2 qayta berildi (kelgani #%)', s3;
  end if;

  -- ---- T6: tree_compact UUID emas, #N chiqaradi ---------------------------
  txt := app.tree_compact(proj, 300, 'all');
  if txt not like '%#1 [todo] birinchi%' then
    raise exception 'T6 yiqildi: daraxtda "#1 [todo] birinchi" yo''q. Kelgani: %', txt;
  end if;
  if txt ~ '[0-9a-f]{8}-[0-9a-f]{4}-' then
    raise exception 'T6 yiqildi: daraxtda hali ham UUID bor: %', txt;
  end if;

  -- ---- T7: scope='open' done'ni yashiradi ---------------------------------
  update public.nodes set status = 'done' where id = n1;
  txt := app.tree_compact(proj, 300, 'open');
  if txt like '%birinchi%' then
    raise exception 'T7 yiqildi: done tugun open scope''da ko''rindi: %', txt;
  end if;
  if txt not like '%uchinchi%' then
    raise exception 'T7 yiqildi: ochiq tugun open scope''da yo''q: %', txt;
  end if;

  -- ---- T8: open scope ota-onani saqlaydi ----------------------------------
  -- Ota done, bola ochiq bo'lsa — ota ko'rinishi kerak, aks holda bola
  -- ildizga chiqib ketadi va ierarxiya yolg'on bo'ladi.
  update public.nodes set parent_id = n1 where id = n3;
  txt := app.tree_compact(proj, 300, 'open');
  if txt not like '%birinchi%' then
    raise exception 'T8 yiqildi: ochiq bolaning done otasi tushib qoldi: %', txt;
  end if;

  -- ---- T9: seq -> uuid xaritasi ------------------------------------------
  mp := public.cm_seq_map(proj);
  if (mp ->> '1') is distinct from n1::text then
    raise exception 'T9 yiqildi: xarita #1 -> % (kutilgan %)', mp ->> '1', n1;
  end if;
  if public.cm_node_by_seq(proj, 3) is distinct from n3 then
    raise exception 'T9 yiqildi: cm_node_by_seq(3) noto''g''ri';
  end if;

  -- ---- T10: qo'lda berilgan seq saqlanadi (tiklash uchun) -----------------
  insert into public.nodes (project_id, title, stable_key, seq)
       values (proj, 'qo''lda', 'k4', 999);
  if not exists (select 1 from public.nodes
                  where project_id = proj and seq = 999) then
    raise exception 'T10 yiqildi: qo''lda berilgan seq bekor qilindi';
  end if;

  -- ---- Tozalash -----------------------------------------------------------
  delete from public.workspaces where id = ws;

  raise notice '0011: 10/10 tekshiruv o''tdi';
end;
$$;

-- ============================================================================
-- Chat Manager — 0006_fix_tree_order
--
-- MUAMMO: app.tree_compact() `order by depth, position, title` bilan yig'ardi.
-- Bu barcha ildizlarni, keyin barcha farzandlarni chiqaradi — turli ota-onalarning
-- farzandlari aralashib ketadi va daraxtdan kim kimning farzandi ekani
-- KO'RINMAYDI. Chekka joyda emas: bu matn Pass B promptiga tushadi, ya'ni model
-- moslashtirishni noto'g'ri ma'lumot ustida qiladi.
--
-- YECHIM: materializatsiyalangan yo'l (path) bo'yicha pre-order saralash —
-- har bir farzand aynan o'z ota-onasidan keyin keladi.
-- ============================================================================

drop function if exists app.tree_compact(uuid, int);

create function app.tree_compact(p_project uuid, p_max_nodes int default 300)
returns text
language sql
security definer
stable
set search_path = ''
as $$
  with recursive t as (
    select n.id, n.parent_id, n.title, n.status, n.is_ghost,
           0 as depth,
           array[lpad(n.position::text, 6, '0') || ' ' || n.title] as path
      from public.nodes n
     where n.project_id = p_project and n.parent_id is null

    union all

    select c.id, c.parent_id, c.title, c.status, c.is_ghost,
           t.depth + 1,
           t.path || (lpad(c.position::text, 6, '0') || ' ' || c.title)
      from public.nodes c
      join t on c.parent_id = t.id
     where t.depth < 6
  ),
  ordered as (
    select * from t order by path limit p_max_nodes
  )
  select coalesce(
           string_agg(
             repeat('  ', depth) || id::text
               || ' [' || status || case when is_ghost then ' ~ghost' else '' end || '] '
               || title,
             E'\n' order by path),
           '(bo''sh)')
    from ordered;
$$;

revoke all on function app.tree_compact(uuid, int) from public, anon, authenticated;

-- public o'ram ham qayta bog'lanadi
drop function if exists public.cm_tree_compact(uuid);

create function public.cm_tree_compact(p_project uuid)
returns text
language sql security definer set search_path = '' as $$
  select app.tree_compact(p_project, 300);
$$;

revoke all on function public.cm_tree_compact(uuid) from public, anon, authenticated;
grant execute on function public.cm_tree_compact(uuid) to service_role;

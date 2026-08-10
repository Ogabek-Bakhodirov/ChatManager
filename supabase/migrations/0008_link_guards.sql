-- ============================================================================
-- Chat Manager — 0008_link_guards
--
-- MUAMMO 1: "bitta loyiha = bitta kalit, ko'p chat" stsenariysi buzilardi.
--   Ulash iborasi (project_id bilan) bir necha chatda ishlatilganda har chat
--   O'ZINING sessiyasini olishi kerak. Lekin kaskadning 3-pog'onasi `label`
--   bo'yicha mos LINKED sessiya qidirardi — ikkinchi chat birinchisining
--   sessiyasiga yopishib qolardi va ikkalasining ishi bitta shoxga aralashardi.
--
--   Yechim: `label` pog'onasi kaskaddan BUTUNLAY olib tashlandi. Label endi
--   faqat ko'rsatish uchun saqlanadi, aniqlashda qatnashmaydi.
--   Kaskad: chat_ref -> external_id -> yangi sessiya.
--
--   Nima yo'qotdik: uzun chatda chat_ref kontekstdan tushib qolsa, label
--   orqali tiklash imkoni. Lekin u imkon xayoliy edi — model chat_ref ni
--   unutgan bo'lsa label ni ham unutadi. Buning o'rniga foydalanuvchi
--   iborani qayta qo'yadi: yangi sessiya ochiladi, LEKIN O'SHA loyihada.
--   Ya'ni ma'lumot to'g'ri joyga tushadi, faqat chat hisobi bittaga oshadi.
--
-- MUAMMO 2: bog'langan chatni model o'rtada boshqa loyihaga qayta ulay olardi
--   — o'sha chatning ishi ikki daraxtga bo'linib ketardi.
--
--   Yechim: allaqachon boshqa loyihaga bog'langan sessiyani qayta ulash
--   `already_linked_elsewhere` xatosi bilan rad etiladi. Faqat p_force = true
--   bilan o'zgaradi (kelajakdagi "chatni ko'chirish" tugmasi uchun).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Kaskad: label pog'onasi olib tashlandi
-- ----------------------------------------------------------------------------
drop function if exists app.find_or_create_session(uuid, text, uuid, text, text, text, text, text);

create function app.find_or_create_session(
  p_ws          uuid,
  p_scope       text,
  p_tok_project uuid,
  p_source      text,
  p_external_id text,
  p_chat_ref    text,
  p_label       text,
  p_title       text
)
returns table (out_session_id uuid, out_resolved_by text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  -- (1) chat_ref — yagona ishonchli identifikator
  if p_chat_ref is not null and btrim(p_chat_ref) <> '' then
    select cs.id into v_id
      from public.chat_sessions cs
     where cs.chat_ref = btrim(p_chat_ref)
       and cs.workspace_id = p_ws
       and (p_scope = 'workspace'
            or cs.project_id is not distinct from p_tok_project
            or cs.project_id is null);

    if v_id is not null then
      -- transport sessiyasi almashgan bo'lsa yangilaymiz (band bo'lmasa)
      if p_external_id is not null then
        update public.chat_sessions cs
           set external_id = p_external_id
         where cs.id = v_id
           and cs.external_id is distinct from p_external_id
           and not exists (
             select 1 from public.chat_sessions o
              where o.workspace_id = p_ws and o.source = p_source
                and o.external_id = p_external_id and o.id <> v_id);
      end if;
      -- label faqat yangilanadi, aniqlashda ishlatilmaydi
      if p_label is not null and btrim(p_label) <> '' then
        update public.chat_sessions cs set label = btrim(p_label)
         where cs.id = v_id and cs.label is distinct from btrim(p_label);
      end if;
      return query select v_id, 'chat_ref'::text;
      return;
    end if;
  end if;

  -- (2) external_id — haqiqiy per-sessiya identifikatori bo'lsagina.
  -- mcp-remote ko'prigida u null keladi, ya'ni bu pog'ona o'tkazib yuboriladi.
  if p_external_id is not null and btrim(p_external_id) <> '' then
    select cs.id into v_id
      from public.chat_sessions cs
     where cs.workspace_id = p_ws
       and cs.source = p_source
       and cs.external_id = p_external_id
       and (p_scope = 'workspace'
            or cs.project_id is not distinct from p_tok_project
            or cs.project_id is null);
    if v_id is not null then
      return query select v_id, 'external_id'::text;
      return;
    end if;
  end if;

  -- (3) Yangi sessiya. `label` bo'yicha qidiruv ATAYLAB yo'q — 2-muammoga qarang.
  insert into public.chat_sessions
    (workspace_id, project_id, source, external_id, title, label, chat_ref, status)
  values
    (p_ws,
     case when p_scope = 'project' then p_tok_project else null end,
     p_source,
     nullif(btrim(coalesce(p_external_id, '')), ''),
     p_title,
     nullif(btrim(coalesce(p_label, '')), ''),
     app.new_chat_ref(), 'pending')
  returning id into v_id;

  return query select v_id, 'new'::text;
end;
$$;

-- ----------------------------------------------------------------------------
-- 2. link_session — qayta ulanish himoyasi
-- ----------------------------------------------------------------------------
drop function if exists app.link_session(text, text, text, text, uuid, text);
drop function if exists app.link_session(text, text, text, text, uuid, text, boolean);

create function app.link_session(
  p_token       text,
  p_source      text,
  p_external_id text,
  p_chat_ref    text default null,
  p_project_id  uuid default null,
  p_label       text default null,
  p_force       boolean default false
)
returns table (
  out_chat_ref     text,
  out_project_id   uuid,
  out_project_name text,
  out_status       text,
  out_moved        boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  t_project uuid; t_ws uuid; t_scope text; t_raw boolean;
  s_id uuid; s_by text;
  cur_project uuid; cur_status text;
  target uuid;
  v_moved boolean := false;
begin
  select r.out_project_id, r.out_workspace_id, r.out_store_raw, r.out_scope
    into t_project, t_ws, t_raw, t_scope
    from app.resolve_token(p_token) r;

  if t_ws is null then
    raise exception 'invalid_token' using errcode = '28000';
  end if;

  target := coalesce(p_project_id, t_project);

  if target is null then
    raise exception 'project_required'
      using hint = 'Workspace tokeni bilan loyiha ID sini ko''rsatish shart';
  end if;

  if not exists (
    select 1 from public.projects p
     where p.id = target and p.workspace_id = t_ws and p.archived_at is null
  ) then
    raise exception 'project_not_found';
  end if;

  if t_scope = 'project' and target is distinct from t_project then
    raise exception 'token_scope_mismatch';
  end if;

  select f.out_session_id, f.out_resolved_by into s_id, s_by
    from app.find_or_create_session(
      t_ws, t_scope, t_project, p_source, p_external_id, p_chat_ref, p_label, null) f;

  select cs.project_id, cs.status into cur_project, cur_status
    from public.chat_sessions cs where cs.id = s_id;

  -- Bog'langan chatni boshqa loyihaga ko'chirish faqat ochiq ruxsat bilan.
  -- Aks holda model o'rtada adashib qayta ulasa, chatning ishi ikki daraxtga
  -- bo'linib ketardi.
  if cur_status = 'linked' and cur_project is not null
     and cur_project is distinct from target then
    if not p_force then
      raise exception 'already_linked_elsewhere'
        using hint = 'Bu chat allaqachon boshqa loyihaga bog''langan';
    end if;
    v_moved := true;
  end if;

  update public.chat_sessions cs
     set project_id = target,
         status     = 'linked',
         label      = coalesce(nullif(btrim(coalesce(p_label, '')), ''), cs.label)
   where cs.id = s_id;

  return query
    select cs.chat_ref, cs.project_id, p.name, cs.status, v_moved
      from public.chat_sessions cs
      join public.projects p on p.id = cs.project_id
     where cs.id = s_id;
end;
$$;

-- ----------------------------------------------------------------------------
-- 3. public o'ram
-- ----------------------------------------------------------------------------
drop function if exists public.cm_link_session(text, text, text, text, uuid, text);
drop function if exists public.cm_link_session(text, text, text, text, uuid, text, boolean);

create function public.cm_link_session(
  p_token text, p_source text, p_external_id text,
  p_chat_ref text default null, p_project_id uuid default null,
  p_label text default null, p_force boolean default false)
returns table (out_chat_ref text, out_project_id uuid, out_project_name text,
               out_status text, out_moved boolean)
language sql security definer set search_path = '' as $$
  select * from app.link_session(p_token, p_source, p_external_id,
                                 p_chat_ref, p_project_id, p_label, p_force);
$$;

revoke all on function public.cm_link_session(text, text, text, text, uuid, text, boolean)
  from public, anon, authenticated;
revoke all on function app.link_session(text, text, text, text, uuid, text, boolean)
  from public, anon, authenticated;
revoke all on function app.find_or_create_session(uuid, text, uuid, text, text, text, text, text)
  from public, anon, authenticated;

grant execute on function public.cm_link_session(text, text, text, text, uuid, text, boolean)
  to service_role;

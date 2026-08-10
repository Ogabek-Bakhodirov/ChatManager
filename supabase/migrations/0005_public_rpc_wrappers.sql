-- ============================================================================
-- Chat Manager — 0005_public_rpc_wrappers
--
-- PostgREST (Supabase REST/RPC) sukut bo'yicha faqat `public` sxemani ochadi.
-- Edge Function `app.*` funksiyalarini to'g'ridan chaqira olmaydi.
--
-- Ikki yo'l bor edi:
--   a) Dashboard -> API Settings -> Exposed schemas ga `app` qo'shish
--   b) `public` da yupqa o'ramlar
--
-- (b) tanlandi: sozlama o'zgartirishni talab qilmaydi, va `app` sxemasi
-- tashqariga umuman ochilmaydi — faqat shu 5 ta funksiya ko'rinadi,
-- ular ham faqat service_role uchun.
-- ============================================================================

drop function if exists public.cm_open_session(text, text, text, text);
drop function if exists public.cm_link_session(text, text, text, text);
drop function if exists public.cm_record_messages(uuid, jsonb, boolean);
drop function if exists public.cm_apply_ops(uuid, jsonb, bigint);
drop function if exists public.cm_tree_compact(uuid);

create function public.cm_open_session(
  p_token text, p_source text, p_external_id text, p_title text default null)
returns table (
  out_session_id uuid, out_project_id uuid, out_workspace_id uuid,
  out_status text, out_cursor_seq bigint, out_store_raw boolean)
language sql security definer set search_path = '' as $$
  select * from app.open_session(p_token, p_source, p_external_id, p_title);
$$;

create function public.cm_link_session(
  p_token text, p_source text, p_external_id text, p_label text default null)
returns uuid
language sql security definer set search_path = '' as $$
  select app.link_session(p_token, p_source, p_external_id, p_label);
$$;

create function public.cm_record_messages(
  p_session uuid, p_messages jsonb, p_store_raw boolean default false)
returns bigint
language sql security definer set search_path = '' as $$
  select app.record_messages(p_session, p_messages, p_store_raw);
$$;

create function public.cm_apply_ops(
  p_session uuid, p_ops jsonb, p_cursor bigint default null)
returns table (applied int, skipped int, ghosts int, expired int)
language sql security definer set search_path = '' as $$
  select * from app.apply_ops(p_session, p_ops, p_cursor);
$$;

create function public.cm_tree_compact(p_project uuid)
returns text
language sql security definer set search_path = '' as $$
  select app.tree_compact(p_project, 300);
$$;

-- ----------------------------------------------------------------------------
-- Huquqlar: FAQAT service_role. Frontend bularni ko'rmaydi.
-- ----------------------------------------------------------------------------
revoke all on function public.cm_open_session(text, text, text, text)   from public, anon, authenticated;
revoke all on function public.cm_link_session(text, text, text, text)   from public, anon, authenticated;
revoke all on function public.cm_record_messages(uuid, jsonb, boolean)  from public, anon, authenticated;
revoke all on function public.cm_apply_ops(uuid, jsonb, bigint)         from public, anon, authenticated;
revoke all on function public.cm_tree_compact(uuid)                     from public, anon, authenticated;

grant execute on function public.cm_open_session(text, text, text, text)   to service_role;
grant execute on function public.cm_link_session(text, text, text, text)   to service_role;
grant execute on function public.cm_record_messages(uuid, jsonb, boolean)  to service_role;
grant execute on function public.cm_apply_ops(uuid, jsonb, bigint)         to service_role;
grant execute on function public.cm_tree_compact(uuid)                     to service_role;

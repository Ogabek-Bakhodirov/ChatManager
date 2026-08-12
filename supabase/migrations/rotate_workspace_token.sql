-- ==========================================================================
-- Loosend — workspace tokenini almashtirish (bir martalik skript)
--
-- NEGA: `cm_ws_...` tokeni suhbatda to'liq ochilib qolgan. U parol kabi —
-- kimda bo'lsa, sening barcha loyihalaringga yozadi va o'qiydi.
--
-- BU SKRIPT:
--   1. Mavjud BARCHA workspace tokenlarini bekor qiladi
--   2. Yangisini yaratadi va BIR MARTA ko'rsatadi
--   3. Yangisi haqiqatan ishlashini TEKSHIRADI (resolve_token orqali)
--
-- 3-qadam muhim: token noto'g'ri hash bilan yozilsa, skript "muvaffaqiyat"
-- deb tugardi-yu, sen ulanolmay qolarding va sababini bilmasding. Shuning
-- uchun yozgandan keyin darhol o'qib ko'ramiz.
--
-- DIQQAT: bajarilgandan keyin Claude Desktop ULANMAY QOLADI, toki config'ga
-- yangi token yozilmaguncha. Bu kutilgan holat — eski token o'lishi kerak.
--
-- Natijani nusxa ol: u boshqa hech qachon ko'rsatilmaydi (bazada faqat
-- sha256 hash saqlanadi).
-- ==========================================================================

do $$
declare
  ws       uuid;
  raw_tok  text;
  killed   int;
  chk      record;
begin
  -- pgcrypto qaysi schemada bo'lishidan qat'i nazar ishlasin
  set local search_path = extensions, public, pg_catalog;

  -- Workspace: seniki bitta. Bir nechta bo'lsa quyidagi qatorni aniqlashtir.
  select w.id into ws
    from public.workspaces w
   order by w.created_at
   limit 1;

  if ws is null then
    raise exception 'Workspace topilmadi';
  end if;

  -- 1) Eskilarini o'ldiramiz (project tokenlariga tegmaymiz)
  update public.connect_tokens t
     set revoked_at = now()
   where t.workspace_id = ws
     and t.scope = 'workspace'
     and t.revoked_at is null;
  get diagnostics killed = row_count;

  -- 2) Yangisini yaratamiz
  raw_tok := 'cm_ws_' || encode(gen_random_bytes(24), 'hex');

  insert into public.connect_tokens
    (workspace_id, project_id, token_hash, token_prefix, label, channel, scope)
  values
    (ws, null,
     encode(digest(raw_tok, 'sha256'), 'hex'),
     left(raw_tok, 14), 'MacBook — Claude Desktop (rotated)', 'mcp', 'workspace');

  -- 3) Haqiqatan ishlaydimi? Serverning o'z yo'li bilan o'qiymiz.
  select * into chk from app.resolve_token(raw_tok);
  if chk.out_workspace_id is distinct from ws then
    raise exception 'TOKEN ISHLAMADI — bekor qilinmadi, eski holat saqlanadi';
  end if;

  raise notice '';
  raise notice '  Bekor qilindi: % ta eski token', killed;
  raise notice '  Tekshirildi: yangi token resolve_token dan o''tdi';
  raise notice '';
  raise notice '  YANGI TOKEN (bir marta ko''rsatiladi):';
  raise notice '';
  raise notice '      %', raw_tok;
  raise notice '';
end;
$$;

-- Holat: faol token bitta bo'lishi kerak
select
  token_prefix,
  label,
  case when revoked_at is null then '>>> FAOL' else 'bekor' end as holat,
  created_at
from public.connect_tokens
where scope = 'workspace'
order by created_at desc;

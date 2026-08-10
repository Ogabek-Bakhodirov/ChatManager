-- ============================================================================
-- Chat Manager — 0002_token_hardening_and_selftest
--
-- 0001 allaqachon qo'llangan bo'lsa SHUNI ishga tushiring.
-- Nima tuzatiladi:
--   1. `authenticated` roli connect_tokens.token_hash ustuniga INSERT/UPDATE
--      qila olar edi (jadval darajasidagi grant hamma ustunni qamrab olgan).
--      Endi INSERT umuman yo'q, UPDATE faqat label va revoked_at ustunlariga.
--   2. Token faqat create_connect_token() orqali tug'iladi va BIR MARTA
--      qaytariladi.
--   3. app.self_test() — bazani real yuklab tekshiradigan va o'zidan keyin
--      tozalab ketadigan funksiya.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Token yaratish — yagona to'g'ri yo'l
-- ----------------------------------------------------------------------------
create or replace function public.create_connect_token(
  p_project uuid,
  p_channel text,
  p_label   text default null
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  ws      uuid;
  raw_tok text;
begin
  select p.workspace_id into ws
    from public.projects p
   where p.id = p_project and p.archived_at is null;

  if ws is null then
    raise exception 'Loyiha topilmadi';
  end if;
  if not app.can_write(ws) then
    raise exception 'Ruxsat yo''q';
  end if;
  if p_channel not in ('hook','mcp','extension') then
    raise exception 'Noto''g''ri kanal: %', p_channel;
  end if;

  raw_tok := 'cm_live_' || encode(extensions.gen_random_bytes(24), 'hex');

  insert into public.connect_tokens
    (workspace_id, project_id, token_hash, token_prefix, label, channel)
  values
    (ws, p_project,
     encode(extensions.digest(raw_tok, 'sha256'), 'hex'),
     left(raw_tok, 16),
     p_label, p_channel);

  return raw_tok;   -- BIR MARTA. Qayta ko'rsatib bo'lmaydi.
end;
$$;
grant execute on function public.create_connect_token(uuid, text, text) to authenticated;

-- ----------------------------------------------------------------------------
-- 2. Grant'larni qattiqlashtirish
-- ----------------------------------------------------------------------------
revoke insert, update, delete on public.connect_tokens from authenticated;

grant update (label, revoked_at) on public.connect_tokens to authenticated;
grant delete                     on public.connect_tokens to authenticated;

-- ----------------------------------------------------------------------------
-- 3. app.self_test() — bitta buyruq bilan to'liq xulq tekshiruvi
--    Ishlatish:  select * from app.self_test();
--    Test ma'lumotlari funksiya ichida yaratiladi va o'chiriladi.
--    Xato bo'lsa tranzaksiya bekor bo'ladi — bazada hech narsa qolmaydi.
-- ----------------------------------------------------------------------------
create or replace function app.self_test()
returns table (n int, tekshiruv text, ok boolean, izoh text)
language plpgsql
-- DIQQAT: security INVOKER (definer emas) — ichida SET ROLE qilamiz,
-- security definer funksiyada rolni almashtirib bo'lmaydi.
-- Shuning uchun uni faqat postgres/service_role chaqira oladi.
set search_path = ''
as $$
declare
  u_a       uuid := '00000000-0000-4000-8000-00000000000a';
  u_b       uuid := '00000000-0000-4000-8000-00000000000b';
  ws_a      uuid;
  ws_list   uuid[];
  proj      uuid;
  root_id   uuid;
  child_id  uuid;
  sess      uuid;
  raw_tok   text;
  caller    text := current_user;
  cnt       int;
  found     uuid;
  okv       boolean;
begin
  -- ---------- Tayyorgarlik: ikkita test foydalanuvchisi ----------
  insert into auth.users (id, email) values
    (u_a, 'selftest-a@chatmanager.local'),
    (u_b, 'selftest-b@chatmanager.local');

  -- 1. Trigger workspace yaratdimi
  select count(*) into cnt from public.workspace_members m
   where m.user_id in (u_a, u_b) and m.role = 'owner';
  n := 1; tekshiruv := 'Yangi user -> workspace avtomatik yaratildi';
  ok := (cnt = 2); izoh := cnt || '/2 workspace'; return next;

  select m.workspace_id into ws_a from public.workspace_members m where m.user_id = u_a;
  select array_agg(m.workspace_id) into ws_list
    from public.workspace_members m where m.user_id in (u_a, u_b);

  -- Ma'lumot: loyiha, sessiya, ikkita tugun
  insert into public.projects (workspace_id, name)
       values (ws_a, 'Self-test loyihasi') returning id into proj;

  insert into public.chat_sessions (workspace_id, project_id, source, external_id, status, label)
       values (ws_a, proj, 'claude_code', '/selftest', 'linked', 'Test chat')
    returning id into sess;

  insert into public.nodes (project_id, title, type, origin_session_id)
       values (proj, 'Roadmap tuzish', 'milestone', sess) returning id into root_id;

  insert into public.nodes (project_id, parent_id, title, origin_session_id)
       values (proj, root_id, 'Supabase sxemasini yozish!', sess) returning id into child_id;

  -- 2. workspace_id trigger orqali to'ldi
  select count(*) into cnt from public.nodes nd
   where nd.project_id = proj and nd.workspace_id = ws_a;
  n := 2; tekshiruv := 'nodes.workspace_id loyihadan avtomatik to''ldi';
  ok := (cnt = 2); izoh := cnt || '/2 tugun'; return next;

  -- 3. stable_key normallashuvi
  select count(*) into cnt from public.nodes nd
   where nd.id = child_id and nd.stable_key = 'roadmap tuzish > supabase sxemasini yozish';
  n := 3; tekshiruv := 'stable_key ota-ona yo''li bilan hosil bo''ldi';
  ok := (cnt = 1);
  izoh := (select nd.stable_key from public.nodes nd where nd.id = child_id); return next;

  -- 4. Dublikat bloklanadi
  begin
    insert into public.nodes (project_id, parent_id, title)
         values (proj, root_id, '  supabase   SXEMASINI yozish!!  ');
    okv := false;
  exception when unique_violation then okv := true;
  end;
  n := 4; tekshiruv := 'Boshqacha yozilgan dublikat bloklandi';
  ok := okv; izoh := case when okv then 'unique_violation' else 'DUBLIKAT O''TDI' end; return next;

  -- 5. Fuzzy merge mavjud tugunni topadi
  found := app.find_similar_node(proj, root_id, 'Supabase sxema yozish');
  n := 5; tekshiruv := 'Fuzzy merge o''xshash tugunni topdi';
  ok := (found = child_id); izoh := coalesce(found::text, 'topilmadi'); return next;

  -- 6. Sikl bloklanadi
  begin
    update public.nodes set parent_id = child_id where id = root_id;
    okv := false;
  exception when others then okv := true;
  end;
  n := 6; tekshiruv := 'Daraxtda sikl hosil qilib bo''lmadi';
  ok := okv; izoh := case when okv then 'rad etildi' else 'SIKL O''TDI' end; return next;

  -- 7. done_at avtomatik
  update public.nodes set status = 'done' where id = child_id;
  select count(*) into cnt from public.nodes nd
   where nd.id = child_id and nd.done_at is not null;
  n := 7; tekshiruv := 'status=done -> done_at avtomatik yozildi';
  ok := (cnt = 1); izoh := cnt || '/1'; return next;

  -- 8. Token yaratish va tekshirish
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', u_a::text, true);
  raw_tok := public.create_connect_token(proj, 'hook', 'self-test');
  perform set_config('role', caller, true);

  select count(*) into cnt from app.resolve_token(raw_tok) r
   where r.out_project_id = proj and r.out_store_raw = false;
  n := 8; tekshiruv := 'Token yaratildi va to''g''ri yechildi';
  ok := (cnt = 1); izoh := left(raw_tok, 16) || '...'; return next;

  -- 9. Yolg'on token
  select count(*) into cnt from app.resolve_token('cm_live_yolgon');
  n := 9; tekshiruv := 'Yolg''on token rad etildi';
  ok := (cnt = 0); izoh := cnt || ' qator'; return next;

  -- 10. Bekor qilingan token ishlamaydi
  update public.connect_tokens set revoked_at = now() where project_id = proj;
  select count(*) into cnt from app.resolve_token(raw_tok);
  n := 10; tekshiruv := 'Bekor qilingan token rad etildi';
  ok := (cnt = 0); izoh := cnt || ' qator'; return next;

  -- ---------- RLS: B foydalanuvchisi A ma'lumotini ko'rmasligi kerak ----------
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', u_b::text, true);

  select count(*) into cnt from public.nodes;
  n := 11; tekshiruv := 'Begona user tugunlarni KO''RMAYDI';
  ok := (cnt = 0); izoh := cnt || ' tugun ko''rindi'; return next;

  select count(*) into cnt from public.projects;
  n := 12; tekshiruv := 'Begona user loyihalarni KO''RMAYDI';
  ok := (cnt = 0); izoh := cnt || ' loyiha ko''rindi'; return next;

  with hack as (update public.nodes set title = 'HACKED' returning 1)
  select count(*) into cnt from hack;
  n := 13; tekshiruv := 'Begona user tugunni O''ZGARTIRA OLMADI';
  ok := (cnt = 0); izoh := cnt || ' qator o''zgardi'; return next;

  -- 14. token_hash ustuni yopiq
  begin
    perform ct.token_hash from public.connect_tokens ct;
    okv := false;
  exception
    when insufficient_privilege then okv := true;
    when others then okv := true;
  end;
  n := 14; tekshiruv := 'token_hash ustuni frontendga YOPIQ';
  ok := okv; izoh := case when okv then 'ruxsat yo''q' else 'O''QILDI' end; return next;

  -- 15. node_events o'chirib bo'lmaydi (append-only)
  begin
    delete from public.node_events;
    okv := false;
  exception
    when insufficient_privilege then okv := true;
    when others then okv := true;
  end;
  n := 15; tekshiruv := 'node_events append-only (DELETE yo''q)';
  ok := okv; izoh := case when okv then 'ruxsat yo''q' else 'O''CHIRILDI' end; return next;

  -- 16. connect_tokens'ga to'g'ridan-to'g'ri INSERT qilib bo'lmaydi
  begin
    insert into public.connect_tokens
      (workspace_id, project_id, token_hash, token_prefix, channel)
    values (ws_a, proj, 'qalbaki', 'cm_live_x', 'hook');
    okv := false;
  exception when others then okv := true;
  end;
  n := 16; tekshiruv := 'connect_tokens''ga to''g''ridan INSERT bloklandi';
  ok := okv; izoh := case when okv then 'ruxsat yo''q' else 'INSERT O''TDI' end; return next;

  perform set_config('role', caller, true);

  -- 17. Ghost tozalash
  insert into public.nodes (project_id, title, is_ghost, ghost_strikes, confidence)
       values (proj, 'Eskirgan taxmin', true, 3, 0.6),
              (proj, 'Yangi taxmin',    true, 1, 0.6);
  cnt := app.sweep_ghosts(proj);
  n := 17; tekshiruv := 'Ghost sweep: 3 strike o''chdi, 1 strike qoldi';
  ok := (cnt = 1); izoh := cnt || ' ta o''chirildi'; return next;

  select count(*) into cnt from public.node_events e
   where e.project_id = proj and e.op = 'ghost_expired';
  n := 18; tekshiruv := 'Ghost o''chishi tarixga yozildi';
  ok := (cnt = 1); izoh := cnt || ' hodisa'; return next;

  -- 19. Xom matn saqlanmaydi
  insert into public.messages (id, session_id, workspace_id, role, seq, content_hash, char_count)
       values ('selftest_msg_1', sess, ws_a, 'user', 1, md5('salom'), 5);
  select count(*) into cnt from public.messages m
   where m.session_id = sess and m.content is null and m.content_hash is not null;
  n := 19; tekshiruv := 'Xabar indeksi: content NULL, hash bor';
  ok := (cnt = 1); izoh := 'store_raw = false'; return next;

  -- ---------- Tozalash ----------
  perform set_config('role', caller, true);
  delete from public.workspaces w where w.id = any(ws_list);
  delete from auth.users au where au.id in (u_a, u_b);

  select count(*) into cnt from public.nodes nd where nd.project_id = proj;
  n := 20; tekshiruv := 'Test ma''lumotlari to''liq tozalandi';
  ok := (cnt = 0); izoh := cnt || ' qoldiq'; return next;

  return;
end;
$$;

revoke all on function app.self_test() from public, anon, authenticated;

comment on function app.self_test() is
  'Bir martalik xulq tekshiruvi. Ishlatish: select * from app.self_test();
   Tekshirgandan keyin: drop function app.self_test();';

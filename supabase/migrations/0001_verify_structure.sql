-- ============================================================================
-- Chat Manager — TUZILISH TEKSHIRUVI (A qism)
-- Supabase SQL Editor'da butunligicha ishga tushiring.
-- Hech narsa o'zgartirmaydi, faqat o'qiydi. Xavfsiz.
-- Kutilgan natija: barcha qatorlarda ok = true
-- ============================================================================

with checks as (

  select 1.0 as n, 'Jadvallar yaratilgan' as tekshiruv, '9' as kutilgan,
         count(*)::text as haqiqiy
    from pg_tables
   where schemaname = 'public'
     and tablename in ('workspaces','workspace_members','projects','connect_tokens',
                       'chat_sessions','messages','nodes','node_events','sync_runs')

  union all
  select 2, 'RLS barcha jadvalda yoqilgan', '9',
         count(*)::text
    from pg_tables
   where schemaname = 'public' and rowsecurity = true
     and tablename in ('workspaces','workspace_members','projects','connect_tokens',
                       'chat_sessions','messages','nodes','node_events','sync_runs')

  union all
  select 3, 'RLS policy''lari mavjud', '17',
         count(*)::text
    from pg_policies where schemaname = 'public'

  union all
  select 4, 'token_hash authenticated uchun YOPIQ', '0',
         count(*)::text
    from information_schema.column_privileges
   where table_schema = 'public' and table_name = 'connect_tokens'
     and column_name = 'token_hash' and grantee = 'authenticated'

  union all
  select 5, 'connect_tokens metadata ustunlari ochiq', '9',
         count(*)::text
    from information_schema.column_privileges
   where table_schema = 'public' and table_name = 'connect_tokens'
     and grantee = 'authenticated' and privilege_type = 'SELECT'

  union all
  select 6, 'app.* yordamchi funksiyalari', '11',
         count(*)::text
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'app' and p.proname <> 'self_test'

  union all
  select 6.1, 'connect_tokens uchun INSERT grant''i YO''Q', '0',
         count(*)::text
    from information_schema.role_table_grants
   where table_schema = 'public' and table_name = 'connect_tokens'
     and grantee = 'authenticated' and privilege_type = 'INSERT'

  union all
  select 6.2, 'Token yaratish funksiyasi mavjud', '1',
         count(*)::text
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname = 'create_connect_token'

  union all
  select 7, 'Yangi user -> workspace trigger''i', '1',
         count(*)::text
    from pg_trigger where tgname = 'on_auth_user_created' and not tgisinternal

  union all
  select 8, 'nodes yaxlitlik trigger''i', '1',
         count(*)::text
    from pg_trigger where tgname = 'nodes_integrity' and not tgisinternal

  union all
  select 9, 'Realtime publication jadvallari', '3',
         count(*)::text
    from pg_publication_tables
   where pubname = 'supabase_realtime'
     and tablename in ('nodes','node_events','chat_sessions')

  union all
  select 10, 'Kengaytmalar (pgcrypto, pg_trgm)', '2',
         count(*)::text
    from pg_extension where extname in ('pgcrypto','pg_trgm')

  union all
  select 11, 'stable_key unique indeksi (dublikatga qarshi)', '1',
         count(*)::text
    from pg_indexes
   where schemaname = 'public' and indexname = 'nodes_stable_key_idx'

  union all
  select 12, 'title trigram indeksi (fuzzy merge)', '1',
         count(*)::text
    from pg_indexes
   where schemaname = 'public' and indexname = 'nodes_title_trgm'

  union all
  select 13, 'node_events append-only (UPDATE/DELETE policy YO''Q)', '0',
         count(*)::text
    from pg_policies
   where schemaname = 'public' and tablename = 'node_events'
     and cmd in ('UPDATE','DELETE')

  union all
  select 14, 'node_events uchun DELETE grant''i YO''Q', '0',
         count(*)::text
    from information_schema.role_table_grants
   where table_schema = 'public' and table_name = 'node_events'
     and grantee = 'authenticated' and privilege_type in ('DELETE','UPDATE')

  union all
  select 15, 'messages.content default NULL (xom matn saqlanmaydi)', 'YES',
         is_nullable
    from information_schema.columns
   where table_schema = 'public' and table_name = 'messages' and column_name = 'content'

  union all
  select 16, 'evidence_quote <= 200 belgi cheklovi', '1',
         count(*)::text
    from pg_constraint c join pg_class t on t.oid = c.conrelid
   where t.relname = 'nodes' and pg_get_constraintdef(c.oid) ilike '%evidence_quote%200%'

  union all
  select 17, 'Foydalanish ko''rinishi (billing uchun)', '1',
         count(*)::text
    from pg_views where schemaname = 'public' and viewname = 'v_workspace_usage'
)

select n as "#",
       tekshiruv,
       kutilgan,
       haqiqiy,
       (kutilgan = haqiqiy) as ok,
       case when kutilgan = haqiqiy then '✅' else '❌ TEKSHIRING' end as holat
  from checks
 order by n;

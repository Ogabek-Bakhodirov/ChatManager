# Chat Manager — joylashtirish qo'llanmasi

Tartib muhim. Har qadamdan keyin tekshiruv bor.

---

## 1. Migratsiyalar

`0001`–`0003` allaqachon qo'llangan. Qolgan ikkitasini SQL Editor'da yugurtiring:

```
0004_ingest_rpcs.sql            -- open_session, link_session, record_messages,
                                -- apply_ops, tree_compact
0005_public_rpc_wrappers.sql    -- public.cm_* o'ramlari (faqat service_role)
```

**Nega o'ramlar kerak:** PostgREST sukut bo'yicha faqat `public` sxemani ochadi.
`app.*` funksiyalarini Edge Function to'g'ridan chaqira olmaydi. Ikki yo'l bor edi —
Dashboard'da `app` sxemasini ochish yoki `public` da yupqa o'ram. Ikkinchisi tanlandi:
`app` sxemasi tashqariga umuman ochilmaydi, faqat kerakli 5 ta funksiya ko'rinadi.

Tekshirish:

```sql
select proname from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and proname like 'cm\_%'
 order by 1;
-- 5 qator: cm_apply_ops, cm_link_session, cm_open_session,
--          cm_record_messages, cm_tree_compact
```

---

## 2. Edge Function

Fayllarni loyihangizga ko'chiring:

```
supabase/functions/ingest/index.ts
supabase/functions/ingest/prompts.ts
supabase/functions/ingest/anthropic.ts
supabase/functions/ingest/prefilter.ts
```

Secret'lar:

```bash
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
# ixtiyoriy — model almashtirish uchun
supabase secrets set EXTRACTOR_MODEL=claude-haiku-4-5
```

`SUPABASE_URL` va `SUPABASE_SERVICE_ROLE_KEY` avtomatik beriladi, ularni qo'lda
qo'yish shart emas.

Joylashtirish:

```bash
supabase functions deploy ingest --no-verify-jwt
```

`--no-verify-jwt` **shart**: autentifikatsiya Supabase JWT bilan emas, o'zimizning
`cm_live_...` tokeni bilan bo'ladi (hook'da JWT yo'q).

---

## 3. Loyiha va token

```sql
-- Loyiha (workspace ro'yxatdan o'tganda avtomatik yaratilgan)
insert into projects (workspace_id, name)
select workspace_id, 'Chat Manager' from workspace_members
 where user_id = auth.uid()
returning id;

-- Token. XOM QIYMAT FAQAT SHU YERDA BIR MARTA CHIQADI.
select public.create_connect_token('<project_id>', 'hook', 'MacBook');
```

> SQL Editor `auth.uid()` ni `null` qaytarsa, `workspace_id` ni qo'lda oling:
> `select * from workspace_members;`
>
> `create_connect_token` `can_write` tekshiradi, ya'ni uni **ilova ichidan**
> (login qilgan foydalanuvchi sifatida) chaqirish to'g'riroq. SQL Editor'dan sinash
> uchun tokenni qo'lda kiritsangiz ham bo'ladi:
>
> ```sql
> insert into connect_tokens (workspace_id, project_id, token_hash, token_prefix, channel)
> select workspace_id, id, encode(extensions.digest('cm_live_SIZNING_TOKEN','sha256'),'hex'),
>        'cm_live_SIZNIN', 'hook'
>   from projects where name = 'Chat Manager';
> ```

---

## 4. Hook

```bash
cd /ishlayotgan/loyihangiz
npx chatmanager init \
  --token cm_live_... \
  --url https://<ref>.supabase.co/functions/v1/ingest

npx chatmanager link
npx chatmanager sync      # qo'lda bir marta — natijani darhol ko'rasiz
```

`sync` javobi shunday bo'lishi kerak:

```json
{"ok":true,"applied":7,"skipped":0,"ghosts":1,"expired":0,
 "items":8,"cursor":24,"cost_usd":0.004312,"duration_ms":6210}
```

---

## 5. Kuzatish

```sql
-- Daraxt
select app.tree_compact((select id from projects where name='Chat Manager'));

-- Nima o'zgardi
select created_at, op, payload->>'title' as sarlavha, confidence
  from node_events order by id desc limit 20;

-- Xarajat va tezlik
select created_at, trigger, messages_in, ops_applied, prefilter_skipped,
       input_tokens, output_tokens, cost_usd, duration_ms, error
  from sync_runs order by id desc limit 20;

-- Oylik jami
select * from v_workspace_usage;
```

---

## 6. Nima kuzatish kerak (birinchi hafta)

Bu narsalar hali **o'lchanmagan** — ular faqat haqiqiy ishlatishda ko'rinadi:

| Savol | Qayerdan ko'riladi | Nima yomon |
|---|---|---|
| Dublikat paydo bo'ladimi? | `tree_compact` — bir xil ish ikki marta turibdimi | Pass B chegarasini qattiqlashtirish kerak |
| Prefilter qanchani kesdi? | `sync_runs.prefilter_skipped` ulushi | 90%+ bo'lsa juda qattiq, 20% bo'lsa juda yumshoq |
| Haqiqiy narx? | `sum(cost_usd)` kuniga | ~$0.005/sync kutilyapti |
| Ghost'lar to'planyaptimi? | `select count(*) from nodes where is_ghost` | Ko'p bo'lsa `ghost_threshold` ni ko'tarish |
| Xatolar? | `sync_runs.error` | `pass_b_failed` ko'p bo'lsa daraxt juda kattalashgan |

`prefilter_skipped` ulushi eng muhimi: u to'g'ri sozlangan bo'lsa xarajat bir necha
barobar tushadi.

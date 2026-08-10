# Chat Manager

AI suhbatidagi tasklarni avtomatik ushlab qolib, daraxt shaklida ko'rsatadigan tizim.

Muammo: uzun chatlarda roadmap va tasklar yo'qoladi. Bir necha chat bitta loyiha
ustida ishlaganda esa hech kim umumiy manzarani ko'rmaydi.

Yechim: suhbat matnidan tasklar avtomatik ajratib olinadi, loyiha darajasidagi
yagona daraxtga joylashtiriladi va jonli canvas'da ko'rsatiladi.

---

## Tuzilma

```
web/index.html            Canvas — o'z-o'ziga yetarli HTML (Vercel shu papkani beradi)
src/canvas/               Canvas manbasi: app.js, shell.html, build.mjs
supabase/functions/
  ingest/                 Extraction quvuri (Pass A -> B -> apply_ops)
  mcp/                    MCP server (Claude connectori)
supabase/migrations/      0001–0008
packages/chatmanager/     Claude Code hook adapteri (npm paket)
docs/                     Joylashtirish qo'llanmasi
```

## Canvas'ni yig'ish

```bash
npm install
npm run build:canvas       # -> web/index.html
```

`web/index.html` repo'ga commit qilinadi, shuning uchun Vercel'da build bosqichi
kerak emas — u toza statik sayt sifatida beriladi.

## Edge funksiyalarni joylashtirish

```bash
npx supabase secrets set ANTHROPIC_API_KEY=sk-ant-... --project-ref <ref>
npx supabase secrets set INGEST_URL=https://<ref>.supabase.co/functions/v1/ingest --project-ref <ref>

npx supabase functions deploy ingest --project-ref <ref> --no-verify-jwt
npx supabase functions deploy mcp    --project-ref <ref> --no-verify-jwt
```

`--no-verify-jwt` shart: autentifikatsiya Supabase JWT bilan emas, `cm_ws_...`
tokeni bilan bo'ladi.

## Migratsiyalar

`supabase/migrations/` ichidagilar tartib bilan SQL Editor'da yugurtiriladi.
`0001_verify_structure.sql` — tekshiruv, hech narsani o'zgartirmaydi.
`app.self_test()` — 21 ta xulq testi, o'zidan keyin tozalab ketadi.

---

## Arxitektura — asosiy qarorlar

**MCP serveri chatni o'qiy olmaydi.** Bu spetsifikatsiyaning ataylab qo'yilgan
cheklovi. Shuning uchun model suhbatning kerakli qismini `chat_manager_sync`
tooliga matn sifatida o'zi uzatadi.

**Chat identifikatorini server yasaydi.** claude.ai chat ID bermaydi, transport
sessiyasi esa barqaror emas. `link` javobida qaytgan `chat_ref` suhbat
kontekstida yashaydi va tashqi hech narsaga bog'liq emas.

**Extraction ikki bosqichli.** Pass A daraxtni ko'rmaydi (daraxt berilganda
model unga yopishib qoladi va yangi ishni qidirmay qo'yadi — sinovda 11 ta
o'rniga 2 ta topgan). Pass B esa faqat moslashtiradi.

**Yo'qotishga qarshi to'rt qatlam.** Prompt qoidalari, identifikator to'ri
(`T3`, `LIN-123` sanaladi), qamrov to'ri (iqtibos tegmagan ish qatorlari),
tanaffus ogohlantirishi. Ustiga UI'dagi qo'lda tiklash prompti.

**Bir chat = bir loyiha.** Bog'langan chatni boshqa loyihaga ulash rad etiladi.
Aniqlash kaskadi: `chat_ref` -> `external_id` -> yangi `pending` (yozmaydi).

## Tuzoqlar (qayta bosmang)

- Supabase `public` sxemasidagi yangi jadvalga `anon`/`authenticated` uchun
  avtomatik ALL PRIVILEGES beradi. Ustun darajasidagi grant buni cheklamaydi —
  avval `revoke all` shart.
- JS'da `\b` faqat ASCII ustida ishlaydi: `\bготово\b` hech qachon mos kelmaydi.
  Unicode chegara kerak.
- `app.tree_compact()` ni `depth` bo'yicha saralamang — ota-onalik ko'rinmay
  qoladi va bu matn Pass B promptiga tushadi.
- Bir vaqtda faqat BITTA Chat Manager connectori yoqiq tursin.

## Xarajat

Bir sync ~$0.005–0.007, 7–9 soniya. Model: `claude-haiku-4-5`.
Prefilter task signali yo'q delta'larda LLM'ni umuman chaqirmaydi.

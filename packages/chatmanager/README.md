# chatmanager

Claude Code / Cowork suhbatidan task daraxtini avtomatik yig'adigan hook adapteri.

Siz chatda ishlaysiz — hech narsa bosmaysiz, hech narsa kiritmaysiz. Har bir javobdan
keyin `Stop` hook ishga tushadi, transkriptning yangi qismini o'qiydi va Chat Manager'ga
yuboradi.

## O'rnatish

```bash
cd /loyihangiz/papkasi
npx chatmanager init \
  --token cm_live_xxxxxxxx \
  --url https://<ref>.supabase.co/functions/v1/ingest

npx chatmanager link            # bu chatni loyihaga ulash (bir martalik)
```

`init` ikki narsa qiladi:

1. Tokenni `~/.chatmanager/config.json` ga yozadi (huquq `0600`, repo ichida **emas** —
   git'ga tushib ketmasligi uchun)
2. `.claude/settings.json` ga hook'larni qo'shadi, mavjudlarini buzmaydi

## Buyruqlar

| Buyruq | Vazifasi |
|---|---|
| `chatmanager init` | Papkani loyihaga bog'laydi, hook'larni o'rnatadi |
| `chatmanager link` | Chatni loyihaga ulaydi. Bungacha server hech narsa qabul qilmaydi |
| `chatmanager status` | Sessiya holatini ko'rsatadi |
| `chatmanager sync` | Qo'lda bir marta sinxronlash (kutib turadi, natijani chop etadi) |

## Qanday ishlaydi

```
Claude javobni tugatdi
   └─ Stop hook  ──► chatmanager (≈65 ms, darhol chiqadi)
                        └─ fon jarayoni ──► POST /ingest ──► Pass A → Pass B → daraxt
```

Hook **javobni kutmaydi**: ishni detached jarayonga uzatib darhol `exit 0` qiladi.
Sinovda hook 63–82 ms ichida qaytdi, LLM ishi esa fonda davom etdi.

## Muhim tafsilotlar

**Ulanmagan papkada jim turadi.** Hook global o'rnatilgan bo'lishi mumkin. `~/.chatmanager`
da yozuvi yo'q papkada u hech narsa qilmay `exit 0` qiladi — boshqa loyihalaringizga
umuman tegmaydi.

**`tail_text` alohida yuboriladi.** Rasmiy hujjat ogohlantiradi: `Stop` paytida transkript
fayli oxirgi javobdan orqada qolishi mumkin. Shuning uchun `last_assistant_message` ni
ishlatamiz — lekin uni **xabar sifatida emas**, alohida `tail_text` maydonida yuboramiz.

Sabab jiddiy: `seq` — transkriptdagi tartib raqami. Sintetik xabarga raqam bersak, o'sha
raqam keyinroq haqiqiy xabarga tegishli bo'lib qoladi va kursor uni o'tkazib yuboradi.
Sinovda aynan shunday bo'ldi — bitta haqiqiy xabar jimgina yo'qoldi. Endi kursor faqat
haqiqiy transkript xabarlaridan suriladi.

**Takroriy `Stop` bekorga LLM chaqirmaydi.** Kursor faylida oxirgi javobning hash'i
saqlanadi. Yangi xabar ham, yangi javob ham bo'lmasa hook hech narsa yubormaydi.

**Transkript sxemasi kafolatlanmagan.** Rasmiy hujjat uni faqat "conversation JSON" deb
ataydi. Parser ataylab himoyalangan: bir nechta shaklni tushunadi, `tool_use` /
`tool_result` / `thinking` bloklarini tashlaydi, yarim yozilgan qatorlarni jimgina
o'tkazib yuboradi. Sxema o'zgarsa hook buzilmaydi — shunchaki kamroq xabar topadi.

## Loglar

```
~/.chatmanager/worker.log
```

```
2026-08-10T15:48:57Z ok applied=5 skipped=0 items=3 cost=0.004 120ms
```

`not_linked` chiqsa — `npx chatmanager link` ni bajaring.

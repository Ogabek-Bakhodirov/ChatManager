#!/usr/bin/env bash
# Chat Manager — Edge Function'ni joylashtirish
# Ishlatish:  ./deploy.sh <project-ref>
set -e
REF="${1:?Foydalanish: ./deploy.sh <project-ref>}"

echo "==> Supabase CLI (npx orqali, o'rnatish shart emas)"
npx --yes supabase@latest --version

echo "==> Login (brauzer ochiladi)"
npx --yes supabase@latest login

echo "==> Loyihaga bog'lash: $REF"
npx --yes supabase@latest link --project-ref "$REF"

echo "==> Deploy (tashqi bog'liqlik yo'q, tez bo'lishi kerak)"
npx --yes supabase@latest functions deploy ingest --no-verify-jwt

echo ""
echo "✅ Tayyor. Funksiya manzili:"
echo "   https://$REF.supabase.co/functions/v1/ingest"

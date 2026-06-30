# Mon IA — site de chat IA avec abonnements

Un site où les gens créent un compte, discutent avec une IA (Claude), et paient
un abonnement pour avoir plus de messages par mois.

## 1) Mettre en ligne (comme ton biolink)

1. Crée un dépôt GitHub et mets-y le **contenu** de ce dossier.
2. Sur **Railway** : New Project → Deploy from GitHub → choisis le dépôt.
3. Ajoute un **Volume** monté sur `/data` (pour garder la base de données).
4. Mets les **variables** ci-dessous (onglet Variables), puis Deploy.
5. Branche ton domaine via Cloudflare (CNAME → Railway), comme pour lvtm.lol.

## 2) Variables d'environnement

**Obligatoires :**
- `DATA_DIR` = `/data`
- `SESSION_SECRET` = une longue phrase secrète au hasard
- `ANTHROPIC_API_KEY` = ta clé API (voir étape 3)

**Optionnelles (réglages) :**
- `SITE_NAME` = le nom affiché (def: "Mon IA")
- `AI_MODEL` = `claude-haiku-4-5` (pas cher) / `claude-sonnet-4-6` (meilleur)
- `SYSTEM_PROMPT` = la "personnalité" de l'IA
- `PLAN_FREE_LIMIT` = messages/mois en gratuit (def: 30)
- `PLAN_PRO_LIMIT` = messages/mois en Pro (def: 1000)
- `PRO_PRICE_LABEL` = texte du prix affiché (def: "5 €/mois")

**Pour activer le paiement (Stripe) :**
- `STRIPE_SECRET_KEY` = clé secrète Stripe (sk_live_… ou sk_test_…)
- `STRIPE_PRICE_ID` = l'ID du prix de l'abonnement (price_…)
- `STRIPE_WEBHOOK_SECRET` = secret du webhook (whsec_…)

> Sans les variables Stripe, le site fonctionne en **gratuit seulement**
> (le bouton "Passer au Pro" indique que le paiement n'est pas configuré).

## 3) Obtenir la clé IA (Anthropic)

1. Va sur **platform.claude.com** → crée un compte (5 $ de crédits offerts).
2. API Keys → Create Key → copie-la dans `ANTHROPIC_API_KEY`.
3. C'est de l'usage à la demande : Haiku ≈ 0,002 $ par petit message.

## 4) Configurer Stripe (paiement)

1. Crée un compte sur **dashboard.stripe.com**.
2. Products → crée un produit "Pro" avec un **prix récurrent mensuel** → copie son `price_…` dans `STRIPE_PRICE_ID`.
3. Developers → API keys → copie la **clé secrète** dans `STRIPE_SECRET_KEY`.
4. Developers → Webhooks → Add endpoint :
   - URL : `https://TON-DOMAINE/billing/webhook`
   - Événements : `checkout.session.completed` et `customer.subscription.deleted`
   - Copie le **Signing secret** (`whsec_…`) dans `STRIPE_WEBHOOK_SECRET`.
5. Teste d'abord en **mode test** (clés sk_test_ / price de test) avant le vrai.

## Comment ça marche
- Chaque compte a un quota de messages **remis à zéro tous les 30 jours**.
- Quand le quota est atteint, l'IA invite à passer au Pro.
- Le paiement Stripe fait passer le compte en `pro` automatiquement (via le webhook).

⚠️ Mentions légales : si tu fais payer, pense à des **CGV**, une page de
contact et le respect du **RGPD** (données des utilisateurs). Commence en
mode test Stripe tant que tu mets tout en place.

# SkeinBook Beta Infrastructure — Setup Guide

## Architecture

```
skeinbook.app (Cloudflare Pages)
    │
    ├── index.html          → Landing page + beta key form
    ├── download.html        → Post-download install instructions
    ├── privacy.html         → Privacy policy
    ├── terms.html           → Terms of service
    │
    └── POST /api/download   → Cloudflare Worker
            │
            ├── Validates beta_key against Supabase
            ├── Generates Wasabi presigned URL (15 min)
            └── Returns URL to client → browser downloads file
```

---

## 1. Supabase Setup

You already have a Supabase project (`jticojarihjwzdlmsnzw`). Run the schema in SQL Editor:

```sql
-- Paste contents of supabase/schema.sql
```

Then add your first beta tester:
```sql
INSERT INTO beta_users (email, beta_key)
VALUES ('you@example.com', 'SB-' || substr(md5(random()::text), 1, 8));
```

**Get the service_role key:**
Settings → API → `service_role` secret (NOT the anon/public key).

---

## 2. Wasabi Setup

1. **Create account** at https://wasabi.com (free trial, $6.99/TB/mo after)
2. **Create bucket:** `skeinbook-releases`
   - Region: `us-east-1`
   - Block all public access: **YES**
3. **Upload your installer:**
   ```
   installers/SkeinBook-0.1.0-windows.exe
   ```
   Upload via the Wasabi console or AWS CLI:
   ```bash
   aws s3 cp "SkeinBook Setup 0.1.0.exe" s3://skeinbook-releases/installers/SkeinBook-0.1.0-windows.exe \
     --endpoint-url https://s3.us-east-1.wasabisys.com
   ```
4. **Create IAM user** with programmatic access
   - Attach policy: `AmazonS3ReadOnlyAccess` (scoped to the bucket)
   - Save the Access Key ID and Secret Access Key
5. **CORS policy** (Wasabi console → bucket → Properties → CORS):
   ```json
   [
     {
       "AllowedOrigins": ["https://skeinbook.app", "https://www.skeinbook.app"],
       "AllowedMethods": ["GET"],
       "AllowedHeaders": ["*"],
       "MaxAgeSeconds": 3000
     }
   ]
   ```

---

## 3. Cloudflare Worker

### Install dependencies
```bash
cd worker
npm install
```

### Set secrets
Run each of these (you'll be prompted to paste the value):
```bash
npx wrangler secret put SUPABASE_URL
# → paste: https://jticojarihjwzdlmsnzw.supabase.co

npx wrangler secret put SUPABASE_SERVICE_KEY
# → paste: your service_role key from Supabase (eyJ...)

npx wrangler secret put WASABI_ACCESS_KEY
# → paste: your Wasabi IAM access key

npx wrangler secret put WASABI_SECRET_KEY
# → paste: your Wasabi IAM secret key

npx wrangler secret put WASABI_BUCKET
# → paste: skeinbook-releases

npx wrangler secret put WASABI_REGION
# → paste: us-east-1

npx wrangler secret put WASABI_ENDPOINT
# → paste: https://s3.us-east-1.wasabisys.com
```

### Deploy the Worker
```bash
npx wrangler deploy
```

This gives you a URL like `https://skeinbook-beta-gate.<your-account>.workers.dev`.

### Test it
```bash
curl -X POST https://skeinbook-beta-gate.<account>.workers.dev/api/download \
  -H "Content-Type: application/json" \
  -d '{"betaKey":"SB-xxxxxxxx","platform":"windows"}'
```

---

## 4. Cloudflare Pages

### Option A: Dashboard (easiest)
1. Go to Cloudflare Dashboard → Pages → Create a project
2. Connect your `skeinbook-site` GitHub repo
3. Set:
   - **Build output directory:** `public`
   - **Build command:** (leave blank — static files)
4. Deploy

### Option B: Wrangler CLI
```bash
npx wrangler pages deploy public --project-name=skeinbook-site
```

### Route the Worker through Pages
In the Cloudflare Dashboard:
1. Go to your Pages project → Settings → Functions
2. **Or** use a `_routes.json` in `public/`:
   Already created — the Worker handles `/api/*`

You'll need to configure a **Service Binding** or use Cloudflare Pages Functions. The simplest approach:

**`public/_routes.json`** (already handles static vs API routing):
```json
{
  "version": 1,
  "include": ["/*"],
  "exclude": ["/api/*"]
}
```

Then set up a **Cloudflare Route** that sends `/api/*` to the Worker:
- Workers & Pages → Routes → Add route
- Route: `skeinbook.app/api/*`
- Worker: `skeinbook-beta-gate`

---

## 5. Custom Domain

1. Cloudflare Dashboard → your Pages project → Custom domains
2. Add `skeinbook.app`
3. If DNS is still on Namecheap, you'll need to either:
   - **Transfer DNS to Cloudflare** (recommended — free, faster)
   - **Or** add a CNAME record pointing to your Pages URL

### If using Cloudflare DNS:
1. Add site `skeinbook.app` to Cloudflare
2. Cloudflare gives you two nameservers → update them in Namecheap
3. Wait for propagation (up to 24h, usually ~15min)
4. Add custom domain in Pages

---

## 6. Releasing New Versions

When you build a new installer:

1. **Upload to Wasabi:**
   ```bash
   aws s3 cp "SkeinBook Setup 0.2.0.exe" \
     s3://skeinbook-releases/installers/SkeinBook-0.2.0-windows.exe \
     --endpoint-url https://s3.us-east-1.wasabisys.com
   ```

2. **Update the Worker** — edit `CURRENT_VERSION` and `PLATFORM_FILES` in `worker/src/index.ts`:
   ```ts
   const CURRENT_VERSION = '0.2.0';
   ```

3. **Redeploy:**
   ```bash
   cd worker && npx wrangler deploy
   ```

4. **Update `download.html`** if the changelog changed.

---

## 7. Adding Beta Testers

```sql
INSERT INTO beta_users (email, beta_key, notes)
VALUES ('friend@email.com', 'SB-' || substr(md5(random()::text), 1, 8), 'Invited Mar 2026');
```

Then send them:
> "Go to skeinbook.app, enter this beta key: SB-xxxxxxxx"

---

## Cost Estimate

| Service | Cost |
|---------|------|
| Cloudflare Pages | Free |
| Cloudflare Workers | Free (100k req/day) |
| Wasabi | ~$6.99/TB/mo (you'll use < 1 GB) |
| Supabase | Free (500 MB, 50k rows) |
| **Total** | **~$0/mo for beta** |

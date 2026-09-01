# ReadVault Ebook Store

A small Express and Bootstrap ebook store with Razorpay checkout and expiring, one-use download tokens.

## Setup

```bash
npm install
cp .env.example .env
npm start
```

On Windows PowerShell, use `Copy-Item .env.example .env` instead of `cp` if needed. Add your Razorpay Key ID and Secret to `.env`, then open <http://localhost:3000>.

## Admin panel

Set a strong `ADMIN_PASSWORD` in `.env`, restart the server, and open <http://localhost:3000/admin>. The panel supports PDF and cover uploads, pricing, descriptions, highlights, editing, and deleting books. Uploaded PDFs remain private; covers are stored under `public/covers`.

## Free cloud storage setup

The app uses local JSON/files when cloud variables are absent. For hosting, copy the MongoDB Atlas and Supabase Storage variables from `.env.example` into `.env`:

- Create a free MongoDB Atlas M0 cluster, database user, and connection string.
- Create a free Supabase project and one private Storage bucket named `ebooks`.
- Copy the project URL and service-role key from Supabase project settings. Never expose the service-role key in browser code or commit it to source control.
- Keep the bucket private. The app exposes only cover objects through `/api/covers`; ebook objects stay private.

When first connected, the existing local catalog and purchase store are automatically copied into an empty MongoDB database. New uploads then go to Supabase Storage. Free tiers have usage limits; check each provider's dashboard to remain within them.

## Production deployment

Set `NODE_ENV=production`, configure every variable in `.env.example`, and use an `ADMIN_PASSWORD` of at least 16 characters. `SITE_URL` must be the final HTTPS origin, such as `https://books.example.com`.

The production process deliberately refuses to start when MongoDB, Supabase Storage, payments, the site URL, or admin security is not configured. Configure the hosting provider's health check as `/healthz`. Book pages use clean `/books/:id` URLs and include canonical metadata, Open Graph tags, Product/Book structured data, `sitemap.xml`, and `robots.txt`.

MongoDB stores books, orders, purchases, download claims, admin sessions, and rate limits as separate indexed records. The Supabase bucket must remain private. If a download connection fails before completion, its one-time token is released safely; completed downloads consume the token.

Use Razorpay test-mode credentials while developing. Only `RAZORPAY_KEY_ID` is returned to checkout; `RAZORPAY_KEY_SECRET` stays on the server. In production, put the app behind HTTPS, use persistent shared storage/locking if running multiple Node processes, and replace the included sample PDFs with the real ebooks while keeping the same catalog filenames.

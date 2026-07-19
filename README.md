<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://ai.google.dev/static/site-assets/images/share-ais-513315318.png" />
</div>

# Auto Best + LITE (Render 24/7)

## Bản full (Next.js UI)

1. `npm install`
2. `npm run dev` → giao diện đầy đủ trong browser

## Bản LITE — treo 24/7 trên Render Free (khuyến nghị)

Thư mục [`lite/`](./lite) — Express nhẹ (~70–100MB RAM), bot chạy **trên server**, UI tối giản.

```bash
cd lite
npm install
npm start
```

Chi tiết deploy + cron keep-alive: **[lite/README.md](./lite/README.md)**

- Health: `/health`
- Ping (cron): `/ping` mỗi 10–12 phút
- UI: `/?key=LITE_API_KEY`

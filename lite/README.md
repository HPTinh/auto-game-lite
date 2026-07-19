# Auto Game LITE — treo 24/7 trên Render Free

Bản **tinh gọn** của Auto Best:

| Full (Next.js) | LITE |
|---|---|
| React UI nặng, chạy trong browser | Express + HTML tối giản |
| Đóng tab = dừng bot | Bot chạy **trên server** |
| RAM cao | RAM thấp (~80–200MB) |
| Không keep-alive | `/ping` + self-ping + cron |

## Chức năng đủ để treo

- **Farm quái** (engine thật từ `lib/farmEngine`)
- **Buff** trận pháp / phù
- **Claim EXP**, **Thành tựu**, **Mail**
- **World Boss**, **Đột phá**
- **PVP** (quota ngày), **Mê cung**, **Nhập Mộng**, **Khôi Lỗi**, **Kì ngộ** (reset 12h VN)
- **Craft luyện đan** (alchemy): tải list `rpc_list_recipes`, chọn recipe, auto craft
- **VIP daily**: `rpc_get_vip_daily_status` + `rpc_claim_vip_daily` · `claimed_today` · reset 00:00 VN
- Tuỳ chọn: Auto equip, Luyện thể, Onboarding, WC checkin

UI chỉ để: thêm account, tick feature, Start/Stop, xem log.

---

## Chạy local

```bash
cd "D:\game\Trùng sinh\Auto Game\Auto Best\lite"
npm install
npm run dev
```

Mở: http://localhost:3000

(Tuỳ chọn) set key:

```bash
set LITE_API_KEY=matkhau
set PUBLIC_URL=http://localhost:3000
npm start
```

UI: `http://localhost:3000?key=matkhau`

---

## Deploy Render Free

### 1. Tạo Web Service

1. [render.com](https://render.com) → **New Web Service**
2. Connect repo chứa thư mục **Auto Best** (phải có cả `lite/` và `lib/`)
3. Cấu hình:

| Field | Value |
|---|---|
| Runtime | Node |
| Build Command | `cd lite && npm install` |
| Start Command | `cd lite && npm start` |
| Instance type | **Free** |

### 2. Environment

| Key | Gợi ý |
|---|---|
| `LITE_API_KEY` | Pass web thường (vd `0000`) — share cho người dùng |
| `LITE_BACKUP_KEY` | Pass 2 **chỉ bạn** — mở Export/Import (double-click AUTO LITE) |
| `PUBLIC_URL` | `https://YOUR-SERVICE.onrender.com` |
| `SELF_PING_MINUTES` | `10` |
| `MAX_LOGS_PER_ACCOUNT` | `60` |

**Export/Import:** luôn ẩn khi vào bằng pass web. Double-click tiêu đề **AUTO LITE** → nhập `LITE_BACKUP_KEY` → 2 nút hiện. Đóng tab = ẩn lại. API backup cũng chặn nếu sai pass 2.

### 3. Cron keep-alive (bắt buộc free tier)

Render free **ngủ sau ~15 phút không request**. Self-ping trong process **không cứu được** khi đã sleep.

Dùng cron **bên ngoài**:

1. Vào [cron-job.org](https://cron-job.org) (free) hoặc UptimeRobot
2. URL: `https://YOUR-SERVICE.onrender.com/ping`
3. Interval: **mỗi 10–12 phút**
4. Method: GET

Endpoint `/health` cũng dùng được.

### 4. Mở UI

```
https://YOUR-SERVICE.onrender.com/?key=LITE_API_KEY
```

Thêm account → **Kiểm tra** → tick feature → **Start treo**.

---

## Lưu ý Render Free

1. **750 giờ/tháng** — 1 service treo 24/7 ≈ hết quota (OK nếu chỉ 1 service).
2. **Disk ephemeral** — file `data/accounts.json` **mất khi redeploy**. Sau deploy lại cần thêm account. (Có thể export/import sau nếu cần.)
3. **Cold start** — lần wake đầu ~30–60s; cron 10 phút giữ ấm tốt hơn.
4. **Nhiều account** — farm song song tốn RAM/CPU; free nên **1–3 account** là an toàn.
5. **Không share** `LITE_BACKUP_KEY` / password account game. Pass web (`LITE_API_KEY`) có thể share.

---

## API nhanh

```
GET  /ping | /health          # public keep-alive
GET  /api/accounts            # cần x-api-key
POST /api/accounts            # { email, password, enabled[] }
POST /api/accounts/:id/check
POST /api/accounts/:id/start
POST /api/accounts/:id/stop
PATCH /api/accounts/:id/features
POST /api/start-all | /api/stop-all
```

---

## Cấu trúc

```
Auto Best/
  lib/                 # engines gốc (farm, buff, ...)
  lite/
    src/
      server.ts        # Express + API
      orchestrator.ts  # vòng lặp treo
      auth.ts          # login / JWT refresh
      store.ts         # accounts.json
    public/index.html  # UI tối giản
```

Engines **không viết lại** — import từ `../lib`, cùng logic bản full.

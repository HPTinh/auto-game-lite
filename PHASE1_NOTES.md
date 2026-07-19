# Phase 1 — Account Info Dashboard

Mục tiêu giai đoạn 1: chỉ kiểm tra/lấy thông tin tài khoản, chưa chạy farm/craft/daily/maze thật.

## Đã cập nhật

- Bấm `Kiểm tra` cho account đã chọn để login và lấy thông tin thật.
- Lấy `characterId` và tên nhân vật từ bảng `characters?select=*`.
- Lấy snapshot tổng quan qua `rpc_get_home_snapshot`.
- Lấy rank đúng qua `rpc_get_rebirth_quest_progress`:
  - `quest.rank_label`
  - `quest.total_score`
  - `realm_code`
  - `tokens`
  - `required_token`
  - `sect_name`
  - `dao_co.total`
  - `talent.dominant_element`
- Hiển thị thêm trên bảng account:
  - Nhân vật + email + characterId
  - Cấp / cảnh giới
  - Rank label + score
  - VIP
  - Cống hiến / linh thạch / token
- Khi mở detail account, có thẻ tóm tắt thông tin tài khoản.
- Thêm log chuẩn dạng `[time] [module] [level] message`.
- Tắt mock auto mặc định trong giai đoạn 1, tránh fake farm/craft sau khi account READY.

## Lưu ý

- Nút `Kiểm tra` hiện dùng API thật để login và lấy thông tin.
- Chưa gắn farm/craft/daily/maze thật.
- `VIP` vẫn dùng nhiều đường fallback từ `rpc_get_home_snapshot`. Nếu game trả field khác, cần bắt thêm response snapshot để chốt chính xác.

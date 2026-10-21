# SpotiSix

## Chạy giao diện web

Cài Node.js 22 trở lên, sau đó chạy:

```sh
npm install
npm run dev
```

## Tìm người dùng SpotiSix

Trên web và ứng dụng native, tính năng dùng Supabase Realtime Presence để kết nối người dùng SpotiSix đang mở tìm kiếm, ở bất kỳ đâu có Internet. Người dùng cần đăng nhập và cùng dùng project Supabase đã cấu hình trong `supabase-config.js`. Tên chỉ được chia sẻ trong lúc chủ động tìm kiếm; đóng hộp thoại hoặc nhấn **Hủy tìm kiếm** để ngừng chia sẻ. Web không xác định được khoảng cách vật lý.

Trong ứng dụng Android/iOS, BLE cũng được dùng để bổ sung phát hiện thiết bị ở gần. Sau khi cài dependencies:

```sh
npm run build
npm run cap:add:android
npm run cap:add:ios
npm run cap:sync
```

Thêm phần mô tả quyền Bluetooth vào `ios/App/App/Info.plist`:

```xml
<key>NSBluetoothAlwaysUsageDescription</key>
<string>SpotiSix dùng Bluetooth để tìm người dùng SpotiSix ở gần khi bạn bật tính năng này.</string>
<key>NSBluetoothPeripheralUsageDescription</key>
<string>SpotiSix phát tên hiển thị của bạn qua Bluetooth trong lúc bạn chủ động tìm kiếm.</string>
```

Mở dự án native bằng `npm run cap:open:android` hoặc `npm run cap:open:ios`, rồi chạy trên thiết bị thật có BLE. Để thấy nhau, cả hai người cần đăng nhập, bật Bluetooth, mở SpotiSix và nhấn **Bắt đầu tìm**. Radar BLE ưu tiên tín hiệu từ -78 dBm trở lên; RSSI chỉ ước lượng độ gần, không đảm bảo khoảng cách vật lý cố định. Tính năng chỉ phát tên trong khi cửa sổ tìm kiếm đang hoạt động; đóng cửa sổ hoặc nhấn **Hủy tìm kiếm** sẽ tắt cả quét lẫn phát. Hiện chưa hỗ trợ tìm kiếm khi ứng dụng chạy nền.

Android yêu cầu Android Studio và JDK 21; iOS yêu cầu macOS và Xcode. Cần chạy `npm run cap:sync` sau khi thay đổi web hoặc native plugin.

## Nghe chung và karaoke

Nghe chung cần cả hai người đăng nhập cùng project Supabase, cùng bật tìm kiếm online và chấp nhận lời mời. Chủ phòng phải phát một tệp âm thanh đã nhập vào SpotiSix; ứng dụng truyền âm thanh trực tiếp qua WebRTC, không dùng các track demo hoặc link Spotify làm nguồn âm thanh. Tắt karaoke và rời phòng nghe chung trước khi chuyển đổi giữa hai tính năng. Trình duyệt cần hỗ trợ `captureStream()` (Chrome/Firefox) hoặc karaoke cần `AudioContext`; triển khai web qua HTTPS.

Karaoke xử lý tệp người dùng đã nhập (tối đa 25 MB), yêu cầu đăng nhập và dịch vụ Supabase Edge Function cùng Replicate. Trước khi bật tính năng:

1. Chọn một model tách stem trên Replicate có input `audio` và output gồm URL vocal cùng instrumental (các tên được hỗ trợ: `vocals`/`vocal` và `instrumental`/`no_vocals`/`accompaniment`/`instruments`).
2. Áp dụng migration và cấu hình secrets trên đúng project Supabase:

   ```sh
   supabase db push
   supabase secrets set REPLICATE_API_TOKEN=... REPLICATE_DEMUCS_VERSION=...
   supabase secrets set APP_ORIGIN=https://your-spotisix-domain.example
   supabase functions deploy karaoke
   ```

   `REPLICATE_DEMUCS_VERSION` là version ID của model đã chọn. Không đặt token Replicate trong mã nguồn hoặc trình duyệt. Nếu giới hạn CORS theo domain, cấu hình `APP_ORIGIN` thành origin thực tế của web.
3. Dùng tài khoản Supabase đã đăng nhập trong ứng dụng. Nút **Bật karaoke** tải tệp lên bucket riêng tư `karaoke-inputs`; Edge Function chuyển tệp cho model rồi xóa bản tải tạm, phát đồng bộ hai stem, cho phép chỉnh âm lượng vocal và tra lyrics từ LRCLIB. Nút **Lời bài hát** trong thanh phát mở lyrics; các dòng có timestamp sẽ tự cuộn và sáng theo tiến độ bài, đồng thời có thể bấm vào dòng để tua tới đó. Nếu nguồn chỉ có lời dạng văn bản thì hiển thị nhưng không thể đồng bộ; lyrics phụ thuộc dữ liệu sẵn có trên LRCLIB.

Việc tách nhạc có thể phát sinh phí theo model Replicate đã chọn. Tệp được gửi tới Replicate để xử lý; hãy kiểm tra chính sách retention của model/provider. Các URL stem do model trả về có thể hết hạn, vì vậy kết quả không được xem là bản lưu trữ lâu dài.

## Đăng nhạc lên thư viện SpotiSix

Tệp được chọn bằng **Thêm nhạc từ thiết bị** được lưu cục bộ trong trình duyệt; chúng không tự xuất hiện với người khác. Để mọi người tìm và nghe được, hãy đăng nhập rồi dùng **Đăng nhạc lên SpotiSix** trong Thư viện. Tệp công khai được lưu trong Supabase Storage; tên bài được tìm kiếm từ bảng `published_tracks`. Chỉ đăng nhạc bạn sở hữu hoặc có quyền chia sẻ công khai. Giới hạn mỗi tệp là 50 MB.

Trước lần triển khai đầu tiên, áp dụng migration `supabase/migrations/20261012010000_community_music.sql` lên đúng Supabase project đang khai báo trong `supabase-config.js` (ví dụ dùng Supabase CLI `supabase db push` hoặc chạy nội dung migration qua SQL Editor của Supabase). Sau đó triển khai lại website để có nút đăng và tìm nhạc cộng đồng. Nếu migration chưa được áp dụng, tìm kiếm sẽ hiển thị lỗi backend thay vì coi như không có kết quả.

**Thêm nhạc từ thiết bị** lưu các tệp trong IndexedDB của trình duyệt để chúng còn trong playlist **Nhạc trên thiết bị** sau khi tải lại hoặc đóng/mở lại trang. Tệp chỉ được lưu trên thiết bị và trình duyệt đó; xóa dữ liệu website/trình duyệt sẽ xóa các bản lưu. Để nghe trên thiết bị khác hoặc chia sẻ với mọi người, dùng **Đăng nhạc lên SpotiSix**.

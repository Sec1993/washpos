# HANDOFF — WashPOS Cuci Motor/Mobil

**Tujuan:** Pindah ke Gemini CLI hemat token — baca ini dulu, jangan baca semua `server.js`/`views/*.ejs` sekaligus.

## 1. Ringkas
POS kasir cuci motor/mobil + inventory + laporan + absen foto+GPS + kas Besar/Kecil/QRIS/Bank. **Phase 0-7 DONE** `TODO` hapus, `http://localhost:3000` & `https://laptop-okfpc1bk.tailea0022.ts.net` (Tailscale) jalan, `https://washpos-production.up.railway.app` 502 (fix 0.0.0.0 + PORT sudah push `47de5ac`), APK Capacitor `com.washpos.app` + Expo `WashPOS-Mobile` `sdk 57` di `C:\Users\wkonj\Desktop\WashPOS-Mobile` siap EAS.

## 2. Stack
Node 20 + Express + EJS + Bootstrap5 + Chart.js + SQLite `pos.db` (auto-create) + `multer` `public/uploads` + `express-session` `bcryptjs` + Capacitor 8 + Tailscale `100.69.213.53`

## 3. Struktur Penting
- `server.js:1` — semua route, `PORT=process.env.PORT||3000` `0.0.0.0`, `activeLogins`, `parseRupiah`, `POST /sales` multi, `POST /expenses` foto+stok, `POST /kas/transfer`, `GET /absen`, `GET /reports` filter/pagination, `GET /akun`, `GET /kas/kecil`, `GET /karyawan-aktif`
- `database.js:1` — `users`, `services`, `workers`, `sales`, `expenses(photo)`, `inventory(min_stock)`, `stock_history`, `journals` (trigger `no_delete/update_journal`), `expense_categories`, `attendance`, `accounts` (Kas/Bank/QRIS)
- `views/` — `layout.ejs` (navbar RBAC + Kas Kecil badge klik `/kas/kecil`), `login.ejs`, `sales.ejs` (multi checkbox, Kas Kecil/QRIS), `receipt.ejs` thermal, `expenses.ejs` (Galeri+Kamera), `inventory.ejs` (min_stock+history), `reports.ejs` (Jurnal/Buku Besar/Laba Rugi/Neraca+transfer), `dashboard.ejs` (KPI+low stock), `absen.ejs` (kamera overlay lokasi+jam), `akun.ejs` (edit/hapus), `kas-kecil.ejs`, `karyawan-aktif.ejs`
- `capacitor.config.json:1` — `https://laptop-okfpc1bk.tailea0022.ts.net` (HTTPS Tailscale Serve)
- `WashPOS-Mobile/` — Expo `sdk 57` tabs, `eas.json` `a2a20e70...`, build `0054b238` APK di `https://expo.dev/accounts/sec1993/projects/WashPOS-Mobile/builds/0054b238...`

## 4. DB Schema Singkat
`users(id,username,password,role)` `owner/owner123` `karyawan/karyawan123`
`services(name,price,category,isActive)` `workers(name)` `sales(customer_name,license_plate,service_name,price,worker_name,admin_name)` `expenses(category,amount,description,photo,admin_name)` `inventory(name,unit,stock,min_stock)` `journals(description,debit,credit,account_type)` `accounts(name,type)` `attendance(user_id,username,date,time,type,photo,lat,lng)`

## 5. API Penting
`POST /login` `GET /sales?from&to&search&page&limit` `POST /sales` (multi service_names, akun_kas Kas Kecil/QRIS) `GET /expenses` `POST /expenses` (photo, stock_item_id) `GET /inventory` `POST /inventory/update` `GET /akun` `POST /akun/tambah|edit|hapus` `POST /kas/transfer` `GET /kas/kecil` `GET /absen` `POST /absen` `GET /reports?from&to&page&limit` `GET /karyawan-aktif` `GET /health` `GET /api/service-price?name=`

## 6. Yang Mau Disempurnakan di Gemini (isi)
- [ ] Contoh: UI nota thermal QR/logo, notifikasi WA selesai cuci, offline PWA, dll — **tulis di sini biar Gemini langsung fokus**

## 7. Cara Jalan
`npm start` → `http://localhost:3000/login` atau Tailscale `https://laptop-okfpc1bk.tailea0022.ts.net/login` (HP Tailscale Connected). `npx cap sync` untuk APK, `eas build -p android --profile preview` untuk Expo.

## 8. Catatan Token Hemat
Jangan baca `pos.db` 500KB + `views/*.ejs` 15 file tiap chat — baca `HANDOFF.md` ini dulu, lalu tanya file spesifik jika perlu.

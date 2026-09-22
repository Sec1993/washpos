# WashPOS - Kasir Cuci Mobil/Motor

Aplikasi kasir & manajemen cuci kendaraan — POS + Inventory + Absen + Laporan + Kas Besar/Kecil. **Phase 0-6 DONE, Phase 7 polish.**

## Stack
- Node.js 20 + Express + EJS + Bootstrap 5 + Chart.js
- SQLite (`pos.db`, auto-create) + `multer` uploads
- Auth `express-session` + `bcryptjs` RBAC Owner/Karyawan
- Jurnal double-entry: `Debit Kas Kecil/Besar / Kredit Pendapatan` & `Debit Biaya / Kredit Kas Kecil`

## Jalankan Lokal & Docker (7.5)

**Lokal:**
```bash
npm install
npm start        # http://localhost:3000
npm run dev      # nodemon
npm run test:e2e # node test-e2e.js
```

**Docker Production (7.5):**
```bash
docker-compose up --build -d
# cek: http://localhost:3000/login
docker-compose logs -f
```

File: `Dockerfile` (node:20-alpine, `npm ci --only=production`, `public/uploads` mkdir) + `docker-compose.yml` (port 3000:3000, volume `pos.db` & `uploads`, healthcheck `/login`)

## Akun Default (seed `database.js:124`)
- **Owner:** `owner` / `owner123` — Dashboard, Master, Laporan, Transfer Kas, Karyawan Aktif, Absen (semua)
- **Karyawan:** `karyawan` / `karyawan123` — Penjualan, Pengeluaran (Kas Kecil outlet), Stok, Absen (kamera wajib), tidak bisa Master/Laporan/Karyawan Aktif (403)

> Ganti password: langsung di DB `UPDATE users SET password='<hash>' WHERE username='karyawan'` (hash via `node -e "console.log(require('bcryptjs').hashSync('barupass',10))"`), atau hapus `pos.db` untuk re-seed.

## Reset Password CLI (7.7)
```bash
node -e "const b=require('bcryptjs'); console.log(b.hashSync('owner123',10))"
# copy hash, lalu:
node -e "const db=require('./database'); setTimeout(()=>{db.run(\"UPDATE users SET password='\$2a\$10\$...' WHERE username='owner'\", ()=>{console.log('ok'); process.exit(0)})},800)"
# atau reset total:
rm pos.db && npm start # re-seed otomatis
```

## Fitur Utama
- **Penjualan** multi-layanan checkbox, harga `rupiah` auto-sum, Kas Kecil badge klik → `/kas/kecil` history
- **Pengeluaran** kategori dinamis, nominal `rupiah`, foto nota Galeri+Kamera 3MB + integrasi Stok IN, Kas Kecil outlet
- **Stok** `min_stock`, `stock_history` 20, hapus, update ≥1, low alert Dashboard
- **Absen** `views/absen.ejs` wajib kamera (no galeri), overlay lokasi+jam di dalam foto, geolocation + Nominatim
- **Karyawan Aktif** `GET /karyawan-aktif` Owner lihat sesi login + jam mulai + durasi
- **Laporan** filter `from/to`, pagination, Jurnal/Buku Besar/Laba Rugi/Neraca pisah Kas Kecil/Besar, transfer `Kecil↔Besar` + `Chart.js` tren 7 hari, export CSV `jurnalTable` + print PDF
- **Kas** `Kas Kecil (Outlet)` untuk semua transaksi karyawan, `Kas Besar (Pusat)` hanya via `POST /kas/transfer` Owner

## Hardening Jurnal (7.4)
- `database.js:84` trigger `no_delete_journal` & `no_update_journal` `RAISE(ABORT, 'Jurnal tidak boleh...')` — hanya INSERT + reversal

## UX Polish (7.1)
- `views/layout.ejs` toast `appToast`, loading spinner di `button[type=submit]`, empty state `Tidak ada ... sesuai filter`, format Rupiah live, confirm dialog `Hapus?`, `validateRupiahForm`

## Validasi (7.2)
- BE `parseRupiah` + `isValidName` + `isValidPlat` (`/^[A-Z0-9 ]{2,10}$/i`), FE `validateRupiahForm`, `validatePenjualan` min 1 layanan, `validateAbsen`

## E2E Test (7.3)
```bash
node test-e2e.js
# Staff login → GET /sales OK → POST /sales OK → Owner GET /reports OK → Staff GET /reports 403 → Karyawan Aktif OK
```

## Smoke Test Deploy (7.6)
```bash
curl http://localhost:3000/login # 200
# login Owner cek Dashboard KPI + lowStock + Kas Kecil/Besar + tren
# login Karyawan cek Penjualan Kas Kecil badge clickable → /kas/kecil history
```

## Env & Port
- `PORT=3000` default, `NODE_ENV=production` di Docker

## Struktur
```
CuciMotorPOS/
├── server.js
├── database.js
├── views/ (layout, dashboard, sales, receipt, expenses, inventory, reports, master, absen, karyawan-aktif, kas-kecil)
├── public/uploads/ & uploads/absen/
├── pos.db
├── Dockerfile
├── docker-compose.yml
└── test-e2e.js
```

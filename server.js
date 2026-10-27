process.env.TZ = 'Asia/Makassar';
const express = require('express');
const session = require('express-session');
// Waktu WITA (+8)
function getWitaTime() { return new Date(new Date().getTime() + 8 * 3600 * 1000); }
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const db = require('./database');
const cloudSync = require('./cloudSync');
const discord = require('./discord');

const app = express();
const PORT = process.env.PORT || 3000;

const expressLayouts = require('express-ejs-layouts');

// Setup Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
const uploadStaticDir = path.join(__dirname, 'data', 'uploads');
app.use('/uploads', express.static(uploadStaticDir));
app.use(express.static(path.join(__dirname, 'public')));
app.use(expressLayouts);
app.set('layout', 'layout');
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Session config — allow cross-site via tunnel (https) & http local
app.use(session({
    secret: process.env.SESSION_SECRET || 'pos_cuci_motor_secret',
    resave: false,
    saveUninitialized: true,
    cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: false, // false agar http 192.168 juga bisa, true hanya https (tunnel akan tetap kirim karena lax)
        maxAge: 24*60*60*1000
    }
}));
app.set('trust proxy', 1);

// Track karyawan login aktif
const activeLogins = {}; // sessionID -> {id, username, role, loginTime, lastSeen, ip}

// Auth Middleware
function requireLogin(req, res, next) {
    if (req.session.user) {
        // update lastSeen
        if (activeLogins[req.sessionID]) activeLogins[req.sessionID].lastSeen = new Date().toISOString();
        else if (req.session.loginTime) {
            // restore jika restart
            activeLogins[req.sessionID] = { id: req.session.user.id, username: req.session.user.username, role: req.session.user.role, loginTime: req.session.loginTime, lastSeen: new Date().toISOString(), ip: req.ip };
        }
        next();
    } else {
        res.redirect('/login');
    }
}

function requireOwner(req, res, next) {
    if (req.session.user && req.session.user.role === 'owner') {
        if (activeLogins[req.sessionID]) activeLogins[req.sessionID].lastSeen = new Date().toISOString();
        next();
    } else {
        res.status(403).send('Akses ditolak. Halaman ini khusus Owner.');
    }
}

function requireAdminOrOwner(req, res, next) {
    if (!req.session.user) return res.redirect('/login');
    if (activeLogins[req.sessionID]) activeLogins[req.sessionID].lastSeen = new Date().toISOString();
    if (req.session.user.role === 'owner' || req.session.user.role === 'admin') {
        next();
    } else {
        // Khusus role karyawan: dialihkan hanya ke menu absen
        res.redirect('/absen');
    }
}

// Helper: parse Rupiah (terima "15.000", "15,000", "Rp 15.000", "15000", atau 0)
function parseRupiah(val) {
    if (val === 0 || val === '0') return 0;
    if (!val) return NaN;
    const digits = String(val).replace(/[^0-9]/g, '');
    return digits ? parseInt(digits, 10) : NaN;
}
function isValidName(name, min=2) {
    return typeof name === 'string' && name.trim().length >= min && name.trim().length <= 50;
}
function isValidPlat(plat){
    return typeof plat === 'string' && /^[A-Z0-9 -]{2,12}$/i.test(plat.trim());
}

// Multer setup untuk upload foto nota pengeluaran & bukti pembayaran QRIS
const uploadDir = path.join(__dirname, 'data', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        const isSales = (req.originalUrl && req.originalUrl.includes('/sales')) || file.fieldname === 'payment_proof';
        const prefix = isSales ? 'qris_' : 'nota_';
        const name = prefix + Date.now() + '_' + Math.round(Math.random()*1e6) + ext;
        cb(null, name);
    }
});
const upload = multer({
    storage,
    limits: { fileSize: 4 * 1024 * 1024 }, // max 4MB
    fileFilter: (req, file, cb) => {
        const allowed = ['.jpg','.jpeg','.png','.webp','.gif'];
        const ext = path.extname(file.originalname).toLowerCase();
        if (allowed.includes(ext)) cb(null, true);
        else cb(new Error('Hanya file gambar (jpg, png, webp) yang diperbolehkan'));
    }
});

// Supabase Cloud Storage Client (Penyimpanan Foto Cloud Otomatis via REST API)
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qhclkhpymihmlbmecpdv.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFoY2xraHB5bWlobWxibWVjcGR2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc5MTg3MDI1NSwiZXhwIjoyMTA3NDQ2MjU1fQ.57ug7wMvZuMORmZ2eVvk_2q5SFF8UPZNpQTQD0wqIFU';
const SUPABASE_BUCKET = 'washpos-photos';

async function uploadToSupabase(filePath, remoteFileName, mimeType) {
    try {
        if (!fs.existsSync(filePath)) return null;
        const fileBuffer = fs.readFileSync(filePath);
        const endpoint = `${SUPABASE_URL}/storage/v1/object/${SUPABASE_BUCKET}/${remoteFileName}`;
        const res = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
                'apikey': SUPABASE_SERVICE_KEY,
                'Content-Type': mimeType || 'image/jpeg',
                'x-upsert': 'true'
            },
            body: fileBuffer
        });

        if (!res.ok) {
            const errText = await res.text();
            console.error('Supabase upload error:', errText);
            return null;
        }

        const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${SUPABASE_BUCKET}/${remoteFileName}`;
        // Hapus file lokal setelah berhasil upload agar storage server Railway tetap bersih
        try { fs.unlinkSync(filePath); } catch (e) {}
        console.log('Foto berhasil terupload ke Supabase Storage:', publicUrl);
        return publicUrl;
    } catch (err) {
        console.error('Gagal mengupload ke Supabase Storage:', err);
        return null;
    }
}

// Healthcheck untuk Railway
app.get('/health', (req, res) => res.status(200).send('OK'));

// Pass user + loginTime to all views
app.use((req, res, next) => {
    res.locals.user = req.session.user;
    res.locals.loginTime = req.session.loginTime || null;
    next();
});

// Routes - Auth
// Health check for Railway (no auth required)
app.get('/healthz', (req, res) => {
    res.status(200).send('OK');
});

app.get('/login', (req, res) => {
    res.render('login', { error: null });
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    db.get('SELECT * FROM users WHERE username = ?', [username], (err, row) => {
        if (err) { console.error(err); return res.status(500).send('DB error login <a href="/login">Kembali</a>'); }
        if (row && bcrypt.compareSync(password, row.password)) {
            req.session.user = { id: row.id, username: row.username, role: row.role };
            req.session.loginTime = new Date().toISOString();
            activeLogins[req.sessionID] = { id: row.id, username: row.username, role: row.role, loginTime: req.session.loginTime, lastSeen: new Date().toISOString(), ip: req.ip, userAgent: req.headers['user-agent']||'' };
            if (row.role === 'owner') {
                res.redirect('/');
            } else if (row.role === 'admin') {
                res.redirect('/sales');
            } else {
                res.redirect('/absen');
            }
        } else {
            res.render('login', { error: 'Username atau password salah!' });
        }
    });
});

app.get('/logout', (req, res) => {
    if (req.sessionID && activeLogins[req.sessionID]) delete activeLogins[req.sessionID];
    req.session.destroy();
    res.redirect('/login');
});

// Lihat karyawan aktif login (Owner only)
app.get('/karyawan-aktif', requireOwner, (req, res) => {
    // bersihkan sesi kadaluarsa >30 menit tidak aktif
    const now=Date.now();
    Object.keys(activeLogins).forEach(sid=>{
        if(now - new Date(activeLogins[sid].lastSeen).getTime() > 30*60*1000) delete activeLogins[sid];
    });
    const list=Object.values(activeLogins).sort((a,b)=> new Date(b.loginTime)-new Date(a.loginTime));
    res.render('karyawan-aktif', { list });
});

app.get('/api/active-logins', requireOwner, (req,res)=>{
    res.json(Object.values(activeLogins));
});

// --- Absen Karyawan dengan Foto + Lokasi + Jam ---
const absenUploadDir = path.join(__dirname, 'data', 'uploads', 'absen');
if (!fs.existsSync(absenUploadDir)) fs.mkdirSync(absenUploadDir, { recursive: true });
const absenStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, absenUploadDir),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
        const name = 'absen_' + Date.now() + '_' + req.session.user.username + ext;
        cb(null, name);
    }
});
const absenUpload = multer({
    storage: absenStorage,
    limits: { fileSize: 4 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowed = ['.jpg','.jpeg','.png','.webp'];
        const ext = path.extname(file.originalname).toLowerCase();
        if (allowed.includes(ext)) cb(null, true);
        else cb(new Error('Hanya foto jpg/png/webp'));
    }
});

app.get('/absen', requireLogin, (req, res) => {
    const today = getWitaTime().toISOString().slice(0,10);
    const uid = req.session.user.id;
    const isOwner = req.session.user.role === 'owner' || req.session.user.role === 'admin';
    // ambil absen hari ini untuk user ini
    db.all("SELECT * FROM attendance WHERE user_id=? AND date=? ORDER BY time ASC", [uid, today], (e, todayRows)=>{
        // untuk owner, tampilkan semua absen hari ini
        const whereOwner = isOwner ? "WHERE date=?" : "WHERE user_id=? AND date=?";
        const paramsOwner = isOwner ? [today] : [uid, today];
        db.all(`SELECT * FROM attendance ${whereOwner} ORDER BY datetime DESC LIMIT 20`, paramsOwner, (e, recent)=>{
            // history mingguan untuk user
            db.all("SELECT * FROM attendance WHERE user_id=? ORDER BY datetime DESC LIMIT 30", [uid], (e, history)=>{
                res.render('absen', { todayRows: todayRows||[], recent: recent||[], history: history||[], isOwner, today });
            });
        });
    });
});

app.post('/absen', requireLogin, absenUpload.single('photo'), async (req, res) => {
    const { type, latitude, longitude, address } = req.body;
    const t = (type==='keluar' ? 'keluar' : 'masuk');
    if (!req.file) return res.status(400).send('Validasi gagal: Foto wajib. <a href="/absen">Kembali</a>');
    const lat = latitude ? parseFloat(latitude) : null;
    const lng = longitude ? parseFloat(longitude) : null;
    // lokasi opsional — jika tidak ada, tetap simpan dengan 0,0
    const finalLat = lat || 0;
    const finalLng = lng || 0;
    const finalAddr = address || (lat ? `${lat}, ${lng}` : 'Lokasi tidak tersedia');
    const wita = getWitaTime();
    const date = wita.toISOString().slice(0,10);
    const time = wita.toISOString().slice(11,19);
    const datetime = wita.toISOString();
    const uid = req.session.user.id;
    const username = req.session.user.username;
    db.get("SELECT * FROM attendance WHERE user_id=? AND date=? AND type=?", [uid, date, t], async (e,row)=>{
        if (row) {
            try { fs.unlinkSync(req.file.path); } catch(e){}
            return res.status(400).send(`Sudah absen ${t} hari ini jam ${row.time}. <a href="/absen">Kembali</a>`);
        }
        let photo = '/uploads/absen/' + path.basename(req.file.path);
        const remoteName = 'absen/' + path.basename(req.file.path);
        const cloudUrl = await uploadToSupabase(req.file.path, remoteName, req.file.mimetype);
        if (cloudUrl) photo = cloudUrl;

        db.run("INSERT INTO attendance (user_id, username, date, time, datetime, type, photo, latitude, longitude, address) VALUES (?,?,?,?,?,?,?,?,?,?)",
            [uid, username, date, time, datetime, t, photo, finalLat, finalLng, finalAddr], (err)=>{
                if (err) { 
                    try { fs.unlinkSync(req.file.path); } catch(e){}
                    return res.status(500).send('Gagal simpan absen: '+err.message); 
                }
                res.redirect('/absen');
            });
    });
});

// Route - Dashboard / Default (5.7 low stock + 6.11 KPI + kas besar/kecil)
app.get('/', requireLogin, (req, res) => {
    if (req.session.user.role === 'owner') {
        db.all("SELECT * FROM inventory WHERE stock <= COALESCE(min_stock,5) ORDER BY stock ASC", (err, lowStock) => {
            const today=getWitaTime().toISOString().slice(0,10);
            const firstDay=getWitaTime().toISOString().slice(0,8) + '01';
            db.all("SELECT * FROM journals", (e, journals)=>{
                let kasBesar=0, kasKecil=0, totalKasDynamic=0;
                const isKasDynamic = (t)=> t!=='Pendapatan' && t!=='Biaya';
                (journals||[]).forEach(j=>{
                    if(isKasDynamic(j.account_type)) totalKasDynamic+= j.debit - j.credit;
                    if(j.account_type==='Kas Besar') kasBesar+= j.debit - j.credit;
                    else if(j.account_type==='Kas Kecil' || j.account_type==='Kas') kasKecil+= j.debit - j.credit;
                });
                db.get("SELECT COUNT(*) as c, COALESCE(SUM(price),0) as omzet FROM sales WHERE date(date)=date('now')", (e, todaySales)=>{
                    db.get("SELECT COALESCE(SUM(price),0) as omzet FROM sales WHERE date(date) >= date(?)", [firstDay], (e, bulanSales)=>{
                        db.get("SELECT COALESCE(SUM(amount),0) as total FROM expenses WHERE date(date)=date('now')", (e, todayExp)=>{
                            db.all("SELECT COUNT(*) as c FROM sales", (e, sRow)=>{
                                db.all("SELECT COUNT(*) as c FROM expenses", (e, eRow)=>{
                                    db.all("SELECT date(date) as tgl, COUNT(*) as trx, COALESCE(SUM(price),0) as omzet FROM sales WHERE date(date) >= date('now','-6 days') GROUP BY date(date) ORDER BY tgl ASC", (e, tren)=>{
                                        db.get("SELECT COALESCE(SUM(amount),0) as total FROM expenses WHERE date(date) >= date(?)", [firstDay], (e, bulanExp)=>{
                                            const labaHari=(todaySales?todaySales.omzet:0)-(todayExp?todayExp.total:0);
                                            const labaBulan=(bulanSales?bulanSales.omzet:0)-(bulanExp?bulanExp.total:0);
                                            res.render('dashboard', { lowStock: lowStock||[], totalSales: sRow? sRow[0].c:0, totalExpenses: eRow? eRow[0].c:0, kpiTodaySales: todaySales||{c:0,omzet:0}, kpiBulanOmzet: bulanSales?bulanSales.omzet:0, kpiTodayExp: todayExp?todayExp.total:0, labaHari, labaBulan, tren: tren||[], kasBesar, kasKecil, totalKas: kasBesar+kasKecil });
                                        });
                                    });
                                });
                            });
                        });
                    });
                });
            });
        });
    } else if (req.session.user.role === 'admin') {
        res.redirect('/sales');
    } else {
        res.redirect('/absen');
    }
});

// Routes - Sales (Phase 3 formal: filter tanggal, search, pagination + kas kecil + akun dinamis)
app.get('/sales', requireAdminOrOwner, (req, res) => {
    const { from, to, search, page, limit } = req.query;
    const pageNum = Math.max(1, parseInt(page) || 1);
    const limitNum = Math.min(50, Math.max(5, parseInt(limit) || 10));
    const offset = (pageNum - 1) * limitNum;

    let where = [];
    let params = [];
    if (from) { where.push("date(date) >= date(?)"); params.push(from); }
    if (to) { where.push("date(date) <= date(?)"); params.push(to); }
    if (search && String(search).trim()) {
        const s = `%${String(search).trim()}%`;
        where.push("(customer_name LIKE ? OR license_plate LIKE ? OR service_name LIKE ? OR worker_name LIKE ?)");
        params.push(s, s, s, s);
    }
    const whereClause = where.length ? "WHERE " + where.join(" AND ") : "";

    db.all("SELECT * FROM services WHERE isActive=1 ORDER BY name ASC", (err, services) => {
        db.all("SELECT * FROM workers ORDER BY name ASC", (err, workers) => {
            db.all("SELECT * FROM accounts WHERE (name='Kas Kecil' OR type='QRIS') ORDER BY type, name ASC", (e, akunBayar)=>{
                db.all("SELECT * FROM journals WHERE account_type IN ('Kas Kecil','Kas')", (e, kasRows)=>{
                    let kasKecil=0;
                    (kasRows||[]).forEach(j=> kasKecil+= j.debit - j.credit);
                    db.get(`SELECT COUNT(*) as total FROM sales ${whereClause}`, params, (err, countRow) => {
                        const total = countRow ? countRow.total : 0;
                        const totalPages = Math.max(1, Math.ceil(total / limitNum));
                        const safePage = Math.min(pageNum, totalPages);
                        const safeOffset = (safePage - 1) * limitNum;
                        db.all(`SELECT * FROM sales ${whereClause} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limitNum, safeOffset], (err, recentSales) => {
                            res.render('sales', { services, workers, accounts: akunBayar, recentSales, total, totalPages, currentPage: safePage, limit: limitNum, query: { from: from||'', to: to||'', search: search||'' }, kasKecil });
                        });
                    });
                });
            });
        });
    });
});

app.post('/sales', requireAdminOrOwner, upload.single('photo'), (req, res) => {
    const { customer_name, license_plate, price, worker_name, akun_kas } = req.body;
    // dukung multi layanan: service_names bisa array, atau service_name single (backward compat)
    let serviceNames = req.body.service_names || req.body.service_name;
    if (!serviceNames) serviceNames = [];
    if (!Array.isArray(serviceNames)) serviceNames = [serviceNames];
    serviceNames = serviceNames.filter(s=>s && String(s).trim()).map(s=>String(s).trim());
    const service_name = serviceNames.join(', ');
    const admin_name = req.session.user.username;
    const salePrice = parseRupiah(price);
    let kasAkun = akun_kas && String(akun_kas).trim() ? String(akun_kas).trim() : 'Kas Kecil';

    if (!isValidName(customer_name,2) || !isValidPlat(license_plate) || serviceNames.length===0 || !worker_name) {
        if (req.file) { try { fs.unlinkSync(req.file.path); } catch(e){} }
        return res.status(400).send('Validasi gagal: Nama (≥2) / Plat alfanumerik 2-10 (contoh B 1234 ABC) / Pekerja wajib & pilih minimal 1 layanan. <a href="/sales">Kembali</a>');
    }
    if (isNaN(salePrice) || salePrice < 1000) {
        if (req.file) { try { fs.unlinkSync(req.file.path); } catch(e){} }
        return res.status(400).send('Validasi gagal: Harga harus angka ≥ 1000 (boleh format 15.000). <a href="/sales">Kembali</a>');
    }
    // validasi akun kas: penjualan hanya Kas Kecil & QRIS
    db.all("SELECT name, type FROM accounts WHERE name='Kas Kecil' OR type='QRIS'", (e, accRows)=>{
        const accMap = new Map((accRows||[]).map(r=>[r.name, r.type]));
        if (!accMap.has(kasAkun)) kasAkun='Kas Kecil';

        // Validasi wajib foto bukti jika QRIS
        const isQris = accMap.get(kasAkun) === 'QRIS' || kasAkun.toLowerCase().includes('qris');
        if (isQris && !req.file) {
            return res.status(400).send('Validasi gagal: Transaksi QRIS WAJIB melampirkan foto bukti pembayaran! <a href="/sales">Kembali</a>');
        }

        db.all('SELECT name, price, commission FROM services WHERE isActive=1', async (e, rows)=>{
            const validNames = new Set((rows||[]).map(r=>r.name));
            const invalid = serviceNames.filter(n=>!validNames.has(n));
            if (invalid.length>0) {
                if (req.file) { try { fs.unlinkSync(req.file.path); } catch(e){} }
                return res.status(400).send('Validasi gagal: Layanan tidak valid: '+invalid.join(', ')+' <a href="/sales">Kembali</a>');
            }

            // Hitung total komisi pencuci
            let totalKomisi = 0;
            const serviceMap = new Map((rows||[]).map(r=>[r.name, r]));
            serviceNames.forEach(name => {
                const svc = serviceMap.get(name);
                if (svc && typeof svc.commission === 'number') {
                    totalKomisi += svc.commission;
                }
            });

            let photoUrl = null;
            if (req.file) {
                photoUrl = '/uploads/' + req.file.filename;
                const remoteName = 'qris/' + req.file.filename;
                const cloudUrl = await uploadToSupabase(req.file.path, remoteName, req.file.mimetype);
                if (cloudUrl) photoUrl = cloudUrl;
            }

            db.serialize(() => {
                const phoneNum = String(req.body.phone || '').trim();
                db.run(`INSERT INTO sales (customer_name, license_plate, service_name, price, worker_name, admin_name, phone, akun_kas, photo, commission) 
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, 
                        [customer_name, license_plate, service_name, salePrice, worker_name, admin_name, phoneNum, kasAkun, photoUrl, totalKomisi], function(err) {
                    if (err) {
                        console.error(err);
                        if (req.file && !photoUrl.startsWith('http')) { try { fs.unlinkSync(req.file.path); } catch(e){} }
                        return res.status(500).send('Gagal simpan penjualan: '+err.message+' <a href="/sales">Kembali</a>');
                    }
                    const saleId = this.lastID;
                    const layananDesc = serviceNames.length>1 ? `(${serviceNames.join(' + ')})` : serviceNames[0];
                    db.run(`INSERT INTO journals (description, debit, credit, account_type) VALUES (?, ?, ?, ?)`,
                        [`Pendapatan Jasa Cuci - Plat: ${license_plate} ${layananDesc} → ${kasAkun}`, salePrice, 0, kasAkun]);
                    db.run(`INSERT INTO journals (description, debit, credit, account_type) VALUES (?, ?, ?, ?)`,
                        [`Pendapatan Jasa Cuci - Plat: ${license_plate} ${layananDesc} → ${kasAkun}`, 0, salePrice, 'Pendapatan']);
                    res.redirect('/receipt/' + saleId);
                });
            });
        });
    });
});

// Route - Receipt
app.get('/receipt/:id', requireAdminOrOwner, (req, res) => {
    const saleId = req.params.id;
    db.get("SELECT * FROM sales WHERE id = ?", [saleId], (err, sale) => {
        if (err || !sale) return res.send('Transaksi tidak ditemukan.');
        res.render('receipt', { sale });
    });
});

// Routes - Expenses (Phase 4 formal: filter tanggal, search, pagination + foto + stok integrasi 5.4)
app.get('/expenses', requireAdminOrOwner, (req, res) => {
    const { from, to, search, page, limit } = req.query;
    const pageNum = Math.max(1, parseInt(page) || 1);
    const limitNum = Math.min(50, Math.max(5, parseInt(limit) || 10));
    let where = [];
    let params = [];
    if (from) { where.push("date(date) >= date(?)"); params.push(from); }
    if (to) { where.push("date(date) <= date(?)"); params.push(to); }
    if (search && String(search).trim()) {
        const s = `%${String(search).trim()}%`;
        where.push("(category LIKE ? OR description LIKE ? OR admin_name LIKE ?)");
        params.push(s, s, s);
    }
    const whereClause = where.length ? "WHERE " + where.join(" AND ") : "";
    db.all("SELECT * FROM expense_categories ORDER BY name ASC", (err, categories) => {
        db.all("SELECT * FROM inventory ORDER BY name ASC", (err, inventory) => {
            db.all("SELECT * FROM accounts ORDER BY type, name ASC", (err, accounts) => {
                db.get(`SELECT COUNT(*) as total FROM expenses ${whereClause}`, params, (err, row) => {
                    const total = row ? row.total : 0;
                    const totalPages = Math.max(1, Math.ceil(total / limitNum));
                    const safePage = Math.min(pageNum, totalPages);
                    const offset = (safePage - 1) * limitNum;
                    db.all(`SELECT * FROM expenses ${whereClause} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limitNum, offset], (err, expenses) => {
                        res.render('expenses', { expenses, categories, inventory, accounts, total, totalPages, currentPage: safePage, limit: limitNum, query: { from: from||'', to: to||'', search: search||'' } });
                });
            });
        });
    });
    });
});

app.post('/expenses', requireAdminOrOwner, upload.single('photo'), (req, res) => {
    const { category, amount, description, stock_item_id, stock_qty, akun_kas } = req.body;
    const expenseAmount = parseRupiah(amount);
    let kasAkun = akun_kas && String(akun_kas).trim() ? String(akun_kas).trim() : 'Kas Kecil';
    if (req.session.user.role !== 'owner' && kasAkun !== 'Kas Kecil') kasAkun = 'Kas Kecil';
    if (!category) {
        if (req.file) fs.unlinkSync(req.file.path);
        return res.status(400).send('Validasi gagal: Kategori wajib dipilih. <a href="/expenses">Kembali</a>');
    }
    if (isNaN(expenseAmount) || expenseAmount < 1000) {
        if (req.file) fs.unlinkSync(req.file.path);
        return res.status(400).send('Validasi gagal: Nominal harus ≥ 1000 (boleh 50.000). <a href="/expenses">Kembali</a>');
    }
    const admin_name = req.session.user.username;
    const photo = req.file ? '/uploads/' + req.file.filename : null;
    // 5.4 integrasi stok: jika ada stock_item_id & stock_qty, update stok IN
    const needStock = stock_item_id && String(stock_item_id).trim() && stock_qty && String(stock_qty).trim();
    let stockQty = null;
    if (needStock) {
        stockQty = parseFloat(String(stock_qty).replace(',', '.'));
        if (isNaN(stockQty) || stockQty < 1) {
            if (req.file) fs.unlinkSync(req.file.path);
            return res.status(400).send('Validasi gagal: Jumlah stok minimal 1. <a href="/expenses">Kembali</a>');
        }
    }
    // validasi akun kas ada + cek saldo Kas/Bank tidak minus
    db.all('SELECT name FROM accounts', (e, accRows)=>{
        const akunValid=new Set((accRows||[]).map(r=>r.name));
        if(!akunValid.has(kasAkun)) kasAkun='Kas Kecil';
        // cek saldo kas/bank/qris cukup (jangan minus)
        db.get("SELECT COALESCE(SUM(debit - credit),0) as saldo FROM journals WHERE account_type=?", [kasAkun], (e, row)=>{
            let saldo=row?row.saldo:0;
            // Kas lama 'Kas' dianggap Kas Kecil
            if(kasAkun==='Kas Kecil'){
                db.get("SELECT COALESCE(SUM(debit - credit),0) as s FROM journals WHERE account_type='Kas'", (e2, r2)=>{
                    saldo+= r2?r2.s:0;
                    if(saldo < expenseAmount){
                        if(req.file) fs.unlinkSync(req.file.path);
                        return res.status(400).send(`Saldo ${kasAkun} tidak cukup (Rp ${saldo.toLocaleString('id-ID')}, perlu Rp ${expenseAmount.toLocaleString('id-ID')}). <a href="/expenses">Kembali</a>`);
                    }
                    doInsert();
                });
            } else {
                if(saldo < expenseAmount){
                    if(req.file) fs.unlinkSync(req.file.path);
                    return res.status(400).send(`Saldo ${kasAkun} tidak cukup (Rp ${saldo.toLocaleString('id-ID')}, perlu Rp ${expenseAmount.toLocaleString('id-ID')}). <a href="/expenses">Kembali</a>`);
                }
                doInsert();
            }
            async function doInsert(){
                let finalPhoto = photo;
                if(req.file){
                    const remoteName = 'nota/' + req.file.filename;
                    const cloudUrl = await uploadToSupabase(req.file.path, remoteName, req.file.mimetype);
                    if(cloudUrl) finalPhoto = cloudUrl;
                }
                db.serialize(()=>{
                    db.run(`INSERT INTO expenses (category, amount, description, photo, admin_name) VALUES (?, ?, ?, ?, ?)`,
                        [category, expenseAmount, description, finalPhoto, admin_name], function(err){
                        if(err){
                            if(req.file) fs.unlinkSync(req.file.path);
                            return res.status(500).send('Gagal simpan pengeluaran: '+err.message+' <a href="/expenses">Kembali</a>');
                        }
                        db.run(`INSERT INTO journals (description, debit, credit, account_type) VALUES (?, ?, ?, ?)`,
                            [`Biaya Operasional - ${category}: ${description} ← ${kasAkun}`, expenseAmount, 0, 'Biaya']);
                        db.run(`INSERT INTO journals (description, debit, credit, account_type) VALUES (?, ?, ?, ?)`,
                            [`Biaya Operasional - ${category}: ${description} ← ${kasAkun}`, 0, expenseAmount, kasAkun]);
                        if(needStock){
                            db.get("SELECT * FROM inventory WHERE id=?", [stock_item_id], (e,row)=>{
                                if(!row) return res.redirect('/expenses');
                                const before=row.stock; const after=before+stockQty;
                                db.run("UPDATE inventory SET stock=? WHERE id=?", [after, stock_item_id], ()=>{
                                    db.run("INSERT INTO stock_history (inventory_id, item_name, type, quantity, stock_before, stock_after, admin_name) VALUES (?,?,?,?,?,?,?)",
                                        [stock_item_id, row.name, 'in', stockQty, before, after, admin_name], ()=> res.redirect('/expenses'));
                                });
                            });
                        } else res.redirect('/expenses');
                    });
                });
            }
        });
    });
});

// Routes - Inventory (dengan history)
app.get('/inventory', requireAdminOrOwner, (req, res) => {
    db.all("SELECT * FROM inventory ORDER BY name ASC", (err, inventory) => {
        db.all("SELECT * FROM stock_history ORDER BY date DESC, id DESC LIMIT 20", (err, history) => {
            res.render('inventory', { inventory, history });
        });
    });
});

app.post('/inventory/add', requireAdminOrOwner, (req, res) => {
    const { name, unit, min_stock } = req.body;
    if (!isValidName(name,2)) return res.status(400).send('Validasi gagal: Nama barang min 2 karakter. <a href="/inventory">Kembali</a>');
    if (!unit) return res.status(400).send('Validasi gagal: Satuan wajib. <a href="/inventory">Kembali</a>');
    const minS = parseFloat(String(min_stock).replace(',', '.'));
    const minVal = isNaN(minS) || minS < 0 ? 5 : minS;
    db.run("INSERT INTO inventory (name, unit, stock, min_stock) VALUES (?, ?, 0, ?)", [name.trim(), unit, minVal], (err) => {
        if (err) return res.status(400).send('Validasi gagal: Nama barang sudah ada (unik). <a href="/inventory">Kembali</a>');
        res.redirect('/inventory');
    });
});

app.post('/inventory/delete', requireAdminOrOwner, (req, res) => {
    const { id } = req.body;
    if (!id) return res.status(400).send('Validasi gagal: ID barang wajib. <a href="/inventory">Kembali</a>');
    db.run("DELETE FROM inventory WHERE id = ?", [id], function(err){
        if (err) return res.status(500).send('Gagal hapus: '+err.message+' <a href="/inventory">Kembali</a>');
        if (this.changes===0) return res.status(404).send('Barang tidak ditemukan. <a href="/inventory">Kembali</a>');
        res.redirect('/inventory');
    });
});

app.post('/inventory/update', requireAdminOrOwner, (req, res) => {
    const { id, type, quantity } = req.body; // type: 'in' or 'out'
    const qty = parseFloat(String(quantity).replace(',', '.'));
    if (!id || isNaN(qty) || qty < 1) return res.status(400).send('Validasi gagal: Jumlah minimal 1 unit. <a href="/inventory">Kembali</a>');
    if (!['in','out'].includes(type)) return res.status(400).send('Validasi gagal: Tipe harus in/out. <a href="/inventory">Kembali</a>');
    const admin = req.session.user.username;
    db.get("SELECT * FROM inventory WHERE id=?", [id], (e,row)=>{
        if (!row) return res.status(400).send('Barang tidak ditemukan. <a href="/inventory">Kembali</a>');
        const before = row.stock;
        const after = type==='in' ? before + qty : before - qty;
        if (type==='out' && before < qty) return res.status(400).send(`Validasi gagal: Stok tidak cukup (sisa ${before}). <a href="/inventory">Kembali</a>`);
        db.run("UPDATE inventory SET stock = ? WHERE id = ?", [after, id], (err)=>{
            if (err) return res.status(500).send('Gagal update: '+err.message);
            db.run("INSERT INTO stock_history (inventory_id, item_name, type, quantity, stock_before, stock_after, admin_name) VALUES (?,?,?,?,?,?,?)",
                [id, row.name, type, qty, before, after, admin], ()=>res.redirect('/inventory'));
        });
    });
});

// Routes - Master Data (Owner Only) - Kelola Karyawan, Layanan, Kategori, & Akun Login Pengguna
function renderMaster(res, error = null, success = null) {
    db.all("SELECT * FROM services ORDER BY id ASC", (err, services) => {
        db.all("SELECT * FROM workers ORDER BY id ASC", (err, workers) => {
            db.all("SELECT * FROM expense_categories ORDER BY name ASC", (err, expense_categories) => {
                db.all("SELECT id, username, role FROM users ORDER BY id ASC", (err, users) => {
                    db.get("SELECT value FROM settings WHERE key='discord_webhook_url'", (err, setRow) => {
                        const discordWebhookUrl = setRow && setRow.value ? setRow.value : (process.env.DISCORD_WEBHOOK_URL || '');
                        res.render('master', {
                            services: services || [],
                            workers: workers || [],
                            expense_categories: expense_categories || [],
                            users: users || [],
                            discordWebhookUrl,
                            error,
                            success
                        });
                    });
                });
            });
        });
    });
}

app.get('/master', requireOwner, (req, res) => {
    renderMaster(res);
});

app.post('/master/services/add', requireOwner, (req, res) => {
    const { name, price, commission } = req.body;
    const p = parseRupiah(price);
    const c = (commission !== undefined && commission !== null && String(commission).trim() !== '') ? parseRupiah(commission) : 0;
    if (!isValidName(name,2)) {
        return renderMaster(res, 'Validasi gagal: Nama layanan min 2 karakter, max 50.');
    }
    if (isNaN(p) || p < 1000) {
        return renderMaster(res, 'Validasi gagal: Harga harus angka ≥ 1.000 (contoh: 15.000 atau 15000).');
    }
    const finalComm = isNaN(c) || c < 0 ? 0 : c;
    db.run("INSERT INTO services (name, price, category, isActive, commission) VALUES (?, ?, 'Motor Kecil', 1, ?)", [name.trim(), p, finalComm], (err) => {
        if (err) {
            return renderMaster(res, 'Validasi gagal: Nama layanan sudah ada (unik).');
        }
        res.redirect('/master');
    });
});

app.post('/master/services/update', requireOwner, (req, res) => {
    const { id, name, price, commission } = req.body;
    const p = parseRupiah(price);
    const c = (commission !== undefined && commission !== null && String(commission).trim() !== '') ? parseRupiah(commission) : 0;
    if (!id || !isValidName(name,2)) {
        return renderMaster(res, 'Validasi gagal: Nama layanan min 2 karakter.');
    }
    if (isNaN(p) || p < 1000) {
        return renderMaster(res, 'Validasi gagal: Harga harus ≥ 1.000 (boleh 15.000).');
    }
    const finalComm = isNaN(c) || c < 0 ? 0 : c;
    db.get("SELECT id FROM services WHERE name=? AND id != ?", [name.trim(), id], (e,row)=>{
        if (row) {
            return renderMaster(res, 'Validasi gagal: Nama layanan sudah dipakai layanan lain.');
        }
        db.run("UPDATE services SET name = ?, price = ?, commission = ? WHERE id = ?", [name.trim(), p, finalComm, id], () => res.redirect('/master'));
    });
});

app.post('/master/services/delete', requireOwner, (req, res) => {
    const { id } = req.body;
    db.run("DELETE FROM services WHERE id = ?", [id], () => res.redirect('/master'));
});

app.post('/master/workers/add', requireOwner, (req, res) => {
    const { name, join_date } = req.body;
    if (!isValidName(name,2)) {
        return renderMaster(res, 'Validasi gagal: Nama karyawan min 2 karakter.');
    }
    const finalJoinDate = join_date && join_date.trim() ? join_date.trim() : getWitaTime().toISOString().slice(0,10);
    db.run("INSERT INTO workers (name, join_date) VALUES (?, ?)", [name.trim(), finalJoinDate], (err) => {
        if (err) {
            return renderMaster(res, 'Validasi gagal: Nama karyawan sudah ada (unik).');
        }
        res.redirect('/master');
    });
});

app.post('/master/workers/delete', requireOwner, (req, res) => {
    const { id } = req.body;
    db.run("DELETE FROM workers WHERE id = ?", [id], () => res.redirect('/master'));
});

app.post('/master/expense-categories/add', requireOwner, (req, res) => {
    const { name } = req.body;
    if (!isValidName(name,2)) {
        return renderMaster(res, 'Validasi gagal: Nama kategori min 2 karakter.');
    }
    db.run("INSERT INTO expense_categories (name) VALUES (?)", [name.trim()], (err) => {
        if (err) {
            return renderMaster(res, 'Validasi gagal: Kategori sudah ada (unik).');
        }
        res.redirect('/master');
    });
});

app.post('/master/expense-categories/delete', requireOwner, (req, res) => {
    const { id } = req.body;
    db.run("DELETE FROM expense_categories WHERE id = ?", [id], () => res.redirect('/master'));
});

// --- Master User (Kelola Akun Login Kasir & Owner) ---
app.post('/master/users/add', requireOwner, (req, res) => {
    const { username, password, role } = req.body;
    if (!username || username.trim().length < 3) {
        return renderMaster(res, 'Validasi gagal: Username minimal 3 karakter.');
    }
    const cleanUsername = username.trim().toLowerCase();
    if (!/^[a-zA-Z0-9_]{3,30}$/.test(cleanUsername)) {
        return renderMaster(res, 'Validasi gagal: Username hanya boleh huruf, angka, dan underscore (_), tanpa spasi.');
    }
    if (!password || password.length < 4) {
        return renderMaster(res, 'Validasi gagal: Password minimal 4 karakter.');
    }
    const cleanRole = ['owner', 'admin', 'karyawan'].includes(role) ? role : 'karyawan';
    const hash = bcrypt.hashSync(password, 10);
    db.run("INSERT INTO users (username, password, role) VALUES (?, ?, ?)", [cleanUsername, hash, cleanRole], (err) => {
        if (err) {
            return renderMaster(res, `Validasi gagal: Username "${cleanUsername}" sudah digunakan.`);
        }
        res.redirect('/master');
    });
});

app.post('/master/users/delete', requireOwner, (req, res) => {
    const targetId = parseInt(req.body.id);
    if (isNaN(targetId)) return res.redirect('/master');
    if (targetId === req.session.user.id) {
        return renderMaster(res, 'Validasi gagal: Tidak dapat menghapus akun yang sedang Anda gunakan.');
    }
    db.get("SELECT * FROM users WHERE id = ?", [targetId], (err, targetUser) => {
        if (!targetUser) return res.redirect('/master');
        if (targetUser.username === 'owner') {
            return renderMaster(res, 'Validasi gagal: Akun utama "owner" tidak dapat dihapus.');
        }
        db.run("DELETE FROM users WHERE id = ?", [targetId], (err) => {
            if (err) return renderMaster(res, 'Gagal menghapus akun: ' + err.message);
            res.redirect('/master');
        });
    });
});

app.post('/master/users/reset-password', requireOwner, (req, res) => {
    const { id, new_password } = req.body;
    const targetId = parseInt(id);
    if (isNaN(targetId)) return res.redirect('/master');
    if (!new_password || new_password.length < 4) {
        return renderMaster(res, 'Validasi gagal: Password baru minimal 4 karakter.');
    }
    const hash = bcrypt.hashSync(new_password, 10);
    db.run("UPDATE users SET password = ? WHERE id = ?", [hash, targetId], (err) => {
        if (err) return renderMaster(res, 'Gagal mengganti password: ' + err.message);
        res.redirect('/master');
    });
});

app.post('/master/users/update-role', requireOwner, (req, res) => {
    const { id, role } = req.body;
    const targetId = parseInt(id);
    if (isNaN(targetId)) return res.redirect('/master');
    if (!['owner', 'admin', 'karyawan'].includes(role)) {
        return renderMaster(res, 'Validasi gagal: Role tidak valid.');
    }
    db.get("SELECT * FROM users WHERE id = ?", [targetId], (err, targetUser) => {
        if (!targetUser) return res.redirect('/master');
        if (targetUser.username === 'owner' && role !== 'owner') {
            return renderMaster(res, 'Validasi gagal: Role akun utama "owner" tidak dapat diubah.');
        }
        db.run("UPDATE users SET role = ? WHERE id = ?", [role, targetId], (err) => {
            if (err) return renderMaster(res, 'Gagal mengubah role: ' + err.message);
            res.redirect('/master');
        });
    });
});

// --- Pengaturan & Notifikasi Discord Webhook ---
app.post('/master/settings/discord', requireOwner, (req, res) => {
    const webhookUrl = (req.body.webhook_url || '').trim();
    db.run("INSERT INTO settings (key, value) VALUES ('discord_webhook_url', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [webhookUrl], (err) => {
        if (err) return renderMaster(res, 'Gagal menyimpan URL Webhook Discord: ' + err.message);
        renderMaster(res, null, 'URL Webhook Discord berhasil disimpan!');
    });
});

app.post('/api/discord/test', requireOwner, async (req, res) => {
    try {
        const sender = req.session.user ? req.session.user.username : 'Owner';
        const result = await discord.sendDiscordTest(sender);
        res.json(result);
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/api/discord/send', requireAdminOrOwner, async (req, res) => {
    try {
        const { date, includeDb } = req.body;
        const sender = req.session.user ? `${req.session.user.username} (${req.session.user.role})` : 'Kasir';
        const result = await discord.sendDiscordReport({
            date,
            includeDb: includeDb === true || includeDb === 'true',
            senderName: sender
        });
        res.json(result);
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// --- Akun Kas/Bank/QRIS (Owner kelola) ---
app.get('/akun', requireOwner, (req, res) => {
    db.all("SELECT * FROM accounts ORDER BY type, name ASC", (err, accounts)=>{
        if (err) return res.status(500).send('DB error');
        db.all("SELECT account_type, SUM(debit - credit) as saldo FROM journals GROUP BY account_type", (e, rows)=>{
            const saldoMap={};
            (rows||[]).forEach(r=> saldoMap[r.account_type]=r.saldo);
            if(saldoMap['Kas'] && !saldoMap['Kas Kecil']) { saldoMap['Kas Kecil']=(saldoMap['Kas Kecil']||0)+saldoMap['Kas']; }
            db.all("SELECT * FROM journals WHERE description LIKE 'Transfer %' ORDER BY date DESC, id DESC LIMIT 50", (e, history)=>{
                res.render('akun', { accounts, saldoMap, history: history||[] });
            });
        });
    });
});

app.post('/akun/tambah', requireOwner, (req, res) => {
    const { name, type } = req.body;
    const allowedType=['Kas','Bank','QRIS','E-Wallet','Lainnya'];
    const t=allowedType.includes(type)? type : 'Kas';
    if (!isValidName(name,2)) return res.status(400).send('Nama akun min 2 karakter <a href="/akun">Kembali</a>');
    db.run("INSERT INTO accounts (name, type) VALUES (?, ?)", [name.trim(), t], (err)=>{
        if (err) return res.status(400).send('Nama akun sudah ada (unik) <a href="/akun">Kembali</a>');
        res.redirect('/akun');
    });
});

app.post('/akun/hapus', requireOwner, (req, res) => {
    const { id } = req.body;
    db.get("SELECT * FROM accounts WHERE id=?", [id], (e, acc)=>{
        if (!acc) return res.redirect('/akun');
        db.get("SELECT COALESCE(SUM(debit-credit),0) as saldo FROM journals WHERE account_type=?", [acc.name], (e2, row)=>{
            if (row && row.saldo !==0) return res.status(400).send(`Tidak bisa hapus: saldo ${acc.name} Rp ${row.saldo.toLocaleString('id-ID')} masih ada (pindahkan dulu). <a href="/akun">Kembali</a>`);
            db.run("DELETE FROM accounts WHERE id=?", [id], ()=> res.redirect('/akun'));
        });
    });
});

app.post('/akun/edit', requireOwner, (req, res) => {
    const { id, name, type } = req.body;
    const allowedType=['Kas','Bank','QRIS','E-Wallet','Lainnya'];
    const t=allowedType.includes(type)? type : 'Kas';
    if (!id || !isValidName(name,2)) return res.status(400).send('Nama akun min 2 karakter <a href="/akun">Kembali</a>');
    db.get("SELECT * FROM accounts WHERE id=?", [id], (e, old)=>{
        if (!old) return res.status(404).send('Akun tidak ditemukan <a href="/akun">Kembali</a>');
        if (old.name===name.trim() && old.type===t) return res.redirect('/akun');
        // cek duplikat nama
        db.get("SELECT id FROM accounts WHERE name=? AND id != ?", [name.trim(), id], (e, dup)=>{
            if (dup) return res.status(400).send('Nama akun sudah ada (unik) <a href="/akun">Kembali</a>');
            const oldName=old.name;
            const newName=name.trim();
            db.run("UPDATE accounts SET name=?, type=? WHERE id=?", [newName, t, id], (err)=>{
                if (err) return res.status(500).send('Gagal update akun <a href="/akun">Kembali</a>');
                // update jurnal agar saldo ikut pindah ke nama baru — bypass trigger via temp disable
                db.run("DROP TRIGGER IF EXISTS no_update_journal", ()=>{
                    db.run("UPDATE journals SET account_type=? WHERE account_type=?", [newName, oldName], ()=>{
                        db.run(`CREATE TRIGGER IF NOT EXISTS no_update_journal BEFORE UPDATE ON journals BEGIN SELECT RAISE(ABORT, 'Jurnal tidak boleh diupdate - gunakan reversal'); END;`, ()=>{
                            res.redirect('/akun');
                        });
                    });
                });
            });
        });
    });
});

// Routes - Rekap Komisi Pencuci (Owner & Admin)
app.get('/komisi', requireAdminOrOwner, (req, res) => {
    let { from, to, worker } = req.query;
    const nowWita = getWitaTime();
    const todayStr = nowWita.toISOString().slice(0, 10);
    if (!from) from = todayStr;
    if (!to) to = todayStr;

    let where = ["date(date) >= date(?)", "date(date) <= date(?)"];
    let params = [from, to];

    if (worker && worker.trim() && worker !== 'all') {
        where.push("worker_name = ?");
        params.push(worker.trim());
    }

    const whereClause = "WHERE " + where.join(" AND ");

    db.all("SELECT * FROM workers ORDER BY name ASC", (err, workers) => {
        const summarySql = `
            SELECT 
                worker_name,
                COUNT(id) as total_motor,
                COALESCE(SUM(price), 0) as total_omzet,
                COALESCE(SUM(commission), 0) as total_komisi
            FROM sales 
            ${whereClause}
            GROUP BY worker_name
            ORDER BY total_komisi DESC, total_motor DESC
        `;
        db.all(summarySql, params, (err, workerSummary) => {
            let grandTotalMotor = 0;
            let grandTotalOmzet = 0;
            let grandTotalKomisi = 0;
            (workerSummary || []).forEach(w => {
                grandTotalMotor += w.total_motor;
                grandTotalOmzet += w.total_omzet;
                grandTotalKomisi += w.total_komisi;
            });

            const detailSql = `
                SELECT id, date, customer_name, license_plate, service_name, price, worker_name, admin_name, akun_kas, commission
                FROM sales
                ${whereClause}
                ORDER BY date DESC, id DESC
            `;
            db.all(detailSql, params, (err, trxDetails) => {
                res.render('komisi', {
                    workers: workers || [],
                    workerSummary: workerSummary || [],
                    trxDetails: trxDetails || [],
                    from,
                    to,
                    selectedWorker: worker || 'all',
                    grandTotalMotor,
                    grandTotalOmzet,
                    grandTotalKomisi,
                    todayStr
                });
            });
        });
    });
});

// Route - Print Slip Komisi Pencuci
app.get('/komisi/slip/:workerName', requireAdminOrOwner, (req, res) => {
    const workerName = req.params.workerName;
    let { from, to } = req.query;
    const nowWita = getWitaTime();
    const todayStr = nowWita.toISOString().slice(0, 10);
    if (!from) from = todayStr;
    if (!to) to = todayStr;

    const sql = `
        SELECT id, date, customer_name, license_plate, service_name, price, commission
        FROM sales
        WHERE worker_name = ? AND date(date) >= date(?) AND date(date) <= date(?)
        ORDER BY date ASC, id ASC
    `;
    db.all(sql, [workerName, from, to], (err, rows) => {
        let totalKomisi = 0;
        let totalOmzet = 0;
        (rows || []).forEach(r => {
            totalKomisi += (r.commission || 0);
            totalOmzet += (r.price || 0);
        });

        res.render('komisi-slip', {
            layout: false,
            workerName,
            from,
            to,
            rows: rows || [],
            totalMotor: (rows || []).length,
            totalKomisi,
            totalOmzet,
            printedAt: getWitaTime()
        });
    });
});

// Routes - Reports (Owner Only) Phase 6 formal: filter, pagination, ledger, P&L breakdown, neraca
app.get('/reports', requireOwner, (req, res) => {
    const { from, to, page, limit } = req.query;
    const pageNum = Math.max(1, parseInt(page) || 1);
    const limitNum = Math.min(100, Math.max(10, parseInt(limit) || 20));
    let where = [];
    let params = [];
    if (from) { where.push("date(date) >= date(?)"); params.push(from); }
    if (to) { where.push("date(date) <= date(?)"); params.push(to); }
    const whereClause = where.length ? "WHERE " + where.join(" AND ") : "";

    db.all(`SELECT * FROM journals ${whereClause} ORDER BY date ASC`, params, (err, allJournals) => {
        // Jurnal pagination (filter applied)
        db.get(`SELECT COUNT(*) as total FROM journals ${whereClause}`, params, (e, row) => {
            const total = row ? row.total : 0;
            const totalPages = Math.max(1, Math.ceil(total / limitNum));
            const safePage = Math.min(pageNum, totalPages);
            const offset = (safePage - 1) * limitNum;
            db.all(`SELECT * FROM journals ${whereClause} ORDER BY date ASC LIMIT ? OFFSET ?`, [...params, limitNum, offset], (e, journals) => {
                // Aggregate filtered (kas besar + kecil)
                let fKas=0, fKasBesar=0, fKasKecil=0, fPendapatan=0, fBiaya=0;
                const isKas = (t)=> t!=='Pendapatan' && t!=='Biaya';
                (allJournals||[]).forEach(j=>{
                    if(j.account_type==='Pendapatan') fPendapatan+= j.credit - j.debit;
                    if(j.account_type==='Biaya') fBiaya+= j.debit - j.credit;
                    if(isKas(j.account_type)){
                        const v=j.debit - j.credit;
                        fKas+=v;
                        if(j.account_type==='Kas Besar') fKasBesar+=v;
                        else if(j.account_type==='Kas Kecil') fKasKecil+=v;
                        else fKasKecil+=v; // Kas lama anggap Kecil
                    }
                });
                const fLaba=fPendapatan - fBiaya;
                // Ledger: running balance per akun (filtered)
                const ledger={};
                const sorted=[...allJournals].sort((a,b)=> new Date(a.date)-new Date(b.date));
                sorted.forEach(j=>{
                    if(!ledger[j.account_type]) ledger[j.account_type]=[];
                    const prev=ledger[j.account_type].length? ledger[j.account_type][ledger[j.account_type].length-1].balance:0;
                    let delta=0;
                    if(isKas(j.account_type)) delta=j.debit - j.credit;
                    else if(j.account_type==='Pendapatan') delta=j.credit - j.debit;
                    else delta=j.debit - j.credit;
                    const bal=prev+delta;
                    ledger[j.account_type].push({ ...j, balance: bal });
                });
                // P&L breakdown per kategori biaya (from expenses filtered)
                let expWhere=[]; let expParams=[];
                if(from){ expWhere.push("date(date) >= date(?)"); expParams.push(from); }
                if(to){ expWhere.push("date(date) <= date(?)"); expParams.push(to); }
                const expClause=expWhere.length? "WHERE "+expWhere.join(" AND "):"";
                db.all(`SELECT category, SUM(amount) as total FROM expenses ${expClause} GROUP BY category ORDER BY total DESC`, expParams, (e, biayaPerKategori)=>{
                    // Inventory total for neraca (stock * assume value? use stock count)
                    db.all("SELECT SUM(stock) as totalStock FROM inventory", (e, invRow)=>{
                        const totalStock = invRow && invRow[0] ? invRow[0].totalStock||0 : 0;
                        // KPI for dashboard-like
                        const today=getWitaTime().toISOString().slice(0,10);
                        const firstDay=getWitaTime().toISOString().slice(0,8) + '01';
                        db.get("SELECT COUNT(*) as c, SUM(price) as omzet FROM sales WHERE date(date)=date('now')", (e, todayRow)=>{
                            db.get(`SELECT SUM(price) as omzetBulan FROM sales WHERE date(date) >= date(?)`, [firstDay], (e, bulanRow)=>{
                                db.all("SELECT date(date) as tgl, COUNT(*) as trx, SUM(price) as omzet FROM sales WHERE date(date) >= date('now','-6 days') GROUP BY date(date) ORDER BY tgl ASC", (e, tren)=>{
                                    db.all("SELECT * FROM accounts ORDER BY type, name ASC", (e, accounts)=>{
                        db.all("SELECT account_type, SUM(debit - credit) as saldo FROM journals GROUP BY account_type", (e, saldoRows)=>{
                            const saldoMap={};
                            (saldoRows||[]).forEach(r=> saldoMap[r.account_type]=r.saldo);
                            // Kas lama
                            if(saldoMap['Kas'] && !saldoMap['Kas Kecil']) saldoMap['Kas Kecil']=(saldoMap['Kas Kecil']||0)+saldoMap['Kas'];
                            res.render('reports', { 
                                journals, allJournals, total, totalPages, currentPage: safePage, limit: limitNum, query:{from: from||'', to: to||''},
                                totalPendapatan: fPendapatan, totalBiaya: fBiaya, totalKas: fKas, totalKasBesar: fKasBesar, totalKasKecil: fKasKecil, labaBersih: fLaba,
                                ledger, biayaPerKategori: biayaPerKategori||[], totalStock, accounts: accounts||[], saldoMap,
                                kpiToday: todayRow||{c:0, omzet:0}, kpiBulan: bulanRow||{omzetBulan:0}, tren: tren||[]
                            });
                        });
                    });
                                });
                            });
                        });
                    });
                });
            });
        });
    });
});

app.post('/kas/transfer', requireOwner, (req, res) => {
    const { from_kas, to_kas, amount, description } = req.body;
    const amt = parseRupiah(amount);
    if (!from_kas || !to_kas || from_kas===to_kas) {
        return res.status(400).send('Validasi gagal: Akun asal & tujuan harus berbeda. <a href="/reports">Kembali</a>');
    }
    if (isNaN(amt) || amt < 1000) return res.status(400).send('Validasi gagal: Nominal ≥1000. <a href="/reports">Kembali</a>');
    // cek saldo cukup
    db.all("SELECT * FROM journals WHERE account_type=? ", [from_kas], (e, rows)=>{
        let saldo=0;
        (rows||[]).forEach(j=> saldo+= j.debit - j.credit);
        // juga hitung Kas lama sebagai Kecil
        if(from_kas==='Kas Kecil'){
            db.all("SELECT * FROM journals WHERE account_type='Kas'", (e2, oldRows)=>{
                (oldRows||[]).forEach(j=> saldo+= j.debit - j.credit);
                if(saldo < amt) return res.status(400).send(`Saldo ${from_kas} tidak cukup (Rp ${saldo.toLocaleString('id-ID')}). <a href="/reports">Kembali</a>`);
                doTransfer();
            });
        } else {
            if(saldo < amt) return res.status(400).send(`Saldo ${from_kas} tidak cukup (Rp ${saldo.toLocaleString('id-ID')}). <a href="/reports">Kembali</a>`);
            doTransfer();
        }
        function doTransfer(){
            const desc = description ? `Transfer ${from_kas}→${to_kas}: ${description}` : `Transfer ${from_kas} → ${to_kas}`;
            db.run("INSERT INTO journals (description, debit, credit, account_type) VALUES (?,?,?,?)", [desc, amt, 0, to_kas], ()=>{
                db.run("INSERT INTO journals (description, debit, credit, account_type) VALUES (?,?,?,?)", [desc, 0, amt, from_kas], ()=>{
                    res.redirect('/reports');
                });
            });
        }
    });
});

app.get('/kas/kecil', requireAdminOrOwner, (req, res) => {
    const { from, to, page, limit } = req.query;
    const pageNum = Math.max(1, parseInt(page) || 1);
    const limitNum = Math.min(100, Math.max(10, parseInt(limit) || 20));
    let where = ["account_type IN ('Kas Kecil','Kas')"];
    let params = [];
    if (from) { where.push("date(date) >= date(?)"); params.push(from); }
    if (to) { where.push("date(date) <= date(?)"); params.push(to); }
    const whereClause = "WHERE " + where.join(" AND ");
    db.all(`SELECT * FROM journals ${whereClause} ORDER BY date ASC`, params, (e, all)=>{
        db.get(`SELECT COUNT(*) as total FROM journals ${whereClause}`, params, (e, row)=>{
            const total=row?row.total:0;
            const totalPages=Math.max(1, Math.ceil(total/limitNum));
            const safePage=Math.min(pageNum,totalPages);
            const offset=(safePage-1)*limitNum;
            db.all(`SELECT * FROM journals ${whereClause} ORDER BY date DESC LIMIT ? OFFSET ?`, [...params, limitNum, offset], (e, journals)=>{
                let saldo=0;
                (all||[]).forEach(j=> saldo+= j.debit - j.credit);
                // running balance per row for history
                const sorted=[...all].sort((a,b)=> new Date(a.date)-new Date(b.date));
                let running=0;
                const map=new Map();
                sorted.forEach(j=>{
                    running+= j.debit - j.credit;
                    map.set(j.id, running);
                });
                const withSaldo=journals.map(j=> ({...j, saldo: map.get(j.id)||0}));
                res.render('kas-kecil', { journals: withSaldo, total, totalPages, currentPage: safePage, limit: limitNum, query:{from:from||'', to:to||''}, saldo });
            });
        });
    });
});

app.get('/api/service-price', requireAdminOrOwner, (req, res) => {
    const name = req.query.name;
    db.get("SELECT price FROM services WHERE name = ?", [name], (err, row) => {
        res.json({ price: row ? row.price : 0 });
    });
});

// Error handler untuk upload foto (multer)
app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).send('Validasi gagal: Foto max 3MB. <a href="/expenses">Kembali</a>');
        return res.status(400).send('Upload gagal: '+err.message+' <a href="/expenses">Kembali</a>');
    }
    if (err && err.message && err.message.includes('Hanya file gambar')) {
        return res.status(400).send('Validasi gagal: '+err.message+' <a href="/expenses">Kembali</a>');
    }
    next(err);
});

app.use((req, res, next) => {
    console.log(`[REQ] ${req.method} ${req.url} - Host: ${req.headers.host}`);
    next();
});

// Graceful shutdown untuk Render / Docker
const gracefulShutdown = async (signal) => {
    console.log(`[Server] Signal ${signal} diterima. Menyimpan database ke cloud...`);
    try {
        await cloudSync.uploadDb();
        console.log('[Server] Database berhasil tersimpan di Supabase.');
    } catch (e) {
        console.error('[Server] Gagal sinkronisasi saat shutdown:', e.message);
    }
    process.exit(0);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Start server - 0.0.0.0 untuk Render / Railway / Docker
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running at port ${PORT}`);
    
    // Self-test
    setTimeout(() => {
        require('http').get(`http://localhost:${PORT}/healthz`, (resp) => {
            let data = '';
            resp.on('data', (chunk) => { data += chunk; });
            resp.on('end', () => {
                console.log(`Self-test /healthz: ${resp.statusCode} ${data}`);
            });
        }).on("error", (err) => {
            console.log("Self-test Error: " + err.message);
        });
    }, 3000);
});


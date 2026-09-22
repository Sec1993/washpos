const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

const expressLayouts = require('express-ejs-layouts');

// Setup Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(expressLayouts);
app.set('layout', 'layout');
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Session config
app.use(session({
    secret: 'pos_cuci_motor_secret',
    resave: false,
    saveUninitialized: true
}));

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

// Helper: parse Rupiah (terima "15.000", "15,000", "Rp 15.000", "15000")
function parseRupiah(val) {
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

// Multer setup untuk foto nota pengeluaran
const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        const name = 'nota_' + Date.now() + '_' + Math.round(Math.random()*1e6) + ext;
        cb(null, name);
    }
});
const upload = multer({
    storage,
    limits: { fileSize: 3 * 1024 * 1024 }, // max 3MB
    fileFilter: (req, file, cb) => {
        const allowed = ['.jpg','.jpeg','.png','.webp','.gif'];
        const ext = path.extname(file.originalname).toLowerCase();
        if (allowed.includes(ext)) cb(null, true);
        else cb(new Error('Hanya file gambar (jpg, png, webp) yang diperbolehkan'));
    }
});

// Pass user + loginTime to all views
app.use((req, res, next) => {
    res.locals.user = req.session.user;
    res.locals.loginTime = req.session.loginTime || null;
    next();
});

// Routes - Auth
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
            res.redirect('/');
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
const absenUploadDir = path.join(__dirname, 'public', 'uploads', 'absen');
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
    const today = new Date().toISOString().slice(0,10);
    const uid = req.session.user.id;
    const isOwner = req.session.user.role==='owner';
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

app.post('/absen', requireLogin, absenUpload.single('photo'), (req, res) => {
    const { type, latitude, longitude, address } = req.body;
    const t = (type==='keluar' ? 'keluar' : 'masuk');
    if (!req.file) return res.status(400).send('Validasi gagal: Foto wajib. <a href="/absen">Kembali</a>');
    if (!latitude || !longitude) {
        fs.unlinkSync(req.file.path);
        return res.status(400).send('Validasi gagal: Lokasi wajib (aktifkan GPS). <a href="/absen">Kembali</a>');
    }
    const now = new Date();
    const date = now.toISOString().slice(0,10);
    const time = now.toLocaleTimeString('id-ID', {hour:'2-digit', minute:'2-digit', second:'2-digit'});
    const datetime = now.toISOString();
    const uid = req.session.user.id;
    const username = req.session.user.username;
    // cegah double absen sama type di hari sama (optional)
    db.get("SELECT * FROM attendance WHERE user_id=? AND date=? AND type=?", [uid, date, t], (e,row)=>{
        if (row) {
            fs.unlinkSync(req.file.path);
            return res.status(400).send(`Sudah absen ${t} hari ini jam ${row.time}. <a href="/absen">Kembali</a>`);
        }
        const photo = '/uploads/absen/' + path.basename(req.file.path);
        db.run("INSERT INTO attendance (user_id, username, date, time, datetime, type, photo, latitude, longitude, address) VALUES (?,?,?,?,?,?,?,?,?,?)",
            [uid, username, date, time, datetime, t, photo, parseFloat(latitude), parseFloat(longitude), address||''], (err)=>{
                if (err) { fs.unlinkSync(req.file.path); return res.status(500).send('Gagal simpan absen: '+err.message); }
                res.redirect('/absen');
            });
    });
});

// Route - Dashboard / Default (5.7 low stock + 6.11 KPI + kas besar/kecil)
app.get('/', requireLogin, (req, res) => {
    if (req.session.user.role === 'owner') {
        db.all("SELECT * FROM inventory WHERE stock <= COALESCE(min_stock,5) ORDER BY stock ASC", (err, lowStock) => {
            const today=new Date().toISOString().slice(0,10);
            const firstDay=new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0,10);
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
    } else {
        res.redirect('/sales');
    }
});

// Routes - Sales (Phase 3 formal: filter tanggal, search, pagination + kas kecil + akun dinamis)
app.get('/sales', requireLogin, (req, res) => {
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

app.post('/sales', requireLogin, (req, res) => {
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
        return res.status(400).send('Validasi gagal: Nama (≥2) / Plat alfanumerik 2-10 (contoh B 1234 ABC) / Pekerja wajib & pilih minimal 1 layanan. <a href="/sales">Kembali</a>');
    }
    if (isNaN(salePrice) || salePrice < 1000) {
        return res.status(400).send('Validasi gagal: Harga harus angka ≥ 1000 (boleh format 15.000). <a href="/sales">Kembali</a>');
    }
    // validasi akun kas: penjualan hanya Kas Kecil & QRIS
    db.all("SELECT name FROM accounts WHERE name='Kas Kecil' OR type='QRIS'", (e, accRows)=>{
        const akunValid = new Set((accRows||[]).map(r=>r.name));
        if (!akunValid.has(kasAkun)) kasAkun='Kas Kecil';
        db.all('SELECT name FROM services WHERE isActive=1', (e, rows)=>{
            const validNames = new Set((rows||[]).map(r=>r.name));
            const invalid = serviceNames.filter(n=>!validNames.has(n));
            if (invalid.length>0) return res.status(400).send('Validasi gagal: Layanan tidak valid: '+invalid.join(', ')+' <a href="/sales">Kembali</a>');

            db.serialize(() => {
            db.run(`INSERT INTO sales (customer_name, license_plate, service_name, price, worker_name, admin_name) 
                    VALUES (?, ?, ?, ?, ?, ?)`, 
                    [customer_name, license_plate, service_name, salePrice, worker_name, admin_name], function(err) {
                if (err) { console.error(err); return res.status(500).send('Gagal simpan penjualan: '+err.message+' <a href="/sales">Kembali</a>'); }
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
app.get('/receipt/:id', requireLogin, (req, res) => {
    const saleId = req.params.id;
    db.get("SELECT * FROM sales WHERE id = ?", [saleId], (err, sale) => {
        if (err || !sale) return res.send('Transaksi tidak ditemukan.');
        res.render('receipt', { sale });
    });
});

// Routes - Expenses (Phase 4 formal: filter tanggal, search, pagination + foto + stok integrasi 5.4)
app.get('/expenses', requireLogin, (req, res) => {
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

app.post('/expenses', requireLogin, upload.single('photo'), (req, res) => {
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
            function doInsert(){
                db.serialize(()=>{
                    db.run(`INSERT INTO expenses (category, amount, description, photo, admin_name) VALUES (?, ?, ?, ?, ?)`,
                        [category, expenseAmount, description, photo, admin_name], function(err){
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
app.get('/inventory', requireLogin, (req, res) => {
    db.all("SELECT * FROM inventory ORDER BY name ASC", (err, inventory) => {
        db.all("SELECT * FROM stock_history ORDER BY date DESC, id DESC LIMIT 20", (err, history) => {
            res.render('inventory', { inventory, history });
        });
    });
});

app.post('/inventory/add', requireLogin, (req, res) => {
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

app.post('/inventory/delete', requireLogin, (req, res) => {
    const { id } = req.body;
    if (!id) return res.status(400).send('Validasi gagal: ID barang wajib. <a href="/inventory">Kembali</a>');
    db.run("DELETE FROM inventory WHERE id = ?", [id], function(err){
        if (err) return res.status(500).send('Gagal hapus: '+err.message+' <a href="/inventory">Kembali</a>');
        if (this.changes===0) return res.status(404).send('Barang tidak ditemukan. <a href="/inventory">Kembali</a>');
        res.redirect('/inventory');
    });
});

app.post('/inventory/update', requireLogin, (req, res) => {
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

// Routes - Master Data (Owner Only) - Kelola Karyawan & Menu Layanan + Kategori Pengeluaran (Phase2)
app.get('/master', requireOwner, (req, res) => {
    db.all("SELECT * FROM services ORDER BY id ASC", (err, services) => {
        db.all("SELECT * FROM workers ORDER BY id ASC", (err, workers) => {
            db.all("SELECT * FROM expense_categories ORDER BY name ASC", (err, expense_categories) => {
                res.render('master', { services, workers, expense_categories, error: null, success: null });
            });
        });
    });
});

app.post('/master/services/add', requireOwner, (req, res) => {
    const { name, price } = req.body;
    const p = parseRupiah(price);
    if (!isValidName(name,2)) {
        db.all("SELECT * FROM services ORDER BY id ASC", (e, services) => {
            db.all("SELECT * FROM workers ORDER BY id ASC", (e, workers) => {
                db.all("SELECT * FROM expense_categories ORDER BY name ASC", (e, expense_categories) => {
                    res.render('master', { services, workers, expense_categories, error: 'Validasi gagal: Nama layanan min 2 karakter, max 50.', success: null });
                });
            });
        }); return;
    }
    if (isNaN(p) || p < 1000) {
        db.all("SELECT * FROM services ORDER BY id ASC", (e, services) => {
            db.all("SELECT * FROM workers ORDER BY id ASC", (e, workers) => {
                db.all("SELECT * FROM expense_categories ORDER BY name ASC", (e, expense_categories) => {
                    res.render('master', { services, workers, expense_categories, error: 'Validasi gagal: Harga harus angka ≥ 1.000 (contoh: 15.000 atau 15000).', success: null });
                });
            });
        }); return;
    }
    db.run("INSERT INTO services (name, price, category, isActive) VALUES (?, ?, 'Motor Kecil', 1)", [name.trim(), p], (err) => {
        if (err) {
            db.all("SELECT * FROM services ORDER BY id ASC", (e, services) => {
                db.all("SELECT * FROM workers ORDER BY id ASC", (e, workers) => {
                    db.all("SELECT * FROM expense_categories ORDER BY name ASC", (e, expense_categories) => {
                        res.render('master', { services, workers, expense_categories, error: 'Validasi gagal: Nama layanan sudah ada (unik).', success: null });
                    });
                });
            });
        } else {
            res.redirect('/master');
        }
    });
});

app.post('/master/services/update', requireOwner, (req, res) => {
    const { id, name, price } = req.body;
    const p = parseRupiah(price);
    if (!id || !isValidName(name,2)) {
        db.all("SELECT * FROM services ORDER BY id ASC", (e, services) => {
            db.all("SELECT * FROM workers ORDER BY id ASC", (e, workers) => {
                db.all("SELECT * FROM expense_categories ORDER BY name ASC", (e, expense_categories) => {
                    res.render('master', { services, workers, expense_categories, error: 'Validasi gagal: Nama layanan min 2 karakter.', success: null });
                });
            });
        }); return;
    }
    if (isNaN(p) || p < 1000) {
        db.all("SELECT * FROM services ORDER BY id ASC", (e, services) => {
            db.all("SELECT * FROM workers ORDER BY id ASC", (e, workers) => {
                db.all("SELECT * FROM expense_categories ORDER BY name ASC", (e, expense_categories) => {
                    res.render('master', { services, workers, expense_categories, error: 'Validasi gagal: Harga harus ≥ 1.000 (boleh 15.000).', success: null });
                });
            });
        }); return;
    }
    // cek duplikat nama (kecuali id sendiri)
    db.get("SELECT id FROM services WHERE name=? AND id != ?", [name.trim(), id], (e,row)=>{
        if (row) {
            db.all("SELECT * FROM services ORDER BY id ASC", (e, services) => {
                db.all("SELECT * FROM workers ORDER BY id ASC", (e, workers) => {
                    db.all("SELECT * FROM expense_categories ORDER BY name ASC", (e, expense_categories) => {
                        res.render('master', { services, workers, expense_categories, error: 'Validasi gagal: Nama layanan sudah dipakai layanan lain.', success: null });
                    });
                });
            }); return;
        }
        db.run("UPDATE services SET name = ?, price = ? WHERE id = ?", [name.trim(), p, id], () => res.redirect('/master'));
    });
});

app.post('/master/services/delete', requireOwner, (req, res) => {
    const { id } = req.body;
    db.run("DELETE FROM services WHERE id = ?", [id], () => res.redirect('/master'));
});

app.post('/master/workers/add', requireOwner, (req, res) => {
    const { name } = req.body;
    if (!isValidName(name,2)) {
        db.all("SELECT * FROM services ORDER BY id ASC", (e, services) => {
            db.all("SELECT * FROM workers ORDER BY id ASC", (e, workers) => {
                db.all("SELECT * FROM expense_categories ORDER BY name ASC", (e, expense_categories) => {
                    res.render('master', { services, workers, expense_categories, error: 'Validasi gagal: Nama karyawan min 2 karakter.', success: null });
                });
            });
        }); return;
    }
    db.run("INSERT INTO workers (name) VALUES (?)", [name.trim()], (err) => {
        if (err) {
            db.all("SELECT * FROM services ORDER BY id ASC", (e, services) => {
                db.all("SELECT * FROM workers ORDER BY id ASC", (e, workers) => {
                    db.all("SELECT * FROM expense_categories ORDER BY name ASC", (e, expense_categories) => {
                        res.render('master', { services, workers, expense_categories, error: 'Validasi gagal: Nama karyawan sudah ada (unik).', success: null });
                    });
                });
            });
        } else {
            res.redirect('/master');
        }
    });
});

app.post('/master/workers/delete', requireOwner, (req, res) => {
    const { id } = req.body;
    db.run("DELETE FROM workers WHERE id = ?", [id], () => res.redirect('/master'));
});

app.post('/master/expense-categories/add', requireOwner, (req, res) => {
    const { name } = req.body;
    if (!isValidName(name,2)) {
        db.all("SELECT * FROM services ORDER BY id ASC", (e, services) => {
            db.all("SELECT * FROM workers ORDER BY id ASC", (e, workers) => {
                db.all("SELECT * FROM expense_categories ORDER BY name ASC", (e, expense_categories) => {
                    res.render('master', { services, workers, expense_categories, error: 'Validasi gagal: Nama kategori min 2 karakter.', success: null });
                });
            });
        }); return;
    }
    db.run("INSERT INTO expense_categories (name) VALUES (?)", [name.trim()], (err) => {
        if (err) {
            db.all("SELECT * FROM services ORDER BY id ASC", (e, services) => {
                db.all("SELECT * FROM workers ORDER BY id ASC", (e, workers) => {
                    db.all("SELECT * FROM expense_categories ORDER BY name ASC", (e, expense_categories) => {
                        res.render('master', { services, workers, expense_categories, error: 'Validasi gagal: Kategori sudah ada (unik).', success: null });
                    });
                });
            });
        } else {
            res.redirect('/master');
        }
    });
});

app.post('/master/expense-categories/delete', requireOwner, (req, res) => {
    const { id } = req.body;
    db.run("DELETE FROM expense_categories WHERE id = ?", [id], () => res.redirect('/master'));
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
                        const today=new Date().toISOString().slice(0,10);
                        const firstDay=new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0,10);
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

app.get('/kas/kecil', requireLogin, (req, res) => {
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

app.get('/api/service-price', requireLogin, (req, res) => {
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

// Start server - 0.0.0.0 untuk Railway/Docker
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running at http://0.0.0.0:${PORT}`);
});

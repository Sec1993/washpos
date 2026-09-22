const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcryptjs');

const dbPath = path.resolve(__dirname, 'pos.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error connecting to database:', err);
    } else {
        console.log('Connected to SQLite database.');
    }
});

db.serialize(() => {
    // 1. Users table
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password TEXT,
        role TEXT
    )`);

    // 2. Services / Menu table (Phase2: kategori tanpa Lainnya)
    db.run(`CREATE TABLE IF NOT EXISTS services (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE,
        price REAL,
        category TEXT DEFAULT 'Motor Kecil',
        isActive INTEGER DEFAULT 1
    )`);

    // 3. Workers table
    db.run(`CREATE TABLE IF NOT EXISTS workers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE
    )`);

    // 4. Sales table
    db.run(`CREATE TABLE IF NOT EXISTS sales (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_name TEXT,
        license_plate TEXT,
        service_name TEXT,
        price REAL,
        worker_name TEXT,
        admin_name TEXT,
        date DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // 5. Expenses table (tambah photo_nota)
    db.run(`CREATE TABLE IF NOT EXISTS expenses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT,
        amount REAL,
        description TEXT,
        photo TEXT,
        date DATETIME DEFAULT CURRENT_TIMESTAMP,
        admin_name TEXT
    )`);

    // 6. Inventory table (tambah min_stock)
    db.run(`CREATE TABLE IF NOT EXISTS inventory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE,
        unit TEXT,
        stock REAL DEFAULT 0,
        min_stock REAL DEFAULT 5
    )`);

    // 6b. Stock History (mutasi masuk/keluar)
    db.run(`CREATE TABLE IF NOT EXISTS stock_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        inventory_id INTEGER,
        item_name TEXT,
        type TEXT,
        quantity REAL,
        stock_before REAL,
        stock_after REAL,
        admin_name TEXT,
        date DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(inventory_id) REFERENCES inventory(id) ON DELETE SET NULL
    )`);

    // 7. Journals (Accounting) table — immutable (hardening 7.4)
    db.run(`CREATE TABLE IF NOT EXISTS journals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date DATETIME DEFAULT CURRENT_TIMESTAMP,
        description TEXT,
        debit REAL DEFAULT 0,
        credit REAL DEFAULT 0,
        account_type TEXT
    )`);
    // Hardening: cegah DELETE/UPDATE jurnal (hanya boleh INSERT + reversal)
    db.run(`CREATE TRIGGER IF NOT EXISTS no_delete_journal BEFORE DELETE ON journals BEGIN SELECT RAISE(ABORT, 'Jurnal tidak boleh dihapus - gunakan reversal'); END;`);
    db.run(`CREATE TRIGGER IF NOT EXISTS no_update_journal BEFORE UPDATE ON journals BEGIN SELECT RAISE(ABORT, 'Jurnal tidak boleh diupdate - gunakan reversal'); END;`);

    // 8. Expense Categories table (Phase2)
    db.run(`CREATE TABLE IF NOT EXISTS expense_categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE
    )`);

    // 9. Attendance (Absen) table — foto + lokasi + jam
    db.run(`CREATE TABLE IF NOT EXISTS attendance (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        username TEXT,
        date TEXT,
        time TEXT,
        datetime DATETIME,
        type TEXT,
        photo TEXT,
        latitude REAL,
        longitude REAL,
        address TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // 10. Akun Kas/Bank/QRIS (Owner kelola)
    db.run(`CREATE TABLE IF NOT EXISTS accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE,
        type TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Migration: foto nota pengeluaran
    db.run(`ALTER TABLE expenses ADD COLUMN photo TEXT`, (err) => {
        if (err && !err.message.includes('duplicate column')) {
            // ignore
        }
    });
    // Migration: min_stock inventory
    db.run(`ALTER TABLE inventory ADD COLUMN min_stock REAL DEFAULT 5`, (err) => {
        if (err && !err.message.includes('duplicate column')) {
            // ignore
        }
    });
    // Migration: tambah kolom category & isActive jika DB lama (ignore error jika sudah ada)
    db.run(`ALTER TABLE services ADD COLUMN category TEXT DEFAULT 'Motor Kecil'`, (err) => {
        if (err && !err.message.includes('duplicate column')) {
            // ignore
        }
    });
    db.run(`ALTER TABLE services ADD COLUMN isActive INTEGER DEFAULT 1`, (err) => {
        if (err && !err.message.includes('duplicate column')) {
            // ignore
        }
    });

    // Seed default owner account if no users exist
    db.get("SELECT COUNT(*) as count FROM users", (err, row) => {
        if (row && row.count === 0) {
            const salt = bcrypt.genSaltSync(10);
            const ownerHash = bcrypt.hashSync('owner123', salt);
            const karyawanHash = bcrypt.hashSync('karyawan123', salt);
            
            const stmt = db.prepare("INSERT INTO users (username, password, role) VALUES (?, ?, ?)");
            stmt.run('owner', ownerHash, 'owner');
            stmt.run('karyawan', karyawanHash, 'karyawan');
            stmt.finalize();
            console.log('Default accounts created. Owner: owner / owner123. Karyawan: karyawan / karyawan123');
        }
    });

    // Seed default services (tanpa Lainnya)
    db.get("SELECT COUNT(*) as count FROM services", (err, row) => {
        if (row && row.count === 0) {
            const stmt = db.prepare("INSERT INTO services (name, price, category, isActive) VALUES (?, ?, ?, 1)");
            stmt.run('Cuci Motor Kecil', 15000, 'Motor Kecil');
            stmt.run('Cuci Motor Sedang', 20000, 'Motor Sedang');
            stmt.run('Cuci Motor Besar', 25000, 'Motor Besar');
            stmt.run('Poles Helm', 10000, 'Motor Kecil');
            stmt.finalize();
        } else {
            // Migrasi: Lainnya -> Motor Kecil (hapus kategori Lainnya)
            db.run("UPDATE services SET category='Motor Kecil' WHERE category='Lainnya' OR category IS NULL OR category=''");
        }
    });

    // Seed default expense categories
    db.get("SELECT COUNT(*) as count FROM expense_categories", (err, row) => {
        if (row && row.count === 0) {
            const stmt = db.prepare("INSERT INTO expense_categories (name) VALUES (?)");
            stmt.run('Sabun');
            stmt.run('Peralatan');
            stmt.run('Perlengkapan');
            stmt.run('Listrik/Air');
            stmt.run('Gaji');
            stmt.run('Lainnya');
            stmt.finalize();
        }
    });

    // Seed default workers
    db.get("SELECT COUNT(*) as count FROM workers", (err, row) => {
        if (row && row.count === 0) {
            const stmt = db.prepare("INSERT INTO workers (name) VALUES (?)");
            stmt.run('Budi');
            stmt.run('Agus');
            stmt.finalize();
        }
    });

    // Seed akun default Kas Kecil/Besar
    db.get("SELECT COUNT(*) as count FROM accounts", (err, row) => {
        if (row && row.count === 0) {
            const stmt = db.prepare("INSERT INTO accounts (name, type) VALUES (?, ?)");
            stmt.run('Kas Kecil', 'Kas');
            stmt.run('Kas Besar', 'Kas');
            stmt.finalize();
            console.log('Default akun Kas Kecil/Besar seeded');
        }
    });
});

module.exports = db;

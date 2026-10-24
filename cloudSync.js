const fs = require('fs');
const path = require('path');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qhclkhpymihmlbmecpdv.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFoY2xraHB5bWlobWxibWVjcGR2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc5MTg3MDI1NSwiZXhwIjoyMTA3NDQ2MjU1fQ.57ug7wMvZuMORmZ2eVvk_2q5SFF8UPZNpQTQD0wqIFU';
const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || 'washpos-photos';
const DB_PATH = path.resolve(__dirname, 'data', 'pos.db');
const REMOTE_PATH = 'database/pos.db';

let isUploading = false;
let hasPendingUpload = false;
let debounceTimer = null;

/**
 * Mengunduh database pos.db dari Supabase Storage saat aplikasi start.
 */
async function downloadDb() {
    try {
        console.log('[CloudSync] Memeriksa & mengunduh database pos.db dari Supabase Storage...');
        const endpoint = `${SUPABASE_URL}/storage/v1/object/${SUPABASE_BUCKET}/${REMOTE_PATH}`;
        const res = await fetch(endpoint, {
            headers: {
                'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
                'apikey': SUPABASE_SERVICE_KEY
            }
        });

        if (res.status === 200) {
            const arrayBuf = await res.arrayBuffer();
            const buffer = Buffer.from(arrayBuf);
            if (buffer.length > 0) {
                const dbDir = path.dirname(DB_PATH);
                if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
                fs.writeFileSync(DB_PATH, buffer);
                console.log(`[CloudSync] pos.db berhasil disinkronkan dari cloud (${buffer.length} bytes).`);
                return true;
            }
        } else if (res.status === 404) {
            console.log('[CloudSync] File database/pos.db belum ada di Supabase. Menggunakan database lokal.');
            return false;
        } else {
            const errText = await res.text();
            console.warn(`[CloudSync] Supabase download status ${res.status}:`, errText);
            return false;
        }
    } catch (err) {
        console.error('[CloudSync] Gagal download pos.db dari Supabase:', err.message);
        return false;
    }
}

/**
 * Mengupload file pos.db lokal ke Supabase Storage.
 */
async function uploadDb() {
    if (isUploading) {
        hasPendingUpload = true;
        return;
    }

    if (!fs.existsSync(DB_PATH)) {
        console.warn('[CloudSync] File pos.db lokal tidak ditemukan untuk di-upload.');
        return;
    }

    isUploading = true;
    try {
        const buffer = fs.readFileSync(DB_PATH);
        const endpoint = `${SUPABASE_URL}/storage/v1/object/${SUPABASE_BUCKET}/${REMOTE_PATH}`;
        const res = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
                'apikey': SUPABASE_SERVICE_KEY,
                'Content-Type': 'application/x-sqlite3',
                'x-upsert': 'true'
            },
            body: buffer
        });

        if (res.ok) {
            const timeStr = new Date().toLocaleTimeString('id-ID', { timeZone: 'Asia/Makassar' });
            console.log(`[CloudSync] pos.db berhasil di-backup ke Supabase Storage (${buffer.length} bytes) [${timeStr} WITA]`);
        } else {
            console.error('[CloudSync] Gagal upload pos.db ke Supabase:', await res.text());
        }
    } catch (err) {
        console.error('[CloudSync] Error uploadDb:', err.message);
    } finally {
        isUploading = false;
        if (hasPendingUpload) {
            hasPendingUpload = false;
            setTimeout(uploadDb, 1000);
        }
    }
}

/**
 * Debounce upload agar tidak membebani network saat banyak transaksi beruntun.
 */
function scheduleUpload(delayMs = 2500) {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
        debounceTimer = null;
        uploadDb();
    }, delayMs);
}

module.exports = {
    downloadDb,
    uploadDb,
    scheduleUpload,
    DB_PATH
};

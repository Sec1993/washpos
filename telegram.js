const fs = require('fs');
const path = require('path');
const db = require('./database');

function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function getTelegramSettings() {
    return new Promise((resolve) => {
        db.all("SELECT key, value FROM settings WHERE key IN ('telegram_bot_token', 'telegram_chat_id', 'telegram_auto_send', 'telegram_auto_send_time', 'telegram_timezone', 'telegram_last_auto_report_date', 'shop_name')", (err, rows) => {
            const map = {};
            (rows || []).forEach(r => map[r.key] = r.value);
            resolve({
                botToken: map.telegram_bot_token || process.env.TELEGRAM_BOT_TOKEN || '',
                chatId: map.telegram_chat_id || process.env.TELEGRAM_CHAT_ID || '',
                autoSend: map.telegram_auto_send !== '0',
                autoSendTime: map.telegram_auto_send_time || '20:00',
                timezone: map.telegram_timezone || 'Asia/Makassar',
                lastReportDate: map.telegram_last_auto_report_date || '',
                shopName: map.shop_name || 'Prime Motowash'
            });
        });
    });
}

/**
 * Helper untuk mengirim file dokumen fisik pos.db ke Telegram.
 * 1. Ambil buffer fisik dari database lokal (data/pos.db).
 * 2. Fallback: jika lokal tidak ada, unduh buffer dari Supabase Cloud Storage.
 * 3. Kirim ke Telegram API sendDocument sebagai binary document (application/octet-stream).
 */
async function sendTelegramDocumentHelper(botToken, chatId, caption = '') {
    const cleanToken = String(botToken || '').trim();
    const cleanChatId = String(chatId || '').trim();
    const todayStr = new Date().toISOString().slice(0, 10);
    const dbPath = path.resolve(__dirname, 'data', 'pos.db');
    let fileBuffer = null;

    // 1. Coba baca file buffer database lokal
    if (fs.existsSync(dbPath)) {
        try {
            const buf = fs.readFileSync(dbPath);
            if (buf && buf.length > 0) {
                fileBuffer = buf;
                console.log('[Telegram] Menggunakan berkas pos.db lokal (' + buf.length + ' bytes).');
            }
        } catch (err) {
            console.warn('[Telegram] Gagal membaca pos.db lokal:', err.message);
        }
    }

    // 2. Fallback: Unduh buffer pos.db dari Supabase Cloud jika lokal belum ada / error
    if (!fileBuffer) {
        try {
            console.log('[Telegram] Mengambil berkas pos.db dari Supabase Cloud Storage...');
            const cloudDbUrl = 'https://qhclkhpymihmlbmecpdv.supabase.co/storage/v1/object/public/washpos-photos/database/pos.db';
            const sRes = await fetch(cloudDbUrl);
            if (sRes.ok) {
                const arrBuf = await sRes.arrayBuffer();
                fileBuffer = Buffer.from(arrBuf);
                console.log('[Telegram] Berhasil mengunduh pos.db dari cloud (' + fileBuffer.length + ' bytes).');
            } else {
                console.warn('[Telegram] Supabase download status:', sRes.status);
            }
        } catch (err) {
            console.warn('[Telegram] Gagal mengunduh pos.db dari cloud:', err.message);
        }
    }

    if (!fileBuffer || fileBuffer.length === 0) {
        return { success: false, error: 'Berkas database pos.db tidak ditemukan di lokal maupun cloud.' };
    }

    // 3. Kirim dokumen via Telegram sendDocument multipart
    try {
        const blob = new Blob([fileBuffer], { type: 'application/octet-stream' });
        const formData = new FormData();
        formData.append('chat_id', cleanChatId);
        if (caption) {
            formData.append('caption', caption);
            if (caption.includes('<')) {
                formData.append('parse_mode', 'HTML');
            }
        }
        formData.append('document', blob, `pos_backup_${todayStr}.db`);

        const res = await fetch(`https://api.telegram.org/bot${cleanToken}/sendDocument`, {
            method: 'POST',
            body: formData
        });
        const data = await res.json();
        if (res.ok && data.ok) {
            console.log('[Telegram] Dokumen pos.db berhasil terkirim ke chat:', cleanChatId);
            return { success: true };
        }
        console.error('[Telegram] sendDocument error response:', data);
        return { success: false, error: data.description || 'Gagal mengirim dokumen pos.db' };
    } catch (err) {
        console.error('[Telegram] sendDocument fetch error:', err.message);
        return { success: false, error: err.message };
    }
}

/**
 * Uji coba kirim pesan dari WashPOS ke Telegram.
 */
async function sendTelegramTest(senderName = 'Owner') {
    const { botToken, chatId } = await getTelegramSettings();
    if (!botToken || !chatId) {
        return { 
            success: false, 
            message: 'Bot Token atau Chat ID Telegram belum diatur. Silakan lengkapi di menu Master.' 
        };
    }

    const cleanToken = String(botToken).trim();
    const cleanChatId = String(chatId).trim();

    const text = `🧪 <b>Uji Coba Koneksi Telegram Bot</b>\n\n` +
        `Koneksi antara server <b>WashPOS</b> dan Telegram Anda <b>berhasil terhubung</b> dengan baik!\n\n` +
        `• <b>Status</b>: ✅ Aktif & Siap Menerima Laporan & Backup File\n` +
        `• <b>Penguji</b>: ${escapeHtml(senderName)}\n` +
        `• <b>Waktu</b>: ${new Date().toLocaleString('id-ID')}\n\n` +
        `<i>WashPOS Cloud System</i>`;

    try {
        const endpoint = `https://api.telegram.org/bot${cleanToken}/sendMessage`;
        const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: cleanChatId,
                text: text,
                parse_mode: 'HTML'
            })
        });

        const data = await res.json();
        if (!res.ok || !data.ok) {
            return { 
                success: false, 
                message: `Telegram menolak pesan: ${data.description || 'Gagal mengirim'}` 
            };
        }

        // Kirim berkas pos.db sekaligus saat tes!
        const docResult = await sendTelegramDocumentHelper(cleanToken, cleanChatId, '🧪 Uji Coba Lampiran File Database pos.db');

        return { 
            success: true, 
            message: docResult.success 
                ? 'Pesan uji coba & berkas pos.db berhasil terkirim ke Telegram Anda!' 
                : 'Pesan teks berhasil terkirim ke Telegram Anda!'
        };
    } catch (err) {
        const detail = err.cause ? ` (${err.cause.message || err.cause.code || err.cause})` : '';
        return { 
            success: false, 
            message: 'Gagal menghubungi Telegram: ' + err.message + detail 
        };
    }
}

/**
 * Mengirim laporan rekap kasir harian + melampirkan berkas fisik pos.db langsung ke Telegram.
 */
async function sendTelegramReport({ date, includeDb = true, senderName = 'Kasir' }) {
    const { botToken, chatId, shopName } = await getTelegramSettings();
    if (!botToken || !chatId) {
        return { 
            success: false, 
            message: 'Bot Token atau Chat ID Telegram belum diatur. Silakan atur di menu Master.' 
        };
    }

    const targetDate = date || new Date().toISOString().slice(0, 10);
    const brandName = shopName || 'Prime Motowash';

    // Query data transaksi harian
    const reportData = await new Promise((resolve) => {
        db.get(`
            SELECT 
                COUNT(id) as total_motor,
                COALESCE(SUM(price), 0) as total_omzet,
                COALESCE(SUM(commission), 0) as total_komisi
            FROM sales 
            WHERE date(date) = date(?)
        `, [targetDate], (err, sSummary) => {
            db.all(`
                SELECT 
                    COALESCE(akun_kas, 'Kas Kecil') as akun,
                    COUNT(id) as count,
                    COALESCE(SUM(price), 0) as total
                FROM sales
                WHERE date(date) = date(?)
                GROUP BY akun
            `, [targetDate], (err, sPayRows) => {
                db.get(`
                    SELECT COALESCE(SUM(amount), 0) as total_expense
                    FROM expenses
                    WHERE date(date) = date(?)
                `, [targetDate], (err, eSummary) => {
                    db.get(`
                        SELECT COALESCE(SUM(debit - credit), 0) as saldo_kas_kecil
                        FROM journals
                        WHERE account_type IN ('Kas Kecil', 'Kas')
                    `, (err, jRow) => {
                        db.all(`
                            SELECT 
                                worker_name,
                                COUNT(id) as motor,
                                COALESCE(SUM(commission), 0) as komisi
                            FROM sales
                            WHERE date(date) = date(?)
                            GROUP BY worker_name
                            ORDER BY motor DESC
                        `, [targetDate], (err, wRows) => {
                            resolve({
                                totalMotor: sSummary ? sSummary.total_motor : 0,
                                totalOmzet: sSummary ? sSummary.total_omzet : 0,
                                totalKomisi: sSummary ? sSummary.total_komisi : 0,
                                paymentBreakdown: sPayRows || [],
                                totalExpense: eSummary ? eSummary.total_expense : 0,
                                saldoKasKecil: jRow ? jRow.saldo_kas_kecil : 0,
                                workerList: wRows || []
                            });
                        });
                    });
                });
            });
        });
    });

    const totalMotor = reportData.totalMotor;
    const totalOmzet = reportData.totalOmzet;
    const totalExpense = reportData.totalExpense;
    const totalKomisi = reportData.totalKomisi;
    const saldoKasKecil = reportData.saldoKasKecil;
    const netOutlet = totalOmzet - totalExpense - totalKomisi;

    let payDetailStr = '';
    if (reportData.paymentBreakdown.length > 0) {
        payDetailStr = reportData.paymentBreakdown
            .map(p => `  • <b>${escapeHtml(p.akun)}</b>: Rp ${p.total.toLocaleString('id-ID')} (${p.count} trx)`)
            .join('\n');
    } else {
        payDetailStr = '  <i>Tidak ada transaksi</i>';
    }

    let workerStr = '';
    if (reportData.workerList.length > 0) {
        workerStr = reportData.workerList
            .map(w => `  • <b>${escapeHtml(w.worker_name)}</b>: ${w.motor} motor (Komisi: Rp ${w.komisi.toLocaleString('id-ID')})`)
            .join('\n');
    } else {
        workerStr = '  <i>Tidak ada pengerjaan</i>';
    }

    let reportMsg = `📊 <b>LAPORAN KASIR HARIAN — ${targetDate}</b>\n` +
        `<i>Penutupan kasir outlet ${escapeHtml(brandName)} per tanggal ${targetDate}</i>\n\n` +
        `🛵 <b>Total Motor Dicuci</b>: <b>${totalMotor} unit</b>\n` +
        `💰 <b>Total Omset</b>: <b>Rp ${totalOmzet.toLocaleString('id-ID')}</b>\n\n` +
        `💳 <b>Rincian Pembayaran</b>:\n${payDetailStr}\n\n` +
        `💸 <b>Pengeluaran Kasir</b>: Rp ${totalExpense.toLocaleString('id-ID')}\n` +
        `🤝 <b>Komisi Pencuci</b>: Rp ${totalKomisi.toLocaleString('id-ID')}\n` +
        `🏢 <b>Porsi Bersih Toko</b>: <b>Rp ${netOutlet.toLocaleString('id-ID')}</b>\n` +
        `💵 <b>Saldo Fisik Kasir (Kas Kecil)</b>: <b>Rp ${saldoKasKecil.toLocaleString('id-ID')}</b>\n\n` +
        `👥 <b>Pengerjaan Pencuci</b>:\n${workerStr}\n\n` +
        `<i>${escapeHtml(brandName)} Cloud System • Pengirim: ${escapeHtml(senderName)}</i>`;

    try {
        // 1. Kirim pesan ringkasan teks
        const msgRes = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text: reportMsg,
                parse_mode: 'HTML'
            })
        });

        const msgData = await msgRes.json();
        if (!msgRes.ok || !msgData.ok) {
            return {
                success: false,
                message: `Telegram menolak pesan laporan: ${msgData.description || 'Gagal mengirim'}`
            };
        }

        // 2. Jika opsi includeDb aktif: kirim file fisik pos.db langsung sebagai dokumen!
        let fileSent = false;
        let fileError = null;
        if (includeDb) {
            const docResult = await sendTelegramDocumentHelper(
                botToken, 
                chatId, 
                `💾 <b>Backup Database SQLite (pos.db) — ${targetDate}</b>\n<i>Berkas arsip cadangan data seluruh transaksi & master.</i>`
            );
            if (docResult.success) {
                fileSent = true;
            } else {
                fileError = docResult.error;
            }
        }

        const successMsg = fileSent
            ? `Laporan tanggal ${targetDate} & berkas fisik pos.db berhasil dikirim ke Telegram!`
            : (fileError ? `Laporan tanggal ${targetDate} terkirim (file: ${fileError})` : `Laporan tanggal ${targetDate} berhasil dikirim ke Telegram!`);

        return { success: true, message: successMsg };
    } catch (err) {
        const detail = err.cause ? ` (${err.cause.message || err.cause.code || err.cause})` : '';
        return { success: false, message: 'Gagal mengirim ke Telegram: ' + err.message + detail };
    }
}

/**
 * Pengecekan otomatis jadwal pengiriman laporan Telegram setiap jam 20:00 (atau sesuai jadwal).
 */
async function checkAndRunScheduledReport() {
    const settings = await getTelegramSettings();
    const { botToken, chatId, autoSend, autoSendTime, timezone, lastReportDate } = settings;

    if (!botToken || !chatId) {
        return { success: false, skipped: true, reason: 'Telegram bot token atau chat ID belum diatur.' };
    }

    if (!autoSend) {
        return { success: false, skipped: true, reason: 'Pengiriman otomatis Telegram dinonaktifkan.' };
    }

    const now = new Date();
    const timeStr = new Intl.DateTimeFormat('id-ID', {
        timeZone: timezone,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
    }).format(now).replace('.', ':');

    const dateStr = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).format(now);

    if (lastReportDate === dateStr) {
        return { success: true, skipped: true, reason: `Laporan hari ini (${dateStr}) sudah pernah terkirim ke Telegram.` };
    }

    if (timeStr < autoSendTime) {
        return { success: true, skipped: true, reason: `Belum masuk jam target (sekarang: ${timeStr}, target: ${autoSendTime} ${timezone})` };
    }

    const tzLabel = timezone.includes('Makassar') ? 'WITA' : (timezone.includes('Jayapura') ? 'WIT' : 'WIB');
    console.log(`[Telegram Auto-Report] Waktu ${timeStr} mencapai jadwal ${autoSendTime} (${tzLabel}). Mengirim laporan otomatis & backup pos.db tanggal ${dateStr}...`);

    const result = await sendTelegramReport({
        date: dateStr,
        includeDb: true,
        senderName: `Sistem Otomatis (Penutupan ${autoSendTime} ${tzLabel})`
    });

    if (result.success) {
        db.run("INSERT INTO settings (key, value) VALUES ('telegram_last_auto_report_date', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [dateStr]);
        console.log(`[Telegram Auto-Report] Sukses mengirim rekap & file pos.db ke Telegram.`);
    } else {
        console.error(`[Telegram Auto-Report] Gagal: ${result.message}`);
    }

    return result;
}

module.exports = {
    getTelegramSettings,
    sendTelegramTest,
    sendTelegramReport,
    checkAndRunScheduledReport
};
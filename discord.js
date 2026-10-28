const fs = require('fs');
const path = require('path');
const db = require('./database');

const DISCORD_USER_AGENT = 'WashPOS-CloudBot/1.0 (https://washpos.onrender.com)';

function getWebhookUrl() {
    return new Promise((resolve) => {
        db.get("SELECT value FROM settings WHERE key='discord_webhook_url'", (err, row) => {
            if (row && row.value && row.value.trim()) {
                resolve(row.value.trim());
            } else {
                resolve(process.env.DISCORD_WEBHOOK_URL || '');
            }
        });
    });
}

/**
 * Mengirim request ke Discord dengan mekanisme fallback otomatis:
 * Jika request langsung ke discord.com terkena 429 (global rate limit IP Render) atau Cloudflare block,
 * request akan otomatis diulang melalui proxy terpercaya (webhook.lewisakura.moe).
 */
async function postWithProxyFallback(url, optionsBuilder) {
    const urls = [url];
    if (url.includes('discord.com')) {
        urls.push(url.replace('discord.com', 'webhook.lewisakura.moe'));
    }

    let lastError = null;

    for (let i = 0; i < urls.length; i++) {
        const targetUrl = urls[i];
        const isFallback = i > 0;
        try {
            const reqOptions = optionsBuilder(isFallback, targetUrl);
            reqOptions.headers = reqOptions.headers || {};
            reqOptions.headers['User-Agent'] = DISCORD_USER_AGENT;

            const res = await fetch(targetUrl, reqOptions);
            const resText = await res.text();

            if (res.ok) {
                return {
                    success: true,
                    viaFallback: isFallback,
                    message: isFallback 
                        ? 'Pesan berhasil terkirim ke Discord melalui jalur anti-blokir Cloud!' 
                        : 'Pesan berhasil terkirim ke Discord!'
                };
            }

            lastError = `Status ${res.status}: ${resText}`;

            // Jika status 429 (rate limit IP) atau 403 Cloudflare block, coba jalur proxy jika tersedia
            const isRateLimitOrBlocked = res.status === 429 || (res.status === 403 && resText.toLowerCase().includes('cloudflare'));
            if (isRateLimitOrBlocked && i < urls.length - 1) {
                console.warn(`[Discord Webhook] ${targetUrl} terblokir rate limit (${res.status}). Mengalihkan ke proxy anti-blokir...`);
                continue;
            }

            return { success: false, message: `Discord menolak pesan (${lastError})` };
        } catch (err) {
            lastError = err.message;
            if (i < urls.length - 1) {
                console.warn(`[Discord Webhook] Gagal menghubungi ${targetUrl} (${err.message}). Mengalihkan ke proxy...`);
                continue;
            }
        }
    }

    return { success: false, message: 'Gagal menghubungi Discord: ' + (lastError || 'Unknown error') };
}

async function sendDiscordTest(senderName = 'Owner') {
    const webhookUrl = await getWebhookUrl();
    if (!webhookUrl) {
        return { success: false, message: 'URL Webhook Discord belum diatur. Silakan atur terlebih dahulu di menu Master.' };
    }

    const payload = {
        username: 'WashPOS Bot',
        avatar_url: 'https://cdn-icons-png.flaticon.com/512/3003/3003984.png',
        embeds: [{
            title: '🧪 Uji Coba Koneksi Discord Webhook',
            color: 0x0d6efd, // Blue
            description: `Koneksi antara server **WashPOS** dan channel Discord Anda **berhasil terhubung** dengan baik!`,
            fields: [
                { name: 'Status', value: '✅ Aktif & Siap Menerima Laporan', inline: true },
                { name: 'Penguji', value: senderName, inline: true }
            ],
            footer: { text: 'WashPOS Cloud System' },
            timestamp: new Date().toISOString()
        }]
    };

    return await postWithProxyFallback(webhookUrl, () => ({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    }));
}

async function sendDiscordReport({ date, includeDb = false, senderName = 'Kasir' }) {
    const webhookUrl = await getWebhookUrl();
    if (!webhookUrl) {
        return { success: false, message: 'URL Webhook Discord belum diatur. Silakan atur terlebih dahulu di menu Master.' };
    }

    const targetDate = date || new Date().toISOString().slice(0, 10);

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

    // Rincian pembayaran
    let payDetailStr = '';
    if (reportData.paymentBreakdown.length > 0) {
        payDetailStr = reportData.paymentBreakdown
            .map(p => `• **${p.akun}**: Rp ${p.total.toLocaleString('id-ID')} (${p.count} trx)`)
            .join('\n');
    } else {
        payDetailStr = 'Tidak ada transaksi';
    }

    const fields = [
        { name: '🛵 Total Motor Dicuci', value: `**${totalMotor}** unit`, inline: true },
        { name: '💰 Total Omset', value: `**Rp ${totalOmzet.toLocaleString('id-ID')}**`, inline: true },
        { name: '💳 Rincian Pembayaran', value: payDetailStr, inline: false },
        { name: '💸 Pengeluaran Kasir', value: `Rp ${totalExpense.toLocaleString('id-ID')}`, inline: true },
        { name: '🤝 Komisi Pencuci', value: `Rp ${totalKomisi.toLocaleString('id-ID')}`, inline: true },
        { name: '🏢 Porsi Bersih Toko', value: `**Rp ${netOutlet.toLocaleString('id-ID')}**`, inline: true },
        { name: '💵 Saldo Kasir (Kas Kecil)', value: `**Rp ${saldoKasKecil.toLocaleString('id-ID')}**`, inline: false }
    ];

    if (reportData.workerList.length > 0) {
        const workerStr = reportData.workerList
            .map(w => `• **${w.worker_name}**: ${w.motor} motor (Komisi: Rp ${w.komisi.toLocaleString('id-ID')})`)
            .join('\n');
        fields.push({ name: '👥 Pengerjaan Pencuci', value: workerStr, inline: false });
    }

    const payload = {
        username: 'WashPOS Bot',
        avatar_url: 'https://cdn-icons-png.flaticon.com/512/3003/3003984.png',
        embeds: [{
            title: `📊 LAPORAN KASIR HARIAN - ${targetDate}`,
            color: 0x28a745, // Green
            description: `Laporan penutupan kasir outlet WashPOS per tanggal **${targetDate}**.`,
            fields,
            footer: { text: `WashPOS Cloud System • Kasir/Pengirim: ${senderName}` },
            timestamp: new Date().toISOString()
        }]
    };

    const dbPath = path.join(__dirname, 'data', 'pos.db');
    const shouldAttachDb = includeDb && fs.existsSync(dbPath);

    return await postWithProxyFallback(webhookUrl, (isFallback, targetUrl) => {
        const isProxy = isFallback || (targetUrl && targetUrl.includes('webhook.lewisakura.moe'));

        // Jalur direct Discord bisa multipart/form-data jika ada file db
        if (shouldAttachDb && !isProxy) {
            const formData = new FormData();
            formData.append('payload_json', JSON.stringify(payload));
            const fileBuffer = fs.readFileSync(dbPath);
            const blob = new Blob([fileBuffer], { type: 'application/x-sqlite3' });
            formData.append('files[0]', blob, `pos_backup_${targetDate}.db`);
            return {
                method: 'POST',
                body: formData
            };
        } else {
            // Jalur proxy Cloud hanya menerima format JSON murni
            const finalPayload = JSON.parse(JSON.stringify(payload));
            if (shouldAttachDb && isProxy) {
                finalPayload.embeds[0].fields.push({
                    name: '💾 Backup Database SQLite',
                    value: 'File database `pos.db` tersimpan aman di server dan dapat diunduh kapan saja di menu **Master > Backup Database** (Jalur proxy cloud khusus mengirim teks & angka rekap kasir).',
                    inline: false
                });
            }

            return {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(finalPayload)
            };
        }
    });
}

/**
 * Pengecekan dan eksekusi otomatis pengiriman laporan Discord harian (misal setiap jam 20:00).
 */
async function checkAndRunScheduledReport() {
    return new Promise((resolve) => {
        db.all("SELECT key, value FROM settings WHERE key IN ('discord_webhook_url', 'discord_auto_send', 'discord_auto_send_time', 'discord_timezone', 'discord_last_auto_report_date')", async (err, rows) => {
            if (err) return resolve({ success: false, skipped: true, reason: err.message });

            const settings = {};
            (rows || []).forEach(r => settings[r.key] = r.value);

            const webhookUrl = settings.discord_webhook_url || process.env.DISCORD_WEBHOOK_URL;
            if (!webhookUrl) return resolve({ success: false, skipped: true, reason: 'Webhook URL belum diatur' });

            const isAutoSend = settings.discord_auto_send !== '0';
            if (!isAutoSend) return resolve({ success: false, skipped: true, reason: 'Pengiriman otomatis dinonaktifkan' });

            const targetTime = settings.discord_auto_send_time || '20:00';
            const tz = settings.discord_timezone || 'Asia/Makassar';

            const now = new Date();
            const timeStr = new Intl.DateTimeFormat('id-ID', {
                timeZone: tz,
                hour: '2-digit',
                minute: '2-digit',
                hour12: false
            }).format(now).replace('.', ':');

            const dateStr = new Intl.DateTimeFormat('en-CA', {
                timeZone: tz,
                year: 'numeric',
                month: '2-digit',
                day: '2-digit'
            }).format(now);

            const lastSentDate = settings.discord_last_auto_report_date || '';

            if (lastSentDate === dateStr) {
                return resolve({ success: true, skipped: true, reason: `Laporan hari ini (${dateStr}) sudah pernah terkirim` });
            }

            if (timeStr < targetTime) {
                return resolve({ success: true, skipped: true, reason: `Belum masuk jam target (sekarang: ${timeStr}, target: ${targetTime})` });
            }

            const tzLabel = tz.includes('Makassar') ? 'WITA' : (tz.includes('Jayapura') ? 'WIT' : 'WIB');
            console.log(`[Discord Auto-Report] Waktu ${timeStr} mencapai jadwal ${targetTime} (${tzLabel}). Mengirim laporan otomatis tanggal ${dateStr}...`);

            const result = await sendDiscordReport({
                date: dateStr,
                includeDb: true,
                senderName: `Sistem Otomatis (Penutupan ${targetTime} ${tzLabel})`
            });

            if (result.success) {
                db.run("INSERT INTO settings (key, value) VALUES ('discord_last_auto_report_date', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [dateStr]);
                console.log(`[Discord Auto-Report] Berhasil mengirim laporan harian otomatis tanggal ${dateStr}`);
            } else {
                console.error(`[Discord Auto-Report] Gagal mengirim: ${result.message}`);
            }

            resolve(result);
        });
    });
}

module.exports = {
    getWebhookUrl,
    sendDiscordTest,
    sendDiscordReport,
    checkAndRunScheduledReport
};
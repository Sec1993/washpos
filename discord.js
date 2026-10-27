const fs = require('fs');
const path = require('path');
const db = require('./database');

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

    try {
        const res = await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!res.ok) {
            const errText = await res.text();
            return { success: false, message: `Discord menolak pesan (Status ${res.status}): ${errText}` };
        }
        return { success: true, message: 'Pesan uji coba berhasil terkirim ke Discord!' };
    } catch (err) {
        return { success: false, message: 'Gagal menghubungi Discord: ' + err.message };
    }
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

    try {
        const dbPath = path.join(__dirname, 'data', 'pos.db');
        let res;

        if (includeDb && fs.existsSync(dbPath)) {
            const formData = new FormData();
            formData.append('payload_json', JSON.stringify(payload));
            const fileBuffer = fs.readFileSync(dbPath);
            const blob = new Blob([fileBuffer], { type: 'application/x-sqlite3' });
            formData.append('files[0]', blob, `pos_backup_${targetDate}.db`);

            res = await fetch(webhookUrl, {
                method: 'POST',
                body: formData
            });
        } else {
            res = await fetch(webhookUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
        }

        if (!res.ok) {
            const errText = await res.text();
            return { success: false, message: `Discord merespon error (${res.status}): ${errText}` };
        }

        return { success: true, message: `Laporan tanggal ${targetDate} berhasil dikirim ke Discord!` };
    } catch (err) {
        return { success: false, message: 'Gagal mengirim laporan ke Discord: ' + err.message };
    }
}

module.exports = {
    getWebhookUrl,
    sendDiscordTest,
    sendDiscordReport
};
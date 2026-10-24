const cloudSync = require('./cloudSync');

console.log('==================================================');
console.log('   WASHPOS - CLOUD DATABASE SYNCHRONIZER         ');
console.log('==================================================');

(async () => {
    try {
        const success = await cloudSync.downloadDb();
        if (success) {
            console.log('[Startup] Sinkronisasi database cloud berhasil!');
        } else {
            console.log('[Startup] Sinkronisasi cloud selesai (menggunakan data lokal jika ada).');
        }
    } catch (err) {
        console.error('[Startup] Catatan: Sinkronisasi gagal, server tetap melanjutkan.', err.message);
    }
})();

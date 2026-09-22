@echo off
cd /d "%~dp0"
echo Menjalankan WashPOS di http://localhost:3000 ...
echo Jangan tutup window ini, biarkan tetap terbuka.
echo Login Owner: owner / owner123  |  Karyawan: karyawan / karyawan123
node server.js
pause

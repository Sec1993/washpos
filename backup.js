#!/usr/bin/env node
const fs=require('fs'), path=require('path');
const srcDb=path.join(__dirname,'pos.db');
const srcUploads=path.join(__dirname,'public','uploads');
const backupRoot=path.join(__dirname,'backups');
if(!fs.existsSync(backupRoot)) fs.mkdirSync(backupRoot);
const ts=new Date().toISOString().slice(0,19).replace(/[:T]/g,'-');
const dest=path.join(backupRoot, ts);
fs.mkdirSync(dest, {recursive:true});
if(fs.existsSync(srcDb)) fs.copyFileSync(srcDb, path.join(dest,'pos.db'));
if(fs.existsSync(srcUploads)){
  const copyRec=(s,d)=>{
    fs.mkdirSync(d,{recursive:true});
    fs.readdirSync(s).forEach(f=>{
      const ss=path.join(s,f), dd=path.join(d,f);
      if(fs.statSync(ss).isDirectory()) copyRec(ss,dd);
      else fs.copyFileSync(ss,dd);
    });
  };
  copyRec(srcUploads, path.join(dest,'uploads'));
}
console.log('Backup ke', dest);
// hapus backup >7 hari
fs.readdirSync(backupRoot).forEach(f=>{
  const p=path.join(backupRoot,f);
  const stat=fs.statSync(p);
  if(Date.now()-stat.mtimeMs > 7*24*60*60*1000){
    fs.rmSync(p,{recursive:true, force:true});
    console.log('Hapus backup lama', f);
  }
});

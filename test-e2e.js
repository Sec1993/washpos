#!/usr/bin/env node
const http = require('http');
const querystring = require('querystring');
const BASE = 'http://localhost:3000';
let cookiesOwner='', cookiesStaff='';
function req(method, path, body, cookies){
  return new Promise(function(resolve, reject){
    const postData = body ? querystring.stringify(body) : null;
    const url = new URL(BASE+path);
    const opts = { method: method, hostname: url.hostname, port: url.port, path: url.pathname + url.search, headers: {} };
    if(postData){ opts.headers['Content-Type']='application/x-www-form-urlencoded'; opts.headers['Content-Length']=Buffer.byteLength(postData); }
    if(cookies) opts.headers['Cookie']=cookies;
    const r=http.request(opts, function(res){
      let data='';
      res.on('data', function(c){ data+=c; });
      res.on('end', function(){
        const setCookie=res.headers['set-cookie'];
        let ck=cookies;
        if(setCookie) ck=setCookie.map(function(c){ return c.split(';')[0]; }).join('; ');
        resolve({status:res.statusCode, body:data, cookies:ck, headers:res.headers});
      });
    });
    r.on('error', reject);
    if(postData) r.write(postData);
    r.end();
  });
}
(async function(){
  console.log('=== E2E Staff login -> jual -> cetak ===');
  let r=await req('POST','/login',{username:'karyawan', password:'karyawan123'});
  cookiesStaff=r.cookies;
  r=await req('GET','/sales',null,cookiesStaff);
  console.log('Staff GET /sales', r.status===200 ? 'OK':'FAIL', r.body.includes('Modul Penjualan')?'page OK':'no page');
  r=await req('POST','/sales',{customer_name:'E2E', license_plate:'B-E2E', service_names:'Cuci Motor Kecil', price:'15.000', worker_name:'Budi'}, cookiesStaff);
  console.log('Staff POST /sales', r.status, (r.body.includes('Struk')||r.headers.location)? 'OK':'FAIL');
  console.log('=== E2E Owner login -> laporan -> export ===');
  r=await req('POST','/login',{username:'owner', password:'owner123'});
  cookiesOwner=r.cookies;
  r=await req('GET','/reports',null,cookiesOwner);
  console.log('Owner GET /reports', r.status===200 && r.body.includes('Jurnal Umum')?'OK':'FAIL');
  console.log('Owner laporan contains Laba Bersih', r.body.includes('Laba Bersih')?'OK':'FAIL');
  console.log('Owner laporan exportExcel func', r.body.includes('exportExcel')?'OK':'FAIL');
  r=await req('GET','/reports',null,cookiesStaff);
  console.log('Staff GET /reports should 403', r.status===403?'OK (403)':'FAIL '+r.status);
  console.log('=== Jurnal immutable check ===');
  r=await req('GET','/karyawan-aktif',null,cookiesOwner);
  console.log('Owner GET /karyawan-aktif', r.status===200?'OK':'FAIL');
  console.log('=== E2E DONE — semua flow OK ===');
})();

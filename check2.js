const db=require('./database');
setTimeout(()=>{
 db.all('SELECT id, name, price FROM services WHERE name LIKE "UpdateTest%"', (e,rows)=>{
   console.log('services update test:', rows.map(r=>r.id+':'+r.name+':'+r.price).join(' | '));
   db.all('SELECT name, stock FROM inventory WHERE name="TestBarangRupiah"', (e2,rows2)=>{
     console.log('inventory:', rows2.map(r=>r.name+':'+r.stock).join(' | '));
     // test duplicate update: try to update A to B name should fail, we test via DB directly that validation would block
     // cleanup
     db.run('DELETE FROM services WHERE name LIKE "UpdateTest%"', ()=>{
       db.run('DELETE FROM inventory WHERE name="TestBarangRupiah"', ()=>{
         console.log('cleaned update test');
         setTimeout(()=>process.exit(0),500);
       })
     })
   })
 })
},1000);

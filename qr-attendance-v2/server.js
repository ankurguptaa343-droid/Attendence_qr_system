require('dotenv').config();
const express=require('express'),helmet=require('helmet'),cookie=require('cookie-parser'),rl=require('express-rate-limit'),
jwt=require('jsonwebtoken'),bcrypt=require('bcryptjs'),crypto=require('crypto'),QR=require('qrcode'),XLSX=require('xlsx'),
multer=require('multer'),{Pool}=require('pg');
const {DATABASE_URL,JWT_SECRET,QR_SECRET,ADMIN_EMAIL,ADMIN_PASSWORD}=process.env;
if(!DATABASE_URL||!JWT_SECRET||!QR_SECRET){console.error('Set DATABASE_URL, JWT_SECRET, QR_SECRET');process.exit(1)}
const db=new Pool({max:3,connectionString:DATABASE_URL,ssl:process.env.PGSSL?{rejectUnauthorized:false}:undefined});
const app=express(),up=multer({storage:multer.memoryStorage(),limits:{fileSize:5e6}});
app.set('trust proxy',1);
let ready;const init=()=>ready||(ready=(async()=>{if(ADMIN_EMAIL&&ADMIN_PASSWORD)await db.query('INSERT INTO admins(email,password_hash) VALUES($1,$2) ON CONFLICT(email) DO NOTHING',[ADMIN_EMAIL.toLowerCase(),await bcrypt.hash(ADMIN_PASSWORD,12)])})());
app.use((q,s,n)=>init().then(()=>n()).catch(e=>{ready=null;console.error(e);s.status(500).json({error:'Server error'})}));
app.use(helmet({contentSecurityPolicy:false}),express.json({limit:'100kb'}),cookie());
const wrap=f=>(q,s,n)=>f(q,s,n).catch(e=>{console.error(e);s.status(500).json({error:'Server error'})});
const EMAIL=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const sign=(id,v)=>crypto.createHmac('sha256',QR_SECRET).update(id+'.'+v).digest('base64url');
const tokenFor=p=>`${p.id}.${p.qr_version}.${sign(p.id,p.qr_version)}`;
function auth(q,s,n){try{q.admin=jwt.verify(q.cookies.sid,JWT_SECRET);n()}catch{s.status(401).json({error:'Unauthorized'})}}
// ---- auth
app.post('/api/auth/admin/login',rl({windowMs:9e5,max:10}),wrap(async(q,s)=>{
 const {email,password}=q.body||{};if(typeof email!=='string'||typeof password!=='string')return s.status(400).json({error:'Invalid input'});
 const {rows:[a]}=await db.query('SELECT * FROM admins WHERE email=$1',[email.trim().toLowerCase()]);
 if(!a||!(await bcrypt.compare(password,a.password_hash)))return s.status(401).json({error:'Invalid credentials'});
 s.cookie('sid',jwt.sign({id:a.id,email:a.email},JWT_SECRET,{expiresIn:'12h'}),{httpOnly:true,sameSite:'strict',secure:process.env.NODE_ENV==='production',maxAge:432e5});s.json({ok:true})}));
app.post('/api/auth/logout',(q,s)=>{s.clearCookie('sid');s.json({ok:true})});
app.get('/api/auth/me',auth,(q,s)=>s.json(q.admin));
// ---- participant
app.post('/api/participants/verify-email',rl({windowMs:9e5,max:15}),wrap(async(q,s)=>{
 const email=String(q.body?.email||'').trim().toLowerCase();
 if(!EMAIL.test(email))return s.status(400).json({error:'Enter a valid email address.'});
 const {rows:[p]}=await db.query('SELECT * FROM participants WHERE email=$1',[email]);
 if(!p)return s.status(404).json({error:'This email is not registered for this program.'});
 const {rows:att}=await db.query('SELECT e.name,a.marked_at FROM attendance a JOIN events e ON e.id=a.event_id WHERE a.participant_id=$1 ORDER BY a.marked_at DESC',[p.id]);
 s.json({name:p.name,email:p.email,qr:await QR.toDataURL(tokenFor(p),{width:600,margin:2,errorCorrectionLevel:'M'}),attendance:att})}));
// ---- scan
app.post('/api/attendance/scan',auth,rl({windowMs:6e4,max:120}),wrap(async(q,s)=>{
 const {token,eventId}=q.body||{};const [id,v,sig]=String(token||'').split('.');
 const bad=()=>s.status(400).json({status:'invalid',message:'This QR is not associated with a registered participant.'});
 if(!/^[0-9a-f-]{36}$/.test(id||'')||!/^\d+$/.test(v||'')||!sig)return bad();
 const exp=sign(id,v);if(sig.length!==exp.length||!crypto.timingSafeEqual(Buffer.from(sig),Buffer.from(exp)))return bad();
 const {rows:[p]}=await db.query('SELECT * FROM participants WHERE id=$1 AND qr_version=$2',[id,v]);if(!p)return bad();
 const {rows:[ev]}=await db.query('SELECT * FROM events WHERE id=$1',[parseInt(eventId)||0]);
 if(!ev)return s.status(400).json({status:'error',message:'Select an event first.'});
 if(ev.status!=='open')return s.status(403).json({status:'error',message:'Attendance is closed for this event.'});
 const {rows:[r]}=await db.query('INSERT INTO attendance(participant_id,event_id,marked_by) VALUES($1,$2,$3) ON CONFLICT(participant_id,event_id) DO NOTHING RETURNING marked_at',[p.id,ev.id,q.admin.id]);
 if(r)return s.json({status:'success',name:p.name,email:p.email,time:r.marked_at});
 const {rows:[o]}=await db.query('SELECT marked_at FROM attendance WHERE participant_id=$1 AND event_id=$2',[p.id,ev.id]);
 s.json({status:'duplicate',name:p.name,email:p.email,time:o.marked_at})}));
// ---- events
app.get('/api/events',auth,wrap(async(q,s)=>s.json((await db.query('SELECT * FROM events ORDER BY date DESC NULLS LAST,id DESC')).rows)));
app.post('/api/events',auth,wrap(async(q,s)=>{const b=q.body||{};if(!String(b.name||'').trim())return s.status(400).json({error:'Name required'});
 const {rows:[e]}=await db.query('INSERT INTO events(name,date,start_time,end_time,location) VALUES($1,$2,$3,$4,$5) RETURNING *',[b.name.trim(),b.date||null,b.start_time||null,b.end_time||null,b.location||null]);s.status(201).json(e)}));
app.patch('/api/events/:id',auth,wrap(async(q,s)=>{const b=q.body||{};if(b.status&&!['open','closed'].includes(b.status))return s.status(400).json({error:'Bad status'});
 const {rows:[e]}=await db.query('UPDATE events SET name=COALESCE($2,name),status=COALESCE($3,status),location=COALESCE($4,location) WHERE id=$1 RETURNING *',[+q.params.id||0,b.name||null,b.status||null,b.location||null]);e?s.json(e):s.status(404).json({error:'Not found'})}));
app.delete('/api/events/:id',auth,wrap(async(q,s)=>{await db.query('DELETE FROM events WHERE id=$1',[+q.params.id||0]);s.json({ok:true})}));
// ---- participants admin
app.get('/api/admin/participants',auth,wrap(async(q,s)=>{const t=`%${q.query.search||''}%`;
 s.json((await db.query('SELECT id,name,email,phone FROM participants WHERE name ILIKE $1 OR email ILIKE $1 ORDER BY name LIMIT 500',[t])).rows)}));
app.post('/api/admin/participants/:id/revoke-qr',auth,wrap(async(q,s)=>{await db.query('UPDATE participants SET qr_version=qr_version+1,updated_at=now() WHERE id=$1',[q.params.id]);s.json({ok:true})}));
// ---- report
async function report(eventId,f={}){
 const ev=+eventId;const w=[],a=[ev];
 if(f.search){a.push(`%${f.search}%`);w.push(`(p.name ILIKE $${a.length} OR p.email ILIKE $${a.length})`)}
 if(f.status==='present')w.push('a.id IS NOT NULL');if(f.status==='absent')w.push('a.id IS NULL');
 return (await db.query(`SELECT p.name,p.phone,p.email,e.name AS event,CASE WHEN a.id IS NULL THEN 'Absent' ELSE 'Present' END AS status,a.marked_at FROM participants p CROSS JOIN events e LEFT JOIN attendance a ON a.participant_id=p.id AND a.event_id=e.id WHERE e.id=$1 ${w.length?'AND '+w.join(' AND '):''} ORDER BY a.marked_at DESC NULLS LAST,p.name`,a)).rows}
app.get('/api/attendance',auth,wrap(async(q,s)=>s.json(await report(q.query.eventId,q.query))));
app.get('/api/attendance/stats',auth,wrap(async(q,s)=>{
 const {rows:[r]}=await db.query('SELECT (SELECT count(*) FROM participants)::int total,(SELECT count(*) FROM attendance WHERE event_id=$1)::int present,(SELECT count(*) FROM events)::int events',[+q.query.eventId||0]);
 s.json({...r,absent:r.total-r.present,percent:r.total?+(r.present*100/r.total).toFixed(1):0})}));
app.get('/api/admin/export',auth,wrap(async(q,s)=>{
 const rows=(await report(q.query.eventId,q.query)).map(r=>({Name:r.name,Phone:r.phone,Email:r.email,Event:r.event,Status:r.status,'Attendance Time':r.marked_at?new Date(r.marked_at).toLocaleString():''}));
 const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(rows),'Attendance');
 s.set({'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','Content-Disposition':'attachment; filename="attendance.xlsx"'}).send(XLSX.write(wb,{type:'buffer',bookType:'xlsx'}))}));
// ---- import
const ALIAS={name:['name','full name','student name','participant name','fullname'],email:['email','email id','email address','e-mail','mail','emailid'],phone:['phone','phone number','mobile','mobile number','contact','contact number']};
const find=(row,k)=>{const key=Object.keys(row).find(h=>ALIAS[k].includes(String(h).trim().toLowerCase()));return key?String(row[key]??'').trim():''};
app.post('/api/admin/import',auth,up.single('file'),wrap(async(q,s)=>{
 if(!q.file)return s.status(400).json({error:'No file'});
 if(q.body.mode==='replace'&&q.body.confirm!=='yes')return s.status(400).json({error:'Replace requires confirmation'});
 let rows;try{rows=XLSX.utils.sheet_to_json(XLSX.read(q.file.buffer,{type:'buffer'}).Sheets[XLSX.read(q.file.buffer,{type:'buffer'}).SheetNames[0]],{defval:''})}catch{return s.status(400).json({error:'Unreadable file'})}
 if(rows.length&&(!find(rows[0],'email')&&!Object.keys(rows[0]).some(h=>ALIAS.email.includes(h.trim().toLowerCase()))))return s.status(400).json({error:'No Email column found. Headers: '+Object.keys(rows[0]).join(', ')});
 const sum={total:rows.length,imported:0,updated:0,duplicates:0,invalidEmails:0,missing:0},seen=new Set(),c=await db.connect();
 try{await c.query('BEGIN');
  if(q.body.mode==='replace')await c.query('DELETE FROM participants');
  for(const r of rows){const name=find(r,'name'),email=find(r,'email').toLowerCase(),phone=find(r,'phone');
   if(!name||!email){sum.missing++;continue}if(!EMAIL.test(email)){sum.invalidEmails++;continue}
   if(seen.has(email)){sum.duplicates++;continue}seen.add(email);
   const {rows:[x]}=await c.query('INSERT INTO participants(name,email,phone) VALUES($1,$2,$3) ON CONFLICT(email) DO UPDATE SET name=EXCLUDED.name,phone=EXCLUDED.phone,updated_at=now() RETURNING (xmax=0) AS ins',[name,email,phone||null]);
   x.ins?sum.imported++:sum.updated++}
  await c.query('COMMIT')}catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
 s.json(sum)}));
app.use('/api',(q,s)=>s.status(404).json({error:'Not found'}));
app.use(express.static(__dirname+'/public',{extensions:['html']}));
if(!process.env.VERCEL)init().then(()=>app.listen(process.env.PORT||3000,()=>console.log('Running')));
module.exports=app;

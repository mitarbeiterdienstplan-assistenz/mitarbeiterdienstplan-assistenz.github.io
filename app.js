import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  sendEmailVerification, sendPasswordResetEmail, signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, collection, doc, getDoc, onSnapshot, query, where,
  setDoc, addDoc, updateDoc, deleteDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

// Wer Chef ist, steht nur in den Firestore-Regeln (nicht hier im öffentlichen Code).
// Die Seite fragt nach: Nur der Chef darf "admins/<eigene E-Mail>" lesen.

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
auth.languageCode = "de";
const db = getFirestore(app);

const SHORT = ["Mo.","Di.","Mi.","Do.","Fr.","Sa.","So."];
const LONG = ["Montag","Dienstag","Mittwoch","Donnerstag","Freitag","Samstag","Sonntag"];
const $ = id => document.getElementById(id);

/* ---------- Hilfsfunktionen ---------- */
const mod = (a,b) => ((a%b)+b)%b;
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
function iso(d){return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0")}
function dayNum(s){const [y,m,d]=s.split("-").map(Number);return Math.round(Date.UTC(y,m-1,d)/864e5)}
function fromNum(n){return new Date(n*864e5).toISOString().slice(0,10)}
function mondayNum(off){const t=dayNum(iso(new Date()));return t-mod(t+3,7)+off*7}
function fmt(s){const [,m,d]=s.split("-");return d+"."+m+"."}
function weekdayLong(s){return LONG[mod(dayNum(s)+3,7)]}
function kw(s){const d=new Date(dayNum(s)*864e5);d.setUTCDate(d.getUTCDate()-mod(d.getUTCDay()+6,7)+3);
  const f=new Date(Date.UTC(d.getUTCFullYear(),0,4));return 1+Math.round(((d-f)/864e5-3+mod(f.getUTCDay()+6,7))/7)}
function toMin(t){const [h,m]=t.split(":").map(Number);return h*60+m}
function dur(s){const a=toMin(s.from),b=toMin(s.to);return b>a?b-a:b+1440-a}
function hours(min){return (min/60).toFixed(2).replace(".",",")}
function initials(n){return String(n).trim().split(/\s+/).map(w=>w[0]||"").join("").slice(0,2).toUpperCase()}
const overnight = s => toMin(s.to) <= toMin(s.from);

function toast(title,msg,bad){
  const el=$("toast"); el.className="toast"+(bad?" bad":"");
  el.innerHTML="<b>"+esc(title)+"</b><span>"+esc(msg)+"</span>"; el.hidden=false;
  clearTimeout(toast.h); toast.h=setTimeout(()=>el.hidden=true,3200);
}
function fail(e){console.error(e);toast("Das hat nicht geklappt", e?.code==="permission-denied"?"Dafür fehlt die Berechtigung.":"Bitte nochmal versuchen. ("+(e?.code||e?.message||"Fehler")+")",true)}

function authMessage(code){
  return ({
    "auth/invalid-credential":"E-Mail oder Passwort stimmt nicht.",
    "auth/wrong-password":"E-Mail oder Passwort stimmt nicht.",
    "auth/user-not-found":"E-Mail oder Passwort stimmt nicht.",
    "auth/invalid-email":"Diese E-Mail-Adresse ist ungültig.",
    "auth/email-already-in-use":"Für diese E-Mail gibt es schon ein Konto. Bitte oben auf „Anmelden“ gehen.",
    "auth/weak-password":"Das Passwort ist zu kurz. Bitte mindestens 8 Zeichen.",
    "auth/too-many-requests":"Zu viele Versuche. Bitte ein paar Minuten warten.",
    "auth/network-request-failed":"Keine Internetverbindung.",
    "auth/missing-password":"Bitte ein Passwort eingeben."
  })[code] || "Das hat nicht geklappt ("+code+").";
}

/* ---------- Zustand ---------- */
let me=null, isChef=false, team=new Map(), weekShifts=[], openShifts=[];
let weekOffset=0, focus=null, search="", listeners=[], weekListener=null;

function stopListeners(){listeners.forEach(u=>u());listeners=[];if(weekListener){weekListener();weekListener=null}}
function show(id){document.querySelectorAll(".screen").forEach(s=>s.hidden=s.id!==id)}
function nameOf(mail){if(!mail)return "";const t=team.get(mail);if(t)return t.name;return isChef&&mail===me?"Chef":mail}
function colorOf(mail){const t=team.get(mail);return t?mod(t.color||0,6):0}

/* ---------- Anmelden ---------- */
let mode="login";
function setMode(m){
  mode=m;
  $("tab-login").classList.toggle("on",m==="login"); $("tab-login").setAttribute("aria-selected",m==="login");
  $("tab-register").classList.toggle("on",m==="register"); $("tab-register").setAttribute("aria-selected",m==="register");
  $("pass2-wrap").hidden=m!=="register"; $("register-hint").hidden=m!=="register"; $("forgot").hidden=m!=="login";
  $("login-pass").autocomplete=m==="register"?"new-password":"current-password";
  $("login-submit").textContent=m==="register"?"Konto erstellen":"Anmelden";
  $("login-err").hidden=true;
}
$("tab-login").onclick=()=>setMode("login");
$("tab-register").onclick=()=>setMode("register");
function loginError(t){$("login-err").textContent=t;$("login-err").hidden=false}

$("login-form").addEventListener("submit",async e=>{
  e.preventDefault();
  const mail=$("login-email").value.trim(), pass=$("login-pass").value;
  if(!mail)return loginError("Bitte deine E-Mail eingeben.");
  if(!pass)return loginError("Bitte ein Passwort eingeben.");
  const btn=$("login-submit"); btn.disabled=true;
  try{
    if(mode==="register"){
      if(pass.length<8)return loginError("Das Passwort braucht mindestens 8 Zeichen.");
      if(pass!==$("login-pass2").value)return loginError("Die beiden Passwörter sind nicht gleich.");
      const cred=await createUserWithEmailAndPassword(auth,mail,pass);
      await sendEmailVerification(cred.user);
    }else{
      await signInWithEmailAndPassword(auth,mail,pass);
    }
    $("login-pass").value=""; $("login-pass2").value="";
  }catch(err){loginError(authMessage(err.code))}
  finally{btn.disabled=false}
});

$("forgot").onclick=async()=>{
  const mail=$("login-email").value.trim();
  if(!mail)return loginError("Bitte oben zuerst deine E-Mail eingeben, dann nochmal auf „Passwort vergessen?“ tippen.");
  try{await sendPasswordResetEmail(auth,mail)}catch(err){if(err.code==="auth/invalid-email")return loginError(authMessage(err.code))}
  $("login-err").hidden=true;
  toast("Mail unterwegs","Wenn es ein Konto mit dieser E-Mail gibt, kommt gleich eine Mail zum Zurücksetzen.");
};

document.querySelectorAll("[data-logout]").forEach(b=>b.onclick=()=>signOut(auth));

$("verify-check").onclick=async()=>{
  const u=auth.currentUser; if(!u)return;
  await u.reload();
  if(!u.emailVerified){$("verify-err").textContent="Noch nicht bestätigt. Bitte zuerst auf den Link in der Mail klicken.";$("verify-err").hidden=false;return}
  await u.getIdToken(true);
  route(u);
};
$("verify-resend").onclick=async()=>{
  try{await sendEmailVerification(auth.currentUser);toast("Gesendet","Die Bestätigungs-Mail ist nochmal unterwegs.")}
  catch(err){$("verify-err").textContent=authMessage(err.code);$("verify-err").hidden=false}
};
$("denied-check").onclick=()=>route(auth.currentUser);

onAuthStateChanged(auth,user=>route(user));

async function route(user){
  stopListeners(); closeModal();
  if(!user){setMode("login");show("screen-login");return}
  if(!user.emailVerified){$("verify-mail").textContent=user.email;$("verify-err").hidden=true;show("screen-verify");return}
  me=user.email.toLowerCase(); isChef=false;
  try{await getDoc(doc(db,"admins",me));isChef=true}catch(e){/* kein Chef */}
  if(!isChef){
    let ok=false;
    try{ok=(await getDoc(doc(db,"team",me))).exists()}catch(e){console.error(e)}
    if(!ok){$("denied-mail").textContent=me;show("screen-denied");return}
  }
  startApp();
}

/* ---------- Daten live laden ---------- */
// Kein Zugriff mehr (z. B. vom Chef entfernt): neu prüfen – aber höchstens alle 10 Sekunden, damit es keine Schleife gibt
let lastDenied=0;
function onDenied(err){
  console.error(err);
  if(err.code!=="permission-denied"){toast("Verbindungsproblem","Die Daten konnten nicht geladen werden. Bitte Seite neu laden.",true);return}
  if(isChef||Date.now()-lastDenied<10000){toast("Kein Zugriff","Die Daten konnten nicht geladen werden.",true);return}
  lastDenied=Date.now(); route(auth.currentUser);
}

function startApp(){
  show("screen-app");
  $("team-btn").hidden=!isChef;
  listeners.push(onSnapshot(collection(db,"team"),snap=>{
    team=new Map(snap.docs.map(d=>[d.id,d.data()])); render();
  },onDenied));
  listeners.push(onSnapshot(query(collection(db,"shifts"),where("status","in",["open","wait"])),snap=>{
    openShifts=snap.docs.map(d=>({id:d.id,...d.data()})); render();
  },onDenied));
  watchWeek();
}
function watchWeek(){
  if(weekListener)weekListener();
  const n0=mondayNum(weekOffset);
  weekShifts=[]; render();
  weekListener=onSnapshot(query(collection(db,"shifts"),where("date",">=",fromNum(n0)),where("date","<=",fromNum(n0+6))),snap=>{
    weekShifts=snap.docs.map(d=>({id:d.id,...d.data()})); render();
  },onDenied);
}
function findShift(id){return weekShifts.find(s=>s.id===id)||openShifts.find(s=>s.id===id)}

/* ---------- Anzeige ---------- */
function render(){
  if($("screen-app").hidden)return;
  const n0=mondayNum(weekOffset), days=[...Array(7)].map((_,i)=>fromNum(n0+i)), today=iso(new Date());
  $("kwlabel").textContent="KW "+kw(days[0]);
  $("who-label").textContent="Angemeldet: "+nameOf(me)+(isChef?" (Chef)":"");

  // Mitarbeiter mit Stunden
  const members=[...team.entries()].map(([mail,t])=>({mail,...t})).sort((a,b)=>a.name.localeCompare(b.name,"de"));
  const shown=members.filter(t=>t.name.toLowerCase().includes(search)||t.mail.includes(search));
  $("people").innerHTML=shown.length?shown.map(t=>{
    const min=weekShifts.filter(s=>s.who===t.mail&&s.status!=="open").reduce((a,s)=>a+dur(s),0);
    const soll=Number(t.soll)||0;
    return '<button class="person'+(focus===t.mail?" on":"")+'" data-a="focus" data-n="'+esc(t.mail)+'"><span class="av" style="background:var(--p'+colorOf(t.mail)+')">'+esc(initials(t.name))+'</span><span><b>'+esc(t.name)+'</b><span class="hrs'+(soll&&min/60>soll?" over":"")+'">'+hours(min)+' / '+hours(soll*60)+'</span></span></button>';
  }).join(""):'<p class="note">'+(members.length?"Niemand gefunden.":(isChef?"Noch keine Mitarbeiter. Oben auf „Mitarbeiter“ tippen und E-Mails eintragen.":"Noch keine Mitarbeiter eingetragen."))+'</p>';

  // Wochenraster
  let h=days.map((d,i)=>'<div class="dh'+(i===0?" first":"")+(d===today?" today":"")+'">'+SHORT[i]+" "+fmt(d)+'</div>').join("");
  days.forEach((d,i)=>{
    const list=weekShifts.filter(s=>s.date===d).sort((a,b)=>toMin(a.from)-toMin(b.from));
    h+='<div class="cell'+(i===0?" first":"")+'">'+(list.length?list.map(cardHTML).join(""):'<div class="free">Kein Dienst</div>')+
      (isChef?'<button class="add" data-a="new" data-date="'+d+'" aria-label="Dienst hinzufügen am '+fmt(d)+'">+ Dienst</button>':'')+'</div>';
  });
  $("grid").innerHTML=h;

  // Meldungen: offene Dienste ab gestern
  const from=fromNum(dayNum(today)-1);
  const open=openShifts.filter(s=>s.date>=from).sort((a,b)=>(a.date+a.from).localeCompare(b.date+b.from));
  $("alerts").innerHTML=open.length?'<div class="alert" role="status"><h2>'+(isChef?"Offene Dienste":"Wer kann einspringen?")+'</h2>'+
    open.map(s=>{let b="";
      if(s.status==="open"&&!isChef&&me!==s.gaveUp)b='<button class="btn small" data-a="take" data-id="'+s.id+'">Ich übernehme</button>';
      if(s.status==="wait"&&isChef)b='<button class="btn small" data-a="ok" data-id="'+s.id+'">'+esc(nameOf(s.taker))+' bestätigen</button>';
      if(s.status==="wait"&&!isChef&&s.taker===me)b='<span class="note">Wartet auf Bestätigung</span>';
      const txt=s.status==="open"?(s.gaveUp?esc(nameOf(s.gaveUp))+" kann nicht":"Noch niemand eingeteilt"):esc(nameOf(s.taker))+" will übernehmen";
      return '<div class="arow"><span><b>'+weekdayLong(s.date)+" "+fmt(s.date)+", "+s.from+" – "+s.to+' Uhr</b> · '+txt+'</span>'+b+'</div>'}).join("")+'</div>':"";
}

function cardHTML(s){
  const cls=s.status==="open"?" open":s.status==="wait"?" wait":"";
  const i=colorOf(s.who), style=s.status==="open"?"":' style="--c:var(--p'+i+');--cb:var(--p'+i+'-bg)"';
  const dim=focus&&s.who!==focus&&s.taker!==focus?" dim":"";
  const mine=!isChef&&s.status==="ok"&&s.who===me?" mine":"";
  const name=s.status==="open"?(s.gaveUp?"<s>"+esc(nameOf(s.gaveUp))+"</s>":"Noch niemand"):esc(nameOf(s.who))+(mine?" (du)":"");
  const st=s.status==="open"?"Offen – wer kann?":s.status==="wait"?esc(nameOf(s.taker))+" will übernehmen":"";
  return '<button class="card'+cls+dim+mine+'"'+style+' data-a="open" data-id="'+s.id+'"><span class="tm">'+s.from+' – '+s.to+'</span>'+
    (overnight(s)?'<span class="nx">endet am Folgetag</span>':'')+'<span class="nm">'+name+'</span>'+(st?'<span class="st">'+st+'</span>':'')+'</button>';
}

/* ---------- Fenster ---------- */
const modal=$("modal"), dialog=$("dialog");
function closeModal(){modal.hidden=true;dialog.innerHTML=""}
function openModal(html){dialog.innerHTML=html;modal.hidden=false;const f=dialog.querySelector("input,select,button.btn:not(.ghost)");if(f)f.focus()}

function openShift(id,date){
  const s=id?findShift(id):null;
  if(id&&!s)return;
  if(isChef){
    const d=s?s.date:date;
    const last=weekShifts.filter(x=>x.date===d).sort((a,b)=>toMin(a.from)-toMin(b.from)).slice(-1)[0];
    const from=s?s.from:(last?last.to:"08:00"), to=s?s.to:"16:00";
    const cur=s&&s.status==="ok"?s.who:"";
    const members=[...team.entries()].sort((a,b)=>a[1].name.localeCompare(b[1].name,"de"));
    openModal('<h3>'+(s?"Dienst ändern":"Neuer Dienst")+'</h3><p>'+weekdayLong(d)+", "+fmt(d)+'</p>'+
      (s&&s.status==="wait"?'<div class="waitbox"><span><b>'+esc(nameOf(s.taker))+'</b> will übernehmen</span><span class="btns"><button class="btn small" data-a="ok" data-id="'+s.id+'">Bestätigen</button><button class="btn ghost small" data-a="no" data-id="'+s.id+'">Ablehnen</button></span></div>':'')+
      '<form id="shift-form" class="fields" data-id="'+(s?s.id:"")+'" data-date="'+d+'">'+
      '<label class="field">Von<input type="time" id="f-from" value="'+from+'" required></label>'+
      '<label class="field">Bis<input type="time" id="f-to" value="'+to+'" required></label>'+
      '<label class="field wide">Wer<select id="f-who"><option value="">Offen – wer kann?</option>'+
        members.map(([mail,t])=>'<option value="'+esc(mail)+'"'+(mail===cur?" selected":"")+'>'+esc(t.name)+'</option>').join("")+'</select></label>'+
      '<p class="note wide">Endet der Dienst nach Mitternacht (z. B. 19:00 bis 04:00), einfach so eintragen – das wird automatisch als „über Nacht“ erkannt.</p>'+
      '<p class="err wide" id="f-err" hidden></p></form>'+
      '<div class="btns">'+(s?'<button class="btn del" data-a="askdel" data-id="'+s.id+'">Löschen</button>':'')+
      '<button class="btn ghost" data-a="close">Abbrechen</button><button class="btn" type="submit" form="shift-form">Speichern</button></div>');
  }else{
    let body="", btns='<button class="btn ghost" data-a="close">Schließen</button>';
    if(s.status==="ok"&&s.who===me){body="Das ist dein Dienst. Wenn du nicht kannst, sehen alle anderen, dass jemand gesucht wird.";btns+='<button class="btn warn" data-a="cant" data-id="'+s.id+'">Ich kann nicht</button>'}
    else if(s.status==="open"&&s.gaveUp!==me){body="Dieser Dienst ist offen. Kannst du einspringen?";btns+='<button class="btn" data-a="take" data-id="'+s.id+'">Ich übernehme</button>'}
    else if(s.status==="open"){body="Du hast diesen Dienst abgegeben. Es wird jemand gesucht."}
    else if(s.status==="wait"){body=(s.taker===me?"Du":esc(nameOf(s.taker)))+" will übernehmen. Der Chef muss noch bestätigen."}
    else body="Eingeteilt: "+esc(nameOf(s.who))+".";
    openModal('<h3>'+weekdayLong(s.date)+", "+fmt(s.date)+'</h3><p><b>'+s.from+" – "+s.to+' Uhr</b>'+(overnight(s)?" (endet am Folgetag)":"")+'</p><p>'+body+'</p><div class="btns">'+btns+'</div>');
  }
}

/* Mitarbeiter verwalten (nur Chef) */
function openTeam(){
  const members=[...team.entries()].sort((a,b)=>a[1].name.localeCompare(b[1].name,"de"));
  const link=location.origin+location.pathname;
  openModal('<h3>Mitarbeiter</h3><p>Nur diese E-Mails können sich registrieren und den Dienstplan sehen.</p>'+
    '<div class="teamlist">'+(members.length?members.map(([mail,t])=>
      '<div class="trow"><span class="av" style="background:var(--p'+mod(t.color||0,6)+')">'+esc(initials(t.name))+'</span><span class="tx"><b>'+esc(t.name)+'</b><span>'+esc(mail)+' · Soll '+hours((Number(t.soll)||0)*60)+' Std.</span></span>'+
      '<button class="btn del small" data-a="askrm" data-n="'+esc(mail)+'">Entfernen</button></div>').join(""):'<p class="note">Noch niemand eingetragen.</p>')+'</div>'+
    '<form id="team-form" class="fields">'+
      '<label class="field wide">Name<input id="t-name" autocomplete="off" placeholder="z. B. Anna Meier" required></label>'+
      '<label class="field">E-Mail<input id="t-mail" type="email" autocomplete="off" inputmode="email" required></label>'+
      '<label class="field">Soll-Stunden pro Woche<input id="t-soll" type="number" min="0" max="80" step="0.5" value="0"></label>'+
      '<p class="err wide" id="t-err" hidden></p>'+
      '<div class="btns wide"><button class="btn" type="submit">Hinzufügen</button></div></form>'+
    '<p class="note">Diesen Link an deine Mitarbeiter schicken:</p>'+
    '<div class="share"><code id="share-link">'+esc(link)+'</code><button class="btn ghost small" data-a="copy">Kopieren</button></div>'+
    '<div class="btns"><button class="btn ghost" data-a="close">Fertig</button></div>');
}

/* ---------- Aktionen ---------- */
async function act(a,el){
  const id=el.dataset.id, ref=id?doc(db,"shifts",id):null, s=id?findShift(id):null;
  try{
    if(a==="cant"){await updateDoc(ref,{status:"open",gaveUp:me,taker:null});closeModal();toast("Erledigt","Dienst abgegeben – alle sehen, dass jemand gesucht wird.")}
    if(a==="take"){await updateDoc(ref,{status:"wait",taker:me});closeModal();toast("Danke!","Der Chef muss noch bestätigen.")}
    if(a==="ok"&&s){await updateDoc(ref,{who:s.taker,status:"ok",taker:null,gaveUp:null});closeModal();toast("Erfolgreich",nameOf(s.taker)+" übernimmt den Dienst.")}
    if(a==="no"){await updateDoc(ref,{status:"open",taker:null});closeModal();toast("Abgelehnt","Der Dienst ist wieder offen.")}
    if(a==="askdel"){el.textContent="Wirklich löschen?";el.dataset.a="del"}
    else if(a==="del"){await deleteDoc(ref);closeModal();toast("Erfolgreich","Dienst wurde gelöscht.")}
    if(a==="askrm"){el.textContent="Wirklich entfernen?";el.dataset.a="rm"}
    else if(a==="rm"){await deleteDoc(doc(db,"team",el.dataset.n));toast("Entfernt","Diese E-Mail hat keinen Zugriff mehr.");setTimeout(openTeam,50)}
    if(a==="copy"){
      const t=$("share-link").textContent;
      try{await navigator.clipboard.writeText(t);toast("Kopiert","Link ist in der Zwischenablage.")}
      catch{const r=document.createRange();r.selectNodeContents($("share-link"));const sel=getSelection();sel.removeAllRanges();sel.addRange(r)}
    }
  }catch(e){fail(e)}
}

$("prev").onclick=()=>{weekOffset--;watchWeek()};
$("next").onclick=()=>{weekOffset++;watchWeek()};
$("today").onclick=()=>{weekOffset=0;watchWeek()};
$("team-btn").onclick=openTeam;
$("search").oninput=e=>{search=e.target.value.toLowerCase();render()};
document.addEventListener("keydown",e=>{if(e.key==="Escape"&&!modal.hidden)closeModal()});
modal.addEventListener("click",e=>{if(e.target===modal)closeModal()});
document.body.addEventListener("click",e=>{
  const b=e.target.closest("[data-a]"); if(!b)return;
  const a=b.dataset.a;
  if(a==="open")return openShift(b.dataset.id);
  if(a==="new")return openShift(null,b.dataset.date);
  if(a==="close")return closeModal();
  if(a==="focus"){focus=focus===b.dataset.n?null:b.dataset.n;return render()}
  act(a,b);
});

document.body.addEventListener("submit",async e=>{
  if(e.target.id==="shift-form"){
    e.preventDefault();
    const f=e.target, from=$("f-from").value, to=$("f-to").value, who=$("f-who").value, err=$("f-err");
    if(!from||!to||from===to){err.textContent="Bitte zwei verschiedene Uhrzeiten eingeben.";err.hidden=false;return}
    const id=f.dataset.id, old=id?findShift(id):null;
    const data={date:f.dataset.date,from,to,who:who||null,status:who?"ok":"open",gaveUp:null,taker:null};
    if(old&&!who&&old.status!=="ok"){data.status=old.status;data.gaveUp=old.gaveUp??null;data.taker=old.taker??null}
    try{
      if(id)await setDoc(doc(db,"shifts",id),data); else await addDoc(collection(db,"shifts"),data);
      closeModal(); toast("Erfolgreich",id?"Schicht wurde aktualisiert!":"Schicht wurde angelegt!");
    }catch(x){fail(x)}
  }
  if(e.target.id==="team-form"){
    e.preventDefault();
    const name=$("t-name").value.trim(), mail=$("t-mail").value.trim().toLowerCase(), soll=parseFloat($("t-soll").value)||0, err=$("t-err");
    if(!name){err.textContent="Bitte einen Namen eingeben.";err.hidden=false;return}
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)){err.textContent="Bitte eine gültige E-Mail eingeben.";err.hidden=false;return}
    if(team.has(mail)){err.textContent="Diese E-Mail ist schon eingetragen.";err.hidden=false;return}
    if(mail===me){err.textContent="Das ist deine eigene E-Mail, die hat als Chef schon Zugriff.";err.hidden=false;return}
    const used=new Set([...team.values()].map(t=>t.color));
    let color=0; while(used.has(color)&&color<5)color++;
    try{await setDoc(doc(db,"team",mail),{name,soll,color});toast("Hinzugefügt",name+" kann sich jetzt registrieren.");setTimeout(openTeam,50)}
    catch(x){fail(x)}
  }
});

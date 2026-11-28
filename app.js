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

// Vorschau mit Beispieldaten – funktioniert NUR auf dem eigenen PC (localhost), nie auf der echten Seite
const DEMO = ["localhost","127.0.0.1"].includes(location.hostname) ? new URLSearchParams(location.search).get("demo") : null;

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
auth.languageCode = "de";
const db = getFirestore(app);

const SHORT = ["Mo.","Di.","Mi.","Do.","Fr.","Sa.","So."];
const LONG = ["Montag","Dienstag","Mittwoch","Donnerstag","Freitag","Samstag","Sonntag"];
const MONTHS = ["Januar","Februar","März","April","Mai","Juni","Juli","August","September","Oktober","November","Dezember"];
const $ = id => document.getElementById(id);

/* ---------- Hilfsfunktionen ---------- */
const mod = (a,b) => ((a%b)+b)%b;
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
function iso(d){return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0")}
function dayNum(s){const [y,m,d]=s.split("-").map(Number);return Math.round(Date.UTC(y,m-1,d)/864e5)}
function fromNum(n){return new Date(n*864e5).toISOString().slice(0,10)}
const todayIso = () => iso(new Date());
function mondayNum(off){const t=dayNum(todayIso());return t-mod(t+3,7)+off*7}
function fmt(s){const [,m,d]=s.split("-");return d+"."+m+"."}
function weekdayLong(s){return LONG[mod(dayNum(s)+3,7)]}
// „Samstag, 28. November“
function longDate(s){const [,m,d]=s.split("-").map(Number);return weekdayLong(s)+", "+d+". "+MONTHS[m-1]}
// „Heute“ / „Morgen“ / „Übermorgen“
function relDay(s){const diff=dayNum(s)-dayNum(todayIso());return diff===0?"Heute":diff===1?"Morgen":diff===2?"Übermorgen":""}
function kw(s){const d=new Date(dayNum(s)*864e5);d.setUTCDate(d.getUTCDate()-mod(d.getUTCDay()+6,7)+3);
  const f=new Date(Date.UTC(d.getUTCFullYear(),0,4));return 1+Math.round(((d-f)/864e5-3+mod(f.getUTCDay()+6,7))/7)}
function toMin(t){const [h,m]=t.split(":").map(Number);return h*60+m}
function dur(s){const a=toMin(s.from),b=toMin(s.to);return b>a?b-a:b+1440-a}
function hours(min){return (min/60).toFixed(2).replace(".",",")}
function hoursShort(min){const h=min/60;return (Number.isInteger(h)?String(h):h.toFixed(1).replace(".",","))}
// Anfangsbuchstaben nur aus echten Wörtern (Klammern wie "(Test)" zählen nicht mit)
function initials(n){return String(n).split(/\s+/).map(w=>w.replace(/[^\p{L}]/gu,"")).filter(Boolean).filter(w=>w!=="Test").map(w=>w[0]).join("").slice(0,2).toUpperCase()||"?"}
const overnight = s => toMin(s.to) <= toMin(s.from);
const byTime = (a,b) => (a.date+a.from).localeCompare(b.date+b.from);

function toast(title,msg,bad){
  const el=$("toast"); el.className="toast"+(bad?" bad":"");
  el.innerHTML="<b>"+esc(title)+"</b><span>"+esc(msg)+"</span>"; el.hidden=false;
  clearTimeout(toast.h); toast.h=setTimeout(()=>el.hidden=true,3500);
}
function fail(e){console.error(e);toast("Das hat nicht geklappt", e?.code==="permission-denied"?"Der Dienst wurde inzwischen geändert (z. B. hat jemand anderes schon übernommen). Bitte nochmal nachsehen.":"Bitte nochmal versuchen. ("+(e?.code||e?.message||"Fehler")+")",true)}

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

/* ---------- Schrift größer (pro Gerät gemerkt) ---------- */
function applyFont(big){
  document.documentElement.classList.toggle("big",big);
  $("font-btn").textContent=big?"Schrift normal":"Schrift größer";
  $("font-btn").setAttribute("aria-pressed",big);
}
let bigFont=false;
try{bigFont=localStorage.getItem("dp-big")==="1"}catch{}
applyFont(bigFont);
$("font-btn").onclick=()=>{bigFont=!bigFont;applyFont(bigFont);try{localStorage.setItem("dp-big",bigFont?"1":"0")}catch{}};

/* ---------- Zustand ---------- */
let me=null, isChef=false, team=new Map(), weekShifts=[], monthShifts=[], openShifts=[], myShifts=[];
let weekOffset=0, focus=null, search="", view="mine", listeners=[], weekListener=null, showPast=false;

function stopListeners(){listeners.forEach(u=>u());listeners=[];if(weekListener){weekListener();weekListener=null}}
function show(id){document.querySelectorAll(".screen").forEach(s=>s.hidden=s.id!==id)}
function nameOf(mail){if(!mail)return "";const t=team.get(mail);if(t)return t.name;return isChef&&mail===me?"Chef":mail}
// 8 Farben (--p0 … --p7 in index.html)
const COLORS=8;
function colorOf(mail){const t=team.get(mail);return t?mod(t.color||0,COLORS):0}
function findShift(id){return weekShifts.find(s=>s.id===id)||openShifts.find(s=>s.id===id)||myShifts.find(s=>s.id===id)}

/* ---------- Speichern (echt: Firebase, Vorschau: nur im Speicher) ---------- */
const store = {
  update:(id,patch)=>DEMO?demo.update(id,patch):updateDoc(doc(db,"shifts",id),patch),
  set:(id,d)=>DEMO?demo.set(id,d):setDoc(doc(db,"shifts",id),d),
  add:d=>DEMO?demo.set("d"+Math.random().toString(36).slice(2,9),d):addDoc(collection(db,"shifts"),d),
  del:id=>DEMO?demo.del(id):deleteDoc(doc(db,"shifts",id)),
  teamSet:(mail,d)=>DEMO?demo.teamSet(mail,d):setDoc(doc(db,"team",mail),d),
  teamDel:mail=>DEMO?demo.teamDel(mail):deleteDoc(doc(db,"team",mail))
};

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

document.querySelectorAll("[data-logout]").forEach(b=>b.onclick=()=>{if(DEMO)return toast("Vorschau","In der Vorschau kann man sich nicht abmelden.");signOut(auth)});

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

// routeRun verhindert, dass zwei gleichzeitige Prüfungen die Daten doppelt laden
let routeRun=0;
async function route(user){
  const run=++routeRun;
  stopListeners(); closeModal();
  if(!user){setMode("login");show("screen-login");return}
  if(!user.emailVerified){$("verify-mail").textContent=user.email;$("verify-err").hidden=true;show("screen-verify");return}
  me=user.email.toLowerCase(); isChef=false;
  let netErr=false;
  try{await getDoc(doc(db,"admins",me));isChef=true}
  catch(e){if(e.code!=="permission-denied"){netErr=true;console.error(e)}}
  if(run!==routeRun)return;
  if(!isChef&&!netErr){
    let ok=false;
    try{ok=(await getDoc(doc(db,"team",me))).exists()}
    catch(e){if(e.code!=="permission-denied")netErr=true;console.error(e)}
    if(run!==routeRun)return;
    if(!ok&&!netErr){$("denied-mail").textContent=me;$("denied-text").hidden=false;$("denied-net").hidden=true;show("screen-denied");return}
  }
  if(netErr){$("denied-text").hidden=true;$("denied-net").hidden=false;show("screen-denied");return}
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
  view=isChef?"plan":"mine";
  $("team-btn").hidden=!isChef;
  $("side").hidden=!isChef;
  $("viewtabs").hidden=isChef;
  if(DEMO){demo.refresh();return}
  listeners.push(onSnapshot(collection(db,"team"),snap=>{
    team=new Map(snap.docs.map(d=>[d.id,d.data()])); render();
  },onDenied));
  listeners.push(onSnapshot(query(collection(db,"shifts"),where("status","in",["open","wait"])),snap=>{
    openShifts=snap.docs.map(d=>({id:d.id,...d.data()})); render();
  },onDenied));
  if(!isChef){
    listeners.push(onSnapshot(query(collection(db,"shifts"),where("who","==",me)),snap=>{
      myShifts=snap.docs.map(d=>({id:d.id,...d.data()})); render();
    },onDenied));
  }
  watchWeek();
}
// Monat der angezeigten Woche = Monat ihres Donnerstags (wie bei der Kalenderwoche),
// z. B. Woche 30.11.–06.12. gehört zum Dezember
function monthOfWeek(){
  const th=fromNum(mondayNum(weekOffset)+3), [y,m]=th.split("-").map(Number);
  const last=new Date(Date.UTC(y,m,0)).getUTCDate();
  return {a:th.slice(0,8)+"01", b:th.slice(0,8)+String(last).padStart(2,"0"), name:MONTHS[m-1]};
}
// Geladene Dienste aufteilen: angezeigte Woche und ganzer Monat (Monat zählt nach Anfangstag des Dienstes)
function splitLoaded(list){
  const n0=mondayNum(weekOffset), a=fromNum(n0), b=fromNum(n0+6), M=monthOfWeek();
  weekShifts=list.filter(s=>s.date>=a&&s.date<=b);
  monthShifts=list.filter(s=>s.date>=M.a&&s.date<=M.b);
}
function watchWeek(){
  if(DEMO){demo.refresh();return}
  if(weekListener)weekListener();
  // Chef lädt den ganzen Monat mit (für die Monatsstunden links), Mitarbeiter nur die Woche
  const n0=mondayNum(weekOffset), M=monthOfWeek();
  let a=fromNum(n0), b=fromNum(n0+6);
  if(isChef){if(M.a<a)a=M.a; if(M.b>b)b=M.b}
  weekShifts=[]; monthShifts=[]; render();
  weekListener=onSnapshot(query(collection(db,"shifts"),where("date",">=",a),where("date","<=",b)),snap=>{
    splitLoaded(snap.docs.map(d=>({id:d.id,...d.data()}))); render();
  },onDenied);
}

/* ---------- Anzeige ---------- */
function render(){
  if($("screen-app").hidden)return;
  $("who-label").textContent=isChef&&!team.has(me)?"Angemeldet als Chef":nameOf(me)+(isChef?" (Chef)":"");
  document.querySelectorAll("#viewtabs button").forEach(b=>{b.classList.toggle("on",b.dataset.view===view);b.setAttribute("aria-pressed",b.dataset.view===view)});
  $("view-mine").hidden=view!=="mine";
  $("view-plan").hidden=view!=="plan";
  renderAlerts();
  if(view==="mine")renderMine(); else renderPlan();
}

// Oben: „Du wirst gebraucht!“ (Mitarbeiter) bzw. „Offene Dienste“ (Chef)
function renderAlerts(){
  const today=todayIso();
  if(!isChef){
    const need=openShifts.filter(s=>s.status==="open"&&s.gaveUp!==me&&s.date>=today).sort(byTime);
    $("alerts").innerHTML=need.length?'<div class="need" role="status"><h2>Du wirst gebraucht!</h2>'+
      need.map(s=>{const rel=relDay(s.date);
        return '<div class="item"><span class="when">'+(rel?rel+", ":"")+longDate(s.date)+'</span>'+
          '<span class="tm">'+s.from+' bis '+s.to+' Uhr</span>'+(overnight(s)?'<span class="why">endet am nächsten Morgen</span>':'')+
          '<span class="why">'+(s.gaveUp?esc(nameOf(s.gaveUp))+" kann nicht.":"Noch niemand eingeteilt.")+'</span>'+
          '<button class="btn wide" data-a="take" data-id="'+s.id+'">Ich übernehme</button></div>'}).join("")+'</div>':"";
    return;
  }
  const from=fromNum(dayNum(today)-1);
  const open=openShifts.filter(s=>s.date>=from).sort(byTime);
  $("alerts").innerHTML=open.length?'<div class="chefopen" role="status"><h2>Offene Dienste ('+open.length+')</h2>'+
    open.map(s=>{let b="";
      if(s.status==="wait")b='<button class="btn small" data-a="ok" data-id="'+s.id+'">'+esc(nameOf(s.taker))+' bestätigen</button>';
      const txt=s.status==="open"?(s.gaveUp?esc(nameOf(s.gaveUp))+" kann nicht":"Noch niemand eingeteilt"):esc(nameOf(s.taker))+" will übernehmen";
      return '<div class="arow"><span><b>'+weekdayLong(s.date)+" "+fmt(s.date)+", "+s.from+" – "+s.to+' Uhr</b><br>'+txt+'</span>'+b+'</div>'}).join("")+'</div>':"";
}

// „Meine Dienste“ – einfache Liste für Mitarbeiter
function renderMine(){
  const today=todayIso();
  const mine=myShifts.filter(s=>s.date>=today);
  const pending=openShifts.filter(s=>s.status==="wait"&&s.taker===me&&s.date>=today&&!mine.some(m=>m.id===s.id));
  const list=[...mine,...pending].sort(byTime).slice(0,30);
  const n0=mondayNum(0), a=fromNum(n0), b=fromNum(n0+6);
  const weekMin=myShifts.filter(s=>s.status==="ok"&&s.date>=a&&s.date<=b).reduce((x,s)=>x+dur(s),0);
  let h='<div class="minehead"><h2>Deine nächsten Dienste</h2><span class="note">Diese Woche: '+hoursShort(weekMin)+' Stunden</span></div>';
  if(!list.length){
    h+='<div class="empty">Du hast gerade keine Dienste eingetragen. Unter „Ganzer Plan“ siehst du alle Dienste.</div>';
  }else{
    h+='<div class="mylist">'+list.map(s=>{
      let cls="ok", st="Du bist eingeteilt";
      if(s.taker===me&&s.status==="wait"){cls="pend";st="Übernommen – wartet auf Bestätigung vom Chef"}
      else if(s.status==="open"){cls="gone";st="Abgesagt – es wird jemand gesucht"}
      else if(s.status==="wait"){cls="gone";st="Abgesagt – "+esc(nameOf(s.taker))+" will übernehmen"}
      const rel=relDay(s.date);
      return '<button class="mcard '+cls+'" data-a="open" data-id="'+s.id+'">'+
        '<span class="when">'+(rel?'<span class="chip">'+rel+'</span>':'')+longDate(s.date)+'</span>'+
        '<span class="tm">'+s.from+' bis '+s.to+' Uhr</span>'+(overnight(s)?'<span class="nx">endet am nächsten Morgen</span>':'')+
        '<span class="st">'+st+'</span>'+(cls==="ok"?'<span class="tap">Antippen, falls du nicht kannst</span>':'')+'</button>';
    }).join("")+'</div>';
  }
  $("view-mine").innerHTML=h;
}

// „Ganzer Plan“ – PC: Wochenraster, Handy: Tagesliste
function renderPlan(){
  const n0=mondayNum(weekOffset), days=[...Array(7)].map((_,i)=>fromNum(n0+i)), today=todayIso();
  $("kwlabel").textContent="KW "+kw(days[0])+" · "+fmt(days[0])+"–"+fmt(days[6]);

  // Mitarbeiter mit Stunden (nur Chef)
  if(isChef){
    const monthName=monthOfWeek().name;
    const members=[...team.entries()].map(([mail,t])=>({mail,...t})).sort((a,b)=>a.name.localeCompare(b.name,"de"));
    const shown=members.filter(t=>t.name.toLowerCase().includes(search)||t.mail.includes(search));
    $("people").innerHTML=shown.length?shown.map(t=>{
      // nur fest eingeteilte Dienste zählen (abgegebene oder noch nicht bestätigte nicht)
      const sum=list=>list.filter(s=>s.who===t.mail&&s.status==="ok").reduce((a,s)=>a+dur(s),0);
      const min=sum(weekShifts), mon=sum(monthShifts), soll=Number(t.soll)||0;
      return '<button class="person'+(focus===t.mail?" on":"")+'" data-a="focus" data-n="'+esc(t.mail)+'"><span class="av" style="background:var(--p'+colorOf(t.mail)+')">'+esc(initials(t.name))+'</span><span><b>'+esc(t.name)+'</b>'+
        '<span class="hrs'+(soll&&min/60>soll?" over":"")+'">Woche: '+hoursShort(min)+(soll?' / '+hoursShort(soll*60):'')+' Std.</span>'+
        '<span class="hrs">'+monthName+': '+hoursShort(mon)+' Std.</span></span></button>';
    }).join(""):'<p class="note">'+(members.length?"Niemand gefunden.":"Noch keine Mitarbeiter. Oben auf „Mitarbeiter“ tippen und E-Mails eintragen.")+'</p>';
  }

  const perDay=d=>weekShifts.filter(s=>s.date===d).sort((a,b)=>toMin(a.from)-toMin(b.from));

  // Wochenraster (PC)
  let h=days.map((d,i)=>'<div class="dh'+(i===0?" first":"")+(d===today?" today":"")+'">'+SHORT[i]+" "+fmt(d)+'</div>').join("");
  days.forEach((d,i)=>{
    const list=perDay(d);
    h+='<div class="cell'+(i===0?" first":"")+'">'+(list.length?list.map(cardHTML).join(""):'<div class="free">Kein Dienst</div>')+
      (isChef?'<button class="add" data-a="new" data-date="'+d+'" aria-label="Dienst hinzufügen am '+fmt(d)+'">+ Dienst</button>':'')+'</div>';
  });
  $("grid").innerHTML=h;

  // Tagesliste (Handy): vergangene Tage dieser Woche erst auf Wunsch zeigen, damit „Heute“ oben steht
  const past=days.filter(d=>d<today);
  const hidePast=past.length>0&&past.length<7&&!showPast;
  $("daylist").innerHTML=(hidePast?'<button class="add" data-a="showpast">Frühere Tage anzeigen ('+SHORT[0]+" "+fmt(past[0])+(past.length>1?" bis "+SHORT[past.length-1]+" "+fmt(past[past.length-1]):"")+')</button>':"")+
    days.filter(d=>!hidePast||d>=today).map(d=>{
    const list=perDay(d), rel=relDay(d);
    return '<section class="day'+(d===today?" today":"")+'"><div class="dayhead">'+(rel?'<span class="chip">'+rel+'</span>':'')+longDate(d)+'</div>'+
      (list.length?list.map(rowHTML).join(""):'<div class="free">Kein Dienst</div>')+
      (isChef?'<button class="add" data-a="new" data-date="'+d+'">+ Dienst hinzufügen</button>':'')+'</section>';
  }).join("");
}

function shiftLook(s){
  const cls=s.status==="open"?" open":s.status==="wait"?" wait":"";
  const i=colorOf(s.who), style=s.status==="open"?"":' style="--c:var(--p'+i+');--cb:var(--p'+i+'-bg)"';
  const dim=focus&&s.who!==focus&&s.taker!==focus?" dim":"";
  const mine=!isChef&&s.status==="ok"&&s.who===me?" mine":"";
  const name=s.status==="open"?(s.gaveUp?"<s>"+esc(nameOf(s.gaveUp))+"</s>":"Noch niemand"):esc(nameOf(s.who))+(mine?" (du)":"");
  const st=s.status==="open"?"Offen – wer kann?":s.status==="wait"?esc(nameOf(s.taker))+" will übernehmen":"";
  return {cls:cls+dim+mine,style,name,st};
}
function cardHTML(s){
  const L=shiftLook(s);
  return '<button class="card'+L.cls+'"'+L.style+' data-a="open" data-id="'+s.id+'"><span class="tm">'+s.from+' – '+s.to+'</span>'+
    (overnight(s)?'<span class="nx">endet am Folgetag</span>':'')+'<span class="nm">'+L.name+'</span>'+(L.st?'<span class="st">'+L.st+'</span>':'')+'</button>';
}
function rowHTML(s){
  const L=shiftLook(s);
  return '<button class="srow'+L.cls+'"'+L.style+' data-a="open" data-id="'+s.id+'"><span class="tm">'+s.from+' bis '+s.to+' Uhr</span>'+
    (overnight(s)?'<span class="nx">endet am nächsten Morgen</span>':'')+'<span class="nm">'+L.name+'</span>'+(L.st?'<span class="st">'+L.st+'</span>':'')+'</button>';
}

/* ---------- Fenster ---------- */
const modal=$("modal"), dialog=$("dialog");
function closeModal(){modal.hidden=true;dialog.innerHTML=""}
// Fokus auf die Überschrift: kein Knopf ist vorausgewählt (z. B. „Entfernen“) und am Handy springt keine Tastatur auf
function openModal(html){dialog.innerHTML=html;modal.hidden=false;const h=dialog.querySelector("h3");if(h){h.tabIndex=-1;h.focus()}}

function openShift(id,date){
  const s=id?findShift(id):null;
  if(id&&!s)return;
  if(isChef){
    const d=s?s.date:date;
    const last=weekShifts.filter(x=>x.date===d).sort((a,b)=>toMin(a.from)-toMin(b.from)).slice(-1)[0];
    // Vorschlag für neuen Dienst: direkt nach dem letzten Dienst des Tages (außer der geht über Nacht), 8 Stunden lang
    const from=s?s.from:(last&&!overnight(last)?last.to:"08:00");
    const plus8=(toMin(from)+480)%1440, to=s?s.to:String(Math.floor(plus8/60)).padStart(2,"0")+":"+String(plus8%60).padStart(2,"0");
    const cur=s&&s.status==="ok"?s.who:"";
    const members=[...team.entries()].sort((a,b)=>a[1].name.localeCompare(b[1].name,"de"));
    openModal('<h3>'+(s?"Dienst ändern":"Neuer Dienst")+'</h3><p>'+longDate(d)+'</p>'+
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
    let body="", btns='';
    if(s.status==="ok"&&s.who===me){
      body="Das ist dein Dienst. Wenn du nicht kannst, sehen alle anderen, dass jemand gesucht wird.";
      btns='<button class="btn warn-ghost wide" data-a="askcant" data-id="'+s.id+'">Ich kann nicht</button>';
    }
    else if(s.status==="open"&&s.gaveUp!==me){body="Dieser Dienst ist offen. Kannst du einspringen?";btns='<button class="btn wide" data-a="take" data-id="'+s.id+'">Ich übernehme</button>'}
    else if(s.status==="open"){body="Du hast diesen Dienst abgesagt. Es wird jemand gesucht."}
    else if(s.status==="wait"){body=(s.taker===me?"Du willst":esc(nameOf(s.taker))+" will")+" diesen Dienst übernehmen. Der Chef muss noch bestätigen."}
    else body="Eingeteilt: "+esc(nameOf(s.who))+".";
    openModal('<h3>'+longDate(s.date)+'</h3><p class="big">'+s.from+" bis "+s.to+' Uhr</p>'+(overnight(s)?'<p>Endet am nächsten Morgen.</p>':'')+
      '<p>'+body+'</p><div id="confirm-box"></div><div class="btns stack">'+btns+'<button class="btn ghost wide" data-a="close">Schließen</button></div>');
  }
}

/* Mitarbeiter verwalten (nur Chef) */
function openTeam(){
  const members=[...team.entries()].sort((a,b)=>a[1].name.localeCompare(b[1].name,"de"));
  const link=DEMO?"https://mitarbeiterdienstplan-assistenz.github.io/":location.origin+location.pathname;
  openModal('<h3>Mitarbeiter</h3><p>Nur diese E-Mails können sich registrieren und den Dienstplan sehen.</p>'+
    '<div class="teamlist">'+(members.length?members.map(([mail,t])=>
      '<div class="trow"><span class="av" style="background:var(--p'+mod(t.color||0,COLORS)+')">'+esc(initials(t.name))+'</span><span class="tx"><b>'+esc(t.name)+'</b><span>'+esc(mail)+' · Soll '+hours((Number(t.soll)||0)*60)+' Std.</span></span>'+
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
  const id=el.dataset.id, s=id?findShift(id):null;
  try{
    if(a==="askcant"){
      $("confirm-box").innerHTML='<div class="confirm">Wirklich absagen? Dann wird für diesen Dienst jemand anderes gesucht.</div>';
      el.textContent="Ja, ich sage ab"; el.className="btn warn wide"; el.dataset.a="cant"; return;
    }
    if(a==="cant"){await store.update(id,{status:"open",gaveUp:me,taker:null});closeModal();toast("Abgesagt","Alle sehen jetzt, dass jemand gesucht wird.")}
    if(a==="take"){await store.update(id,{status:"wait",taker:me});closeModal();toast("Danke!","Du hast dich gemeldet. Der Chef muss noch bestätigen.")}
    if(a==="ok"&&s){const tk=s.taker;await store.update(id,{who:tk,status:"ok",taker:null,gaveUp:null});closeModal();toast("Erfolgreich",nameOf(tk)+" übernimmt den Dienst.")}
    if(a==="no"){await store.update(id,{status:"open",taker:null});closeModal();toast("Abgelehnt","Der Dienst ist wieder offen.")}
    if(a==="askdel"){el.textContent="Wirklich löschen?";el.dataset.a="del"}
    else if(a==="del"){await store.del(id);closeModal();toast("Erfolgreich","Dienst wurde gelöscht.")}
    if(a==="askrm"){el.textContent="Wirklich entfernen? (Dienste bleiben im Plan)";el.dataset.a="rm"}
    else if(a==="rm"){await store.teamDel(el.dataset.n);toast("Entfernt","Diese E-Mail hat keinen Zugriff mehr.");setTimeout(openTeam,50)}
    if(a==="copy"){
      const t=$("share-link").textContent;
      try{await navigator.clipboard.writeText(t);toast("Kopiert","Link ist in der Zwischenablage.")}
      catch{const r=document.createRange();r.selectNodeContents($("share-link"));const sel=getSelection();sel.removeAllRanges();sel.addRange(r)}
    }
  }catch(e){fail(e)}
}

$("prev").onclick=()=>{weekOffset--;showPast=false;watchWeek()};
$("next").onclick=()=>{weekOffset++;showPast=false;watchWeek()};
$("today").onclick=()=>{weekOffset=0;showPast=false;watchWeek()};
$("team-btn").onclick=openTeam;
$("search").oninput=e=>{search=e.target.value.toLowerCase();render()};
document.querySelectorAll("#viewtabs button").forEach(b=>b.onclick=()=>{view=b.dataset.view;render();window.scrollTo(0,0)});
document.addEventListener("keydown",e=>{if(e.key==="Escape"&&!modal.hidden)closeModal()});
modal.addEventListener("click",e=>{if(e.target===modal)closeModal()});
document.body.addEventListener("click",e=>{
  const b=e.target.closest("[data-a]"); if(!b)return;
  const a=b.dataset.a;
  if(a==="open")return openShift(b.dataset.id);
  if(a==="new")return openShift(null,b.dataset.date);
  if(a==="close")return closeModal();
  if(a==="focus"){focus=focus===b.dataset.n?null:b.dataset.n;return render()}
  if(a==="showpast"){showPast=true;return render()}
  // Doppeltippen verhindern: Knopf ist gesperrt, bis die Aktion fertig ist
  if(b.disabled)return;
  b.disabled=true;
  act(a,b).finally(()=>{b.disabled=false});
});

// Doppeltes Speichern verhindern (z. B. zweimal schnell auf „Speichern“ getippt)
let saving=false;
document.body.addEventListener("submit",async e=>{
  if(e.target.id!=="shift-form"&&e.target.id!=="team-form")return;
  e.preventDefault();
  if(saving)return;
  saving=true;
  try{await submitForm(e.target)}finally{saving=false}
});
async function submitForm(f){
  if(f.id==="shift-form"){
    const from=$("f-from").value, to=$("f-to").value, who=$("f-who").value, err=$("f-err");
    if(!from||!to||from===to){err.textContent="Bitte zwei verschiedene Uhrzeiten eingeben.";err.hidden=false;return}
    const id=f.dataset.id, old=id?findShift(id):null;
    const data={date:f.dataset.date,from,to,who:who||null,status:who?"ok":"open",gaveUp:null,taker:null};
    if(old&&!who&&old.status!=="ok"){data.status=old.status;data.gaveUp=old.gaveUp??null;data.taker=old.taker??null}
    try{
      if(id)await store.set(id,data); else await store.add(data);
      closeModal(); toast("Erfolgreich",id?"Dienst wurde geändert.":"Dienst wurde angelegt.");
    }catch(x){fail(x)}
  }
  if(f.id==="team-form"){
    const name=$("t-name").value.trim(), mail=$("t-mail").value.trim().toLowerCase(), soll=parseFloat($("t-soll").value)||0, err=$("t-err");
    if(!name){err.textContent="Bitte einen Namen eingeben.";err.hidden=false;return}
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)){err.textContent="Bitte eine gültige E-Mail eingeben.";err.hidden=false;return}
    if(team.has(mail)){err.textContent="Diese E-Mail ist schon eingetragen.";err.hidden=false;return}
    if(mail===me){err.textContent="Das ist deine eigene E-Mail, die hat als Chef schon Zugriff.";err.hidden=false;return}
    const used=new Set([...team.values()].map(t=>t.color));
    let color=0; while(used.has(color)&&color<COLORS-1)color++;
    try{await store.teamSet(mail,{name,soll,color});toast("Hinzugefügt",name+" kann sich jetzt registrieren.");setTimeout(openTeam,50)}
    catch(x){fail(x)}
  }
}

/* ---------- Vorschau-Modus (nur localhost) ---------- */
// Die Plandaten liegen in „Dienstplanorschau-plan.json“ – AUSSERHALB des öffentlichen Repos,
// damit keine echten Namen ins Internet kommen. Auf der echten Seite wird das nie geladen.
// Aufruf: ?demo=chef, ?demo=mitarbeiter (= erste Person aus der Datei) oder ?demo=<vorname>
const demo = {
  shifts:[],
  refresh(){
    splitLoaded(this.shifts);
    openShifts=this.shifts.filter(s=>s.status==="open"||s.status==="wait");
    myShifts=this.shifts.filter(s=>s.who===me);
    render();
  },
  async update(id,patch){const s=this.shifts.find(x=>x.id===id);if(s)Object.assign(s,patch);this.refresh()},
  async set(id,d){const i=this.shifts.findIndex(x=>x.id===id);const s={id,...d};if(i<0)this.shifts.push(s);else this.shifts[i]=s;this.refresh()},
  async del(id){this.shifts=this.shifts.filter(x=>x.id!==id);this.refresh()},
  async teamSet(mail,d){team.set(mail,d);this.refresh()},
  async teamDel(mail){team.delete(mail);this.refresh()},
  async init(){
    $("demo-badge").hidden=false;
    let plan={team:{},shifts:[]};
    try{const r=await fetch("../vorschau-plan.json",{cache:"no-store"});if(r.ok)plan=await r.json()}catch(e){console.error(e)}
    team=new Map(Object.entries(plan.team));
    // Dienste: [Datum, von, bis, wer] – wer leer = offen, noch niemand eingeteilt
    this.shifts=plan.shifts.map(([date,from,to,who],k)=>({id:"s"+k,date,from,to,who:who||null,status:who?"ok":"open",gaveUp:null,taker:null}));
    isChef=DEMO==="chef";
    const pick=DEMO.toLowerCase()+"@beispiel.de";
    me=isChef?"chef@beispiel.de":team.has(pick)?pick:[...team.keys()][0]||"";
    // Diese Woche noch leer? Dann gleich die erste Woche mit Diensten zeigen
    const first=this.shifts.map(s=>s.date).sort()[0];
    if(first&&dayNum(first)>mondayNum(0)+6)weekOffset=Math.floor((dayNum(first)-mondayNum(0))/7);
    if(!this.shifts.length)toast("Kein Plan gefunden","Die Datei vorschau-plan.json fehlt im Ordner Dienstplan.",true);
    startApp();
  }
};

if(DEMO) demo.init();
else onAuthStateChanged(auth,user=>route(user));

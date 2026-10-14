"use strict";

// ---------- settings (per device) ----------
const DEFAULTS = { maxUp: 30, ending: "0.90" };
function loadSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem("sp-settings") || "{}") }; }
  catch { return { ...DEFAULTS }; }
}
function saveSettings(s) {
  try { localStorage.setItem("sp-settings", JSON.stringify(s)); } catch {}
}
let settings = loadSettings();

// ---------- category keywords ----------
// Staples that shoppers know by heart (Known Value Items) -> high sensitivity.
const KVI = ["חלב", "שמנת", "לבן", "יוגורט", "קוטג", "גבינה לבנה", "גבינה צהובה", "חמאה", "ביצים", "ביצה",
  "לחם", "פיתות", "פיתה", "חלה", "קמח", "סוכר", "מלח", "שמן", "אורז", "פסטה", "ספגטי", "קפה", "נס קפה",
  "תה ", "מים מינרלים", "קוקה קולה", "קולה", "טונה", "חומוס", "במבה", "ביסלי", "נייר טואלט", "מגבונים", "חיתולים",
  "פתיתים", "קורנפלקס", "שוקו", "מרגרינה", "עוף", "חזה", "שניצל", "בשר טחון"];
// Items people rarely remember the price of -> low sensitivity.
const LOW = ["תבלין", "פפריקה", "כמון", "כורכום", "קינמון", "פלפל שחור", "אורגנו", "בזיליקום", "רוטב", "קטשופ",
  "מיונז", "חרדל", "סויה", "צ'ילי", "טחינה", "ריבה", "ממרח", "חטיף", "שוקולד", "סוכריות", "מסטיק", "עוגיות",
  "וופל", "קרקר", "אגוז", "שקדים", "פיסטוק", "גרעינים", "בוטנים", "שמפו", "מרכך", "סבון", "דאודורנט", "קרם",
  "משחת שיניים", "מברשת", "סוללות", "נרות", "מצית", "תמצית", "אבקת אפיה", "סוכר וניל", "שמרים", "ג'לי",
  "פודינג", "כבושים", "זיתים", "מלפפון חמוץ", "שימורי", "קונפיטורה", "דבש", "סילאן", "סירופ", "חומץ", "אטריות אורז",
  "נודלס", "קרם פטיסייר", "אבקת", "תרכיז", "משקה אנרגיה", "יין", "בירה", "וודקה", "ניקוי", "אקונומיקה", "מרכך כביסה"];
// Products that may be under government price control (פיקוח מחירים) - recommend market price, not above.
const CONTROLLED = ["חלב 3%", "חלב 1%", "חלב טרי", "שמנת חמוצה", "שמנת מתוקה", "גבינה לבנה", "חמאה", "ביצים",
  "לחם אחיד", "לחם לבן", "מלח", "קוטג"];

const hasAny = (name, list) => list.find(k => name.includes(k));

// ---------- data loading ----------
let META = null;
const shardCache = {};
const norm = code => String(code).replace(/\D/g, "").replace(/^0+/, "");

async function loadMeta() {
  if (META) return META;
  const r = await fetch("data/meta.json", { cache: "no-cache" });
  META = await r.json();
  return META;
}
async function lookup(barcode) {
  const code = norm(barcode);
  if (!code) return null;
  const shard = code.slice(-2).padStart(2, "0");
  if (!shardCache[shard]) {
    const r = await fetch(`data/p/${shard}.json`, { cache: "no-cache" });
    shardCache[shard] = r.ok ? await r.json() : {};
  }
  return shardCache[shard][code] || null;
}

// ---------- scoring ----------
const median = a => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

function roundEnding(p, ending) {
  if (ending === "none") return Math.round(p * 100) / 100;
  // cheap items: a .90 ending would distort the price too much, round to 10 agorot instead
  if (p < 5) return Math.round(p * 10) / 10;
  if (ending === "0.50") {
    const opts = [Math.floor(p) - 0.1, Math.floor(p) + 0.5, Math.floor(p) + 0.9];
    return opts.reduce((a, b) => Math.abs(b - p) < Math.abs(a - p) ? b : a);
  }
  const e = parseFloat(ending);
  const lo = Math.floor(p) - 1 + e, hi = Math.floor(p) + e;
  const best = Math.abs(hi - p) <= Math.abs(lo - p) ? hi : lo;
  return Math.round(Math.max(best, e) * 100) / 100;
}

function score(item, meta) {
  const prices = item.p.map(([, price]) => price).filter(x => x > 0);
  const med = median(prices), min = Math.min(...prices), max = Math.max(...prices);
  const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
  const sd = Math.sqrt(prices.reduce((a, b) => a + (b - mean) ** 2, 0) / prices.length);
  const cv = mean ? sd / mean : 0;

  const chainsCarrying = new Set(item.p.map(([s]) => meta.stores[s].c)).size;
  const reasons = [];

  // 1. dispersion: everyone sells at the same price -> competitive -> sensitive
  let sDisp = 50;
  if (prices.length >= 2) {
    sDisp = clamp(100 - (cv / 0.25) * 100, 0, 100);
    if (cv < 0.05) reasons.push("כמעט כל החנויות מוכרות באותו מחיר, כנראה מוצר שמתחרים עליו");
    else if (cv > 0.15) reasons.push(`פערי מחירים גדולים בין החנויות (${min.toFixed(2)}–${max.toFixed(2)} ₪), הלקוחות לא מכירים מחיר אחד`);
  }
  // 2. availability across chains
  const sAvail = clamp((chainsCarrying / meta.chains_total) * 100, 0, 100);
  if (chainsCarrying >= Math.ceil(meta.chains_total * 0.75)) reasons.push("נמכר כמעט בכל הרשתות");
  else if (chainsCarrying <= 1) reasons.push("נמכר רק ברשת אחת באזור, קשה להשוות מחיר");
  // 3. promotions at competitors
  const promoChains = (item.pr || []).length;
  const sPromo = chainsCarrying ? clamp((promoChains / chainsCarrying) * 100, 0, 100) : 0;
  if (promoChains) reasons.push(`${promoChains === 1 ? "במבצע ברשת אחת" : `במבצע ב-${promoChains} רשתות`}, מוצר שהרשתות משתמשות בו כפיתיון`);
  // 4. category
  const name = item.n || "";
  let sCat = 50;
  const kvi = hasAny(name, KVI), low = hasAny(name, LOW);
  if (kvi && !low) { sCat = 95; reasons.push(`מוצר יסוד (${kvi.trim()}), לקוחות זוכרים את המחיר`); }
  else if (low && !kvi) { sCat = 15; reasons.push(`קטגוריה שהלקוחות פחות זוכרים בה מחירים (${low.trim()})`); }
  else if (kvi && low) { sCat = 55; }

  const s = Math.round(0.25 * sDisp + 0.15 * sAvail + 0.15 * sPromo + 0.45 * sCat);
  const controlled = hasAny(name, CONTROLLED);

  let mult = 1 + (1 - s / 100) * (settings.maxUp / 100);
  if (controlled) mult = 1;
  const rec = roundEnding(med * mult, settings.ending);

  return { score: s, med, min, max, mult, rec, reasons, controlled, chainsCarrying, n: prices.length };
}

// ---------- UI ----------
const $ = id => document.getElementById(id);
const fmt = x => x.toFixed(2);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function levelOf(s) {
  if (s >= 70) return ["רגיש מאוד למחיר", "var(--high)"];
  if (s >= 40) return ["רגישות בינונית", "var(--mid)"];
  return ["רגישות נמוכה, אפשר להרוויח יותר", "var(--low)"];
}

async function show(barcode) {
  const box = $("result");
  box.classList.remove("hidden");
  box.innerHTML = `<p class="muted">מחפש ${esc(barcode)}…</p>`;
  let meta, item;
  try { [meta, item] = await Promise.all([loadMeta(), lookup(barcode)]); }
  catch (e) { box.innerHTML = `<p>שגיאה בטעינת הנתונים: ${esc(e.message)}</p>`; return; }

  if (!item) {
    box.innerHTML = `<p class="product-name">לא נמצאו נתוני שוק</p>
      <p class="muted">ברקוד ${esc(barcode)} לא מופיע ברשתות שבאזור. ייתכן שזה מותג פרטי, מוצר מקומי, או ברקוד שקל (מוצר שקיל).</p>`;
    return;
  }
  const r = score(item, meta);
  const [lvl, color] = levelOf(r.score);
  const pct = Math.round((r.mult - 1) * 100);

  const rows = item.p
    .map(([si, price]) => ({ st: meta.stores[si], price }))
    .sort((a, b) => a.price - b.price)
    .map(({ st, price }) => `<tr><td>${esc(meta.chains[st.c])}</td><td>${esc(st.n)}</td><td class="num">${fmt(price)}</td></tr>`)
    .join("");

  box.innerHTML = `
    <p class="product-name">${esc(item.n)}</p>
    <p class="muted">${esc([item.m, (item.u || "").replace(/\s*(לא ידוע|unknown)\s*$/i, "")].filter(x => x && !/^\d+(\.\d+)?$/.test(x)).concat(barcode).join(" · "))}</p>

    <div class="price-box">
      <div class="label">מחיר מומלץ למדף</div>
      <div class="price">₪${fmt(r.rec)}</div>
      <div class="sub">חציון השוק ₪${fmt(r.med)} ${pct ? `+ ${pct}%` : "(צמוד לשוק)"}</div>
    </div>

    <div class="meter">
      <div class="meter-head"><span>רגישות למחיר: <b style="color:${color}">${r.score}/100</b></span><span style="color:${color}">${lvl}</span></div>
      <div class="meter-bar"><div class="meter-fill" style="width:${r.score}%;background:${color}"></div></div>
    </div>
    <ul class="reasons">${r.reasons.map(x => `<li>${esc(x)}</li>`).join("")}</ul>
    ${r.controlled ? `<div class="warn">⚠️ ייתכן שהמוצר בפיקוח מחירים (${esc(r.controlled)}). המחיר המומלץ צמוד לשוק. אסור למכור מעל המחיר המרבי שנקבע בפיקוח.</div>` : ""}

    <div class="stats">
      <div><span class="muted">הכי זול</span><b>₪${fmt(r.min)}</b></div>
      <div><span class="muted">חציון</span><b>₪${fmt(r.med)}</b></div>
      <div><span class="muted">הכי יקר</span><b>₪${fmt(r.max)}</b></div>
    </div>
    <table><thead><tr><th>רשת</th><th>סניף</th><th>מחיר</th></tr></thead><tbody>${rows}</tbody></table>`;
  box.scrollIntoView({ behavior: "smooth", block: "start" });
}

// ---------- scanner ----------
// Native BarcodeDetector (Android Chrome) when it supports EAN, otherwise ZXing-C++ compiled to WASM.
const FORMATS = ["ean_13", "ean_8", "upc_a", "upc_e", "code_128"];
const video = $("video"), cam = $("cam"), frameEl = $("frame");
const canvas = document.createElement("canvas");
const ctx = canvas.getContext("2d", { willReadFrequently: true });
let detector = null, stream = null, track = null, paused = false, busy = false, lastCode = "", lastAt = 0;
let cameras = [], camIndex = -1;

async function getDetector() {
  if (detector) return detector;
  if ("BarcodeDetector" in window) {
    try {
      const sup = await window.BarcodeDetector.getSupportedFormats();
      if (sup.includes("ean_13")) return (detector = new window.BarcodeDetector({ formats: FORMATS.filter(f => sup.includes(f)) }));
    } catch {}
  }
  return (detector = new window.BarcodeDetectionAPI.BarcodeDetector({ formats: FORMATS }));
}

// EAN/UPC check digit, so a misread never reaches the price lookup
function validCode(code) {
  if (!/^\d+$/.test(code)) return false;
  if (![8, 12, 13].includes(code.length)) return code.length >= 6;
  const d = code.split("").map(Number), check = d.pop();
  const sum = d.reverse().reduce((s, x, i) => s + x * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

function overlay(msg, btnText) {
  $("cam-msg").textContent = msg || "";
  $("cam-action").textContent = btnText || "📷 הפעל מצלמה";
  $("cam-overlay").classList.toggle("hidden", !btnText);
}

function pickBackCamera(list) {
  // multi-lens phones: avoid ultra-wide / macro lenses that can't focus on a barcode
  const back = list.filter(d => /back|rear|environment|אחורית/i.test(d.label));
  const pool = back.length ? back : list;
  const main = pool.find(d => !/ultra|wide|macro|tele|depth/i.test(d.label));
  return list.indexOf(main || pool[0]);
}

async function startCamera(deviceId) {
  stopCamera();
  overlay("", null);
  const source = deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: "environment" } };
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { ...source, width: { ideal: 1920 }, height: { ideal: 1080 } },
    });
  } catch (e) {
    const denied = e && (e.name === "NotAllowedError" || e.name === "SecurityError");
    overlay(denied ? "אין הרשאה למצלמה. אשר גישה למצלמה בהגדרות הדפדפן ונסה שוב." : `לא הצלחתי לפתוח מצלמה (${e.name || e}).`, "📷 נסה שוב");
    return;
  }
  video.srcObject = stream;
  track = stream.getVideoTracks()[0];
  try { await video.play(); } catch {}

  // continuous autofocus where the browser allows it
  try {
    const caps = track.getCapabilities ? track.getCapabilities() : {};
    if (caps.focusMode && caps.focusMode.includes("continuous")) await track.applyConstraints({ advanced: [{ focusMode: "continuous" }] });
    $("torch").classList.toggle("hidden", !caps.torch);
  } catch {}

  // after permission, device labels are known: offer switching lenses
  try {
    cameras = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === "videoinput");
    $("switch-cam").classList.toggle("hidden", cameras.length < 2);
    const cur = track.getSettings().deviceId;
    camIndex = cameras.findIndex(d => d.deviceId === cur);
    if (!deviceId && cameras.length > 2) {
      const best = pickBackCamera(cameras);
      if (best >= 0 && cameras[best].deviceId !== cur) return startCamera(cameras[best].deviceId);
    }
  } catch {}

  resume();
}

function stopCamera() {
  if (stream) stream.getTracks().forEach(t => t.stop());
  stream = null; track = null;
  $("torch").classList.remove("on");
}

function resume() {
  paused = false;
  cam.classList.remove("paused");
  frameEl.classList.remove("hit");
  overlay("", null);
  $("hint").textContent = "שים את הברקוד בתוך המסגרת, לרוחב";
  requestAnimationFrame(loop);
}

// Map the on-screen frame to video pixels (video uses object-fit: cover)
function frameCrop() {
  const vw = video.videoWidth, vh = video.videoHeight;
  const cw = cam.clientWidth, ch = cam.clientHeight;
  const scale = Math.max(cw / vw, ch / vh);
  const offX = (vw * scale - cw) / 2, offY = (vh * scale - ch) / 2;
  const f = frameEl.getBoundingClientRect(), c = cam.getBoundingClientRect();
  // margin around the frame so a barcode slightly outside still reads
  const mx = f.width * 0.08, my = f.height * 0.35;
  let x = (f.left - c.left - mx + offX) / scale, y = (f.top - c.top - my + offY) / scale;
  let w = (f.width + 2 * mx) / scale, h = (f.height + 2 * my) / scale;
  x = Math.max(0, x); y = Math.max(0, y); w = Math.min(vw - x, w); h = Math.min(vh - y, h);
  return { x, y, w, h };
}

let lastTick = 0;
async function loop(ts) {
  if (paused || !stream) return;
  requestAnimationFrame(loop);
  if (busy || ts - lastTick < 90 || video.readyState < 2 || !video.videoWidth) return;
  lastTick = ts;
  busy = true;
  try {
    const { x, y, w, h } = frameCrop();
    const s = Math.min(1, 1280 / w); // cap work per frame
    canvas.width = Math.round(w * s); canvas.height = Math.round(h * s);
    ctx.drawImage(video, x, y, w, h, 0, 0, canvas.width, canvas.height);
    const det = await getDetector();
    const found = await det.detect(canvas);
    const hit = found.map(b => String(b.rawValue).trim()).find(validCode);
    if (hit && !paused) onScan(hit);
  } catch (e) {
    console.warn(e);
  } finally {
    busy = false;
  }
}

let audioCtx = null;
function beep() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.frequency.value = 1500; g.gain.value = 0.15;
    o.connect(g); g.connect(audioCtx.destination);
    o.start(); o.stop(audioCtx.currentTime + 0.09);
  } catch {}
}

function onScan(code) {
  const now = Date.now();
  if (code === lastCode && now - lastAt < 2500) return;
  lastCode = code; lastAt = now;
  paused = true;
  cam.classList.add("paused");
  frameEl.classList.add("hit");
  if (navigator.vibrate) navigator.vibrate(80);
  beep();
  $("hint").textContent = `נסרק: ${code}`;
  $("barcode-input").value = code;
  show(code);
  setTimeout(() => overlay("", "📷 סרוק מוצר נוסף"), 600);
}

$("cam-action").addEventListener("click", () => {
  beep(); // a user gesture unlocks audio on iOS
  if (stream && paused) {
    resume();
    $("scan-card").scrollIntoView({ behavior: "smooth", block: "start" });
  } else {
    startCamera();
  }
});
$("torch").addEventListener("click", async () => {
  if (!track) return;
  const on = !$("torch").classList.contains("on");
  try { await track.applyConstraints({ advanced: [{ torch: on }] }); $("torch").classList.toggle("on", on); } catch {}
});
$("switch-cam").addEventListener("click", () => {
  if (cameras.length < 2) return;
  camIndex = (camIndex + 1) % cameras.length;
  startCamera(cameras[camIndex].deviceId);
});
document.addEventListener("visibilitychange", async () => {
  if (document.hidden) { stopCamera(); return; }
  if (stream) return;
  const keep = paused;
  await startCamera(camIndex >= 0 && cameras[camIndex] ? cameras[camIndex].deviceId : undefined);
  if (keep && stream) { paused = true; cam.classList.add("paused"); overlay("", "📷 סרוק מוצר נוסף"); }
});

// ---------- init ----------
$("manual").addEventListener("submit", e => {
  e.preventDefault();
  const v = $("barcode-input").value.trim();
  if (v) {
    paused = true; cam.classList.add("paused");
    overlay("", "📷 סרוק מוצר נוסף");
    show(v);
  }
});
if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
  overlay("הדפדפן לא תומך במצלמה. אפשר להקליד ברקוד ידנית.", "📷 נסה שוב");
} else {
  startCamera();
}
// warm up the WASM decoder so the first scan is fast
getDetector().then(d => d.detect(Object.assign(document.createElement("canvas"), { width: 4, height: 4 }))).catch(() => {});

$("maxup").value = settings.maxUp;
$("maxup-val").textContent = settings.maxUp;
$("maxup").addEventListener("input", e => {
  settings.maxUp = +e.target.value; $("maxup-val").textContent = settings.maxUp; saveSettings(settings);
  const v = $("barcode-input").value.trim(); if (v && !$("result").classList.contains("hidden")) show(v);
});
$("ending").value = settings.ending;
$("ending").addEventListener("change", e => {
  settings.ending = e.target.value; saveSettings(settings);
  const v = $("barcode-input").value.trim(); if (v && !$("result").classList.contains("hidden")) show(v);
});
const fromHash = decodeURIComponent(location.hash.slice(1)).replace(/\D/g, "");
if (fromHash) { $("barcode-input").value = fromHash; show(fromHash); }
loadMeta().then(m => {
  $("updated").textContent = `${m.stores.length} סניפים · עודכן ${m.updated}`;
}).catch(() => { $("updated").textContent = "אין עדיין נתונים"; });

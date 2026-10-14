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
let scanner = null;
async function startScan() {
  const btn = $("scan-btn");
  if (scanner) { await stopScan(); return; }
  scanner = new Html5Qrcode("reader", {
    formatsToSupport: [
      Html5QrcodeSupportedFormats.EAN_13, Html5QrcodeSupportedFormats.EAN_8,
      Html5QrcodeSupportedFormats.UPC_A, Html5QrcodeSupportedFormats.UPC_E,
      Html5QrcodeSupportedFormats.CODE_128,
    ],
    experimentalFeatures: { useBarCodeDetectorIfSupported: true },
    verbose: false,
  });
  btn.textContent = "✕ עצור סריקה";
  try {
    await scanner.start(
      { facingMode: "environment" },
      { fps: 12, qrbox: (w, h) => ({ width: Math.min(w * 0.85, 360), height: Math.min(h * 0.4, 160) }) },
      async text => {
        if (navigator.vibrate) navigator.vibrate(80);
        await stopScan();
        $("barcode-input").value = text;
        show(text);
      },
      () => {}
    );
  } catch (e) {
    await stopScan();
    $("result").classList.remove("hidden");
    $("result").innerHTML = `<p>לא הצלחתי לפתוח את המצלמה: ${esc(e.message || e)}</p><p class="muted">צריך לאשר גישה למצלמה בדפדפן. אפשר גם להקליד את הברקוד ידנית.</p>`;
  }
}
async function stopScan() {
  if (scanner) {
    try { await scanner.stop(); } catch {}
    try { scanner.clear(); } catch {}
    scanner = null;
  }
  $("scan-btn").textContent = "📷 סרוק ברקוד";
}

// ---------- init ----------
$("scan-btn").addEventListener("click", startScan);
$("manual").addEventListener("submit", e => {
  e.preventDefault();
  const v = $("barcode-input").value.trim();
  if (v) { stopScan(); show(v); }
});
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

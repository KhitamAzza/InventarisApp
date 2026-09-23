/* ════════════════════════════════════════════════════════════
progress.js — Beranda summary: today's progress + last maintenance
Relies on: core.js (window.db, todayISO), inventory.js (window.ALL_ITEMS),
           maintenance.js (writes maintenance/{date})

ONE listener, ONE document:
  query maintenance ordered by date desc, limit 1
  → today's doc if inspections started today, otherwise the last day
    maintenance was done. That single doc feeds both cards, for every role.

  progress          = items in that doc (only if it is today's) that still
                      exist / total items in ALL_ITEMS
  last maintenance  = that doc's date + who + how many items

Operators never read history: this is the only maintenance read they make.
Full history (one doc per day) is for an admin-only screen, fetched on demand.

The latest doc is also published as window.MAINT_LATEST so the inspection
modal can show "sudah diperiksa hari ini" without extra reads.
════════════════════════════════════════════════════════════ */
import { collection, query, orderBy, limit, onSnapshot } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const $ = (id) => document.getElementById(id);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];

window.MAINT_LATEST = null; // null = not loaded yet; { date: null, items: {} } = no maintenance ever

function formatDay(iso) {
    if (iso === todayISO()) return "Hari ini";
    const y = new Date();
    y.setDate(y.getDate() - 1);
    const p = (n) => String(n).padStart(2, "0");
    if (iso === `${y.getFullYear()}-${p(y.getMonth() + 1)}-${p(y.getDate())}`) return "Kemarin";
    const [Y, M, D] = iso.split("-").map(Number);
    return `${D} ${MONTHS[M - 1]} ${Y}`;
}

function render() {
    const m = window.MAINT_LATEST;
    if (!m) return; // wait for the first snapshot

    /* progress card */
    const all = window.ALL_ITEMS || [];
    const total = all.length;
    let done = 0;
    const counts = { aman: 0, bermasalah: 0, missing: 0 };
    if (m.date === todayISO()) {
        const ids = new Set(all.map((i) => i.id));
        // Progress = items covered today, whatever the result. Whether one
        // of them still needs fixing is tracked separately, on the
        // Inventaris Bermasalah tab — not by holding back this bar.
        for (const id in m.items) {
    if (!ids.has(id)) continue;
    const st = m.items[id].status;
    // Resolved bermasalah/missing → status quo, not counted here either
    if ((st === "bermasalah" || st === "missing") && !window.OPEN_PROBLEMS?.has(id)) continue;
    done++;
    if (counts[st] !== undefined) counts[st]++;
}
    }
    const pct = total ? Math.min(100, (done / total) * 100) : 0;
    const valueEl = $("dash-progress-value");
    const fillEl = $("dash-progress-fill");
    if (valueEl) valueEl.textContent = `${done} / ${total}`;
    if (fillEl) fillEl.style.width = pct + "%";

    const bd = $("dash-progress-breakdown");
    if (bd) {
        if (done === 0) {
            bd.hidden = true;
        } else {
            bd.hidden = false;
            bd.innerHTML = [
                ["aman", "Aman"], ["bermasalah", "Bermasalah"], ["missing", "Missing"]
            ].map(([key, label]) =>
                `<span><span class="dot ${key}"></span>${counts[key]} ${label}</span>`
            ).join("");
        }
    }

    /* last maintenance card */
    const lastVal = $("dash-last-value");
    const lastSub = $("dash-last-sub");
    if (lastVal) lastVal.textContent = m.date ? formatDay(m.date) : "Belum ada";
    if (lastSub) {
        const n = Object.keys(m.items).length;
        lastSub.textContent = m.date
            ? [m.lastBy ? `oleh ${m.lastBy}` : "", `${n} item diperiksa`].filter(Boolean).join(" · ")
            : "";
    }
}

onSnapshot(
    query(collection(db, "maintenance"), orderBy("date", "desc"), limit(1)),
    (snap) => {
        const d = snap.docs[0];
        const data = d ? d.data() : null;
        window.MAINT_LATEST = data
            ? { date: data.date || d.id, items: data.items || {}, lastBy: data.lastBy || null }
            : { date: null, items: {}, lastBy: null };
        render();
    },
    (err) => console.error("progress(maintenance):", err)
);

/* Local-only refresh (no reads): re-render when the item count changes
   (inventory.js loaded / item added or deleted) or when midnight passes
   with the app still open, which flips "Hari ini" → "Kemarin" and resets
   the progress bar. */
let lastKey = "";
setInterval(() => {
    const key = (window.ALL_ITEMS || []).length + "|" + todayISO();
    if (key !== lastKey) { lastKey = key; render(); }
}, 1000);
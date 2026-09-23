/* ════════════════════════════════════════════════════════════
laporan.js — "Laporan" screen: a filterable, WhatsApp-exportable
summary of every open (unresolved) Bermasalah/Missing report.

Relies on: core.js (window.db, window.CATEGORIES, window.ALL_ITEMS),
login.js (roles — pengawas reaches this screen too, view-only by design:
there's no admin action anywhere on this screen, same as its data source).

Own live listener on problems/{resolved:false} (same query problems.js
uses for Inventaris Bermasalah) rather than reusing that screen's local
state — every screen in this app owns its own Firestore listener, so
this just follows the existing pattern; it's a second listener on a
small, already-indexed query, not a second read of anything large.

shortId isn't stored on the problems doc itself, so it's looked up live
from window.ALL_ITEMS by itemId — always fresh, no schema change needed.
════════════════════════════════════════════════════════════ */
import { collection, query, where, orderBy, onSnapshot } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => window.escapeHtml(s);

const STATUS_LABEL = { bermasalah: "Bermasalah", missing: "Missing" };
const MONTHS_ID = ["Januari","Februari","Maret","April","Mei","Juni","Juli","Agustus","September","Oktober","November","Desember"];

function timeAgo(ts) {
    const d = ts && typeof ts.toDate === "function" ? ts.toDate() : null;
    if (!d) return "";
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getDate()}/${d.getMonth() + 1}/${String(d.getFullYear()).slice(-2)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function todayLong() {
    const d = new Date();
    return `${d.getDate()} ${MONTHS_ID[d.getMonth()]} ${d.getFullYear()}`;
}

function shortIdFor(itemId) {
    const it = (window.ALL_ITEMS || []).find((i) => i.id === itemId);
    return (it && it.shortId) || itemId;
}

function categoryLabel(catId) {
    return window.CATEGORIES?.[catId]?.label || catId || "";
}

/* ════════════════════════════════════════════════════════════
   DATA — live, unresolved reports
   ════════════════════════════════════════════════════════════ */
let reports = [];

onSnapshot(
    query(collection(db, "problems"), where("resolved", "==", false), orderBy("reportedAt", "desc")),
    (snap) => {
        reports = snap.docs.map((d) => d.data());
        render();
    },
    (err) => console.error("laporan(list):", err)
);

// window.ALL_ITEMS can (re)populate after this listener already fired
// (shortId lookups above), and CATEGORIES/labels likewise — re-render
// whenever either refreshes so the cards catch up without a refetch.
let lastItemsLen = -1;
setInterval(() => {
    const n = (window.ALL_ITEMS || []).length;
    if (n !== lastItemsLen) { lastItemsLen = n; render(); }
}, 1500);

/* ════════════════════════════════════════════════════════════
   FILTERS
   ════════════════════════════════════════════════════════════ */
const catFilter = $("lap-cat-filter");
const statusTabs = document.querySelectorAll("[data-lap-status]");
let activeStatus = "";

statusTabs.forEach((b) => {
    b.addEventListener("click", () => {
        activeStatus = b.dataset.lapStatus;
        statusTabs.forEach((x) => x.classList.toggle("active", x === b));
        render();
    });
});
catFilter?.addEventListener("change", render);

function filteredReports() {
    const cat = catFilter?.value || "";
    return reports.filter((r) => {
        if (cat && r.category !== cat) return false;
        if (activeStatus && r.status !== activeStatus) return false;
        return true;
    });
}

/* ════════════════════════════════════════════════════════════
   RENDER
   ════════════════════════════════════════════════════════════ */
function render() {
    const emptyEl = $("lap-empty");
    const listEl = $("lap-list");
    const waBtn = $("lap-wa-btn");
    if (!emptyEl || !listEl) return;

    const rows = filteredReports();

    if (rows.length === 0) {
        emptyEl.hidden = false;
        listEl.hidden = true;
        listEl.innerHTML = "";
        if (waBtn) waBtn.hidden = true;
        return;
    }

    emptyEl.hidden = true;
    listEl.hidden = false;
    if (waBtn) waBtn.hidden = false;

    listEl.innerHTML = rows.map((r) => `
        <div class="problem-card">
            <div class="problem-card-top">
                <div>
                    <div class="insp-id" style="color:var(--gold); font-weight:700;">${esc(shortIdFor(r.itemId))}</div>
                    <code style="font-size:11px; color:var(--muted);">${esc(r.itemId)}</code>
                    <div class="problem-card-name" style="margin-top:2px;">${esc(r.name || "Tanpa Nama")}</div>
                    <div class="muted">${esc([categoryLabel(r.category), r.lokasi].filter(Boolean).join(" · "))}</div>
                </div>
                <span class="status-badge ${r.status}">${esc(STATUS_LABEL[r.status] || r.status)}</span>
            </div>
            ${r.note ? `<div class="problem-card-note">${esc(r.note)}</div>` : ""}
            <div class="problem-card-meta">Dilaporkan${r.reportedBy ? ` oleh ${esc(r.reportedBy)}` : ""}${r.reportedAt ? ` · ${timeAgo(r.reportedAt)}` : ""}</div>
        </div>`).join("");
}

/* ════════════════════════════════════════════════════════════
   WHATSAPP EXPORT
   Groups the *currently filtered* list by status — so filtering to
   one category (or one status) before sending narrows the report too.
   A group with nothing in it is left out entirely rather than shown
   empty.
   ════════════════════════════════════════════════════════════ */
function buildWaText() {
    const rows = filteredReports();
    const bermasalah = rows.filter((r) => r.status === "bermasalah");
    const missing = rows.filter((r) => r.status === "missing");

    const lines = [`Laporan inventaris lab DKV (${todayLong()})`, ""];

    const line = (r) => `${shortIdFor(r.itemId)} - ${r.name || "Tanpa Nama"} - ${r.note || "-"}`;

    if (bermasalah.length) {
        lines.push("Alat bermasalah", "");
        bermasalah.forEach((r, i) => lines.push(`${i + 1}. ${line(r)}`));
        lines.push("");
    }
    if (missing.length) {
        lines.push("Alat hilang", "");
        missing.forEach((r, i) => lines.push(`${i + 1}. ${line(r)}`));
        lines.push("");
    }

    return lines.join("\n").trim();
}

$("lap-wa-btn")?.addEventListener("click", () => {
    const text = buildWaText();
    if (!text) return;
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank");
});
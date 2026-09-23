/* ════════════════════════════════════════════════════════════
problems.js — "Inventaris Bermasalah" screen
Relies on: core.js (window.db, window.CURRENT_USER), login.js (roles)

Shows every item with an open report (problems/{itemId}, resolved === false).
One live listener, filtered server-side — admin and operator both read the
same small result set, never the resolved history.

Admin: each card has "Tandai Selesai" → opens a modal asking how it was
       fixed, then sets resolved: true (the card then drops off the list
       on its own, since the query excludes resolved reports).
Operator: view-only — the resolve button is left out of the markup entirely.
════════════════════════════════════════════════════════════ */
import { collection, doc, query, where, orderBy, onSnapshot, updateDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => window.escapeHtml(s);

const STATUS_LABEL = { bermasalah: "Bermasalah", missing: "Missing" };

function isAdmin() {
    return window.CURRENT_USER?.role === "admin";
}

function timeAgo(ts) {
    const d = ts && typeof ts.toDate === "function" ? ts.toDate() : null;
    if (!d) return "";
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getDate()}/${d.getMonth() + 1}/${String(d.getFullYear()).slice(-2)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ════════════════════════════════════════════════════════════
   LIST
   ════════════════════════════════════════════════════════════ */
let reports = [];

// Open (unresolved) report ids, published for maintenance.js — a
// bermasalah/missing item stays here (and locked from re-inspection)
// until an admin resolves it below.
window.OPEN_PROBLEMS = new Set();

function renderList() {
    const emptyEl = $("problem-empty");
    const listEl = $("problem-list");
    if (!emptyEl || !listEl) return;

    if (reports.length === 0) {
        emptyEl.hidden = false;
        listEl.hidden = true;
        listEl.innerHTML = "";
        return;
    }

    emptyEl.hidden = true;
    listEl.hidden = false;
    const admin = isAdmin();

    listEl.innerHTML = reports.map((r) => `
        <div class="problem-card" data-id="${esc(r.itemId)}">
            <div class="problem-card-top">
                <div>
                    <div class="insp-id">${esc(r.itemId)}</div>
                    <div class="problem-card-name">${esc(r.name || "Tanpa Nama")}</div>
                    <div class="muted">${esc([r.category, r.lokasi].filter(Boolean).join(" · "))}</div>
                </div>
                <span class="status-badge ${r.status}">${esc(STATUS_LABEL[r.status] || r.status)}</span>
            </div>
            ${r.note ? `<div class="problem-card-note">${esc(r.note)}</div>` : ""}
            <div class="problem-card-meta">Dilaporkan${r.reportedBy ? ` oleh ${esc(r.reportedBy)}` : ""}${r.reportedAt ? ` · ${timeAgo(r.reportedAt)}` : ""}</div>
            ${admin ? `<button class="btn problem-card-resolve" data-resolve="${esc(r.itemId)}">Tandai Selesai</button>` : ""}
        </div>`).join("");
}

onSnapshot(
    query(collection(db, "problems"), where("resolved", "==", false), orderBy("reportedAt", "desc")),
    (snap) => {
        reports = snap.docs.map((d) => d.data());
        window.OPEN_PROBLEMS = new Set(reports.map((r) => r.itemId));
        renderList();
    },
    (err) => console.error("problems(list):", err)
);

// Role can change after this list already rendered (a listener may fire
// before login finishes) — re-render on login/restoreSession/logout so
// the resolve button appears/disappears without waiting for a refetch.
(window.ROLE_LISTENERS = window.ROLE_LISTENERS || []).push(renderList);

$("problem-list").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-resolve]");
    if (btn) openResolve(btn.dataset.resolve);
});

/* ════════════════════════════════════════════════════════════
   RESOLVE MODAL (admin only)
   ════════════════════════════════════════════════════════════ */
const modal = $("resolve-modal");
const backdrop = $("resolve-backdrop");
const noteEl = $("resolve-note");
const submitBtn = $("resolve-submit");

let current = null; // the report being resolved
let saving = false;

function openResolve(itemId) {
    if (!isAdmin()) return;
    const r = reports.find((x) => x.itemId === itemId);
    if (!r) return;

    current = r;
    saving = false;
    noteEl.value = "";

    $("resolve-id").textContent = r.itemId;
    $("resolve-name").textContent = r.name || "Tanpa Nama";
    $("resolve-meta").textContent = [r.category, r.lokasi].filter(Boolean).join(" · ");
    $("resolve-report").textContent =
        `Laporan: ${STATUS_LABEL[r.status] || r.status}` +
        (r.reportedBy ? ` · ${r.reportedBy}` : "") +
        (r.note ? `\nCatatan: ${r.note}` : "");

    refreshSubmit();
    modal.classList.add("show");
    backdrop.classList.add("show");
}

function closeResolve() {
    if (saving) return;
    if (noteEl.value.trim() && !confirm("Buang catatan penyelesaian yang belum disimpan?")) return;
    modal.classList.remove("show");
    backdrop.classList.remove("show");
    current = null;
}

function refreshSubmit() {
    submitBtn.disabled = saving || !noteEl.value.trim();
    submitBtn.textContent = saving ? "Menyimpan…" : "Tandai Selesai";
}

noteEl.addEventListener("input", refreshSubmit);
$("resolve-close").addEventListener("click", closeResolve);

submitBtn.addEventListener("click", async () => {
    if (!current || saving || !noteEl.value.trim()) return;
    const user = window.CURRENT_USER || {};

    const itemId = current.itemId;
    saving = true;
    refreshSubmit();
    try {
        await updateDoc(doc(db, "problems", itemId), {
            resolved: true,
            resolvedBy: user.name ?? null,
            resolvedAt: serverTimestamp(),
            resolutionNote: noteEl.value.trim()
        });
        saving = false;
        noteEl.value = ""; // so closeResolve's discard-check doesn't fire
        modal.classList.remove("show");
        backdrop.classList.remove("show");
        current = null;
        toast(`Laporan ${itemId} ditandai selesai`, "ok");
    } catch (e) {
        console.error(e);
        saving = false;
        refreshSubmit();
        toast("Gagal menyimpan: " + e.message, "bad");
    }
});
/* ════════════════════════════════════════════════════════════
maintenance.js — Inspection flow ("Mulai Maintenance")
Relies on: core.js, login.js, inventory.js (window.ALL_ITEMS)

Flow:
  scan QR / manual search → modal (ID + nama) → Aman / Bermasalah / Missing
  → Simpan → modal closes → scanner ready again.

Data model — ONE document per maintenance day:
  maintenance/{YYYY-MM-DD}: {
    date, lastBy, lastAt,
    items: {
      [itemId]: { name, category, lokasi,
                  status: "aman" | "bermasalah" | "missing",
                  note,            // wajib jika bermasalah, opsional jika missing
                  by, byId, at }
    }
  }
Saving = 1 write (merged into today's doc). Inspecting the same item twice
in a day just overwrites its entry. Reads are ~0: items come from the live
window.ALL_ITEMS cache, and "already inspected today?" comes from
window.MAINT_LATEST (kept live by progress.js).

A "bermasalah"/"missing" result also (over)writes one doc in a second
collection, keyed by item so there's only ever one open report per item:
  problems/{itemId}: {
    itemId, name, category, lokasi, status, note,
    reportedBy, reportedById, reportedAt,
    resolved: false, resolvedBy, resolvedAt, resolutionNote
  }
problems.js reads/resolves this collection (admin-only resolve action);
resolving it does not touch the maintenance/{date} doc above.

While a bermasalah/missing report is open (problems.js's live
window.OPEN_PROBLEMS has the item id), that item is LOCKED here — no
one can re-inspect it, operator or admin, until an admin resolves the
report from Inventaris Bermasalah. Once resolved it unlocks and the
normal "sudah didata hari ini" gate applies again.
════════════════════════════════════════════════════════════ */
import { doc, getDoc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => window.escapeHtml(s);
const toast = (m, k) => window.toast(m, k);

const STATUS_LABEL = { aman: "Aman", bermasalah: "Bermasalah", missing: "Missing" };
const itemName = (it) => it.fields?.merk || it.fields?.name || "Tanpa Nama";

/* ════════════════════════════════════════════════════════════
   0. TABS — Scan QR / Manual, and Manual's own
   Satu per satu / Massal sub-tabs.
   The camera only ever runs while the Scan QR tab is the one
   actually on screen: switching to Manual stops it (same as
   leaving the whole screen used to), switching back restarts it.
   startScanner/stopScanner are defined below (§1) — safe to
   reference here since they're hoisted function declarations.
   ════════════════════════════════════════════════════════════ */
const mtTabs = document.querySelectorAll("[data-mt-tab]");
const mtPanels = document.querySelectorAll("[data-mt-panel]");

function isScanTabActive() {
    const p = document.querySelector('[data-mt-panel="scan"]');
    return !p || p.classList.contains("active");
}

function activateMtTab(name) {
    mtTabs.forEach((b) => b.classList.toggle("active", b.dataset.mtTab === name));
    mtPanels.forEach((p) => p.classList.toggle("active", p.dataset.mtPanel === name));
    if (name === "scan") {
        if (screen.classList.contains("active")) startScanner();
    } else {
        stopScanner();
    }
}
mtTabs.forEach((b) => b.addEventListener("click", () => activateMtTab(b.dataset.mtTab)));

const mtSubtabs = document.querySelectorAll("[data-mt-subtab]");
const mtSubpanels = document.querySelectorAll("[data-mt-subpanel]");
function activateMtSubtab(name) {
    mtSubtabs.forEach((b) => b.classList.toggle("active", b.dataset.mtSubtab === name));
    mtSubpanels.forEach((p) => p.classList.toggle("active", p.dataset.mtSubpanel === name));
}
mtSubtabs.forEach((b) => b.addEventListener("click", () => activateMtSubtab(b.dataset.mtSubtab)));

/* ════════════════════════════════════════════════════════════
   1. SCANNER
   ════════════════════════════════════════════════════════════ */
const screen = $("screen-maintenance");
let scanner = null;
let startPromise = null;
let scanLocked = false;                 // true while a modal is open / item is loading
let lastScan = { code: null, at: 0 };   // stops the same QR re-opening right after close

function startScanner() {
    if (scanner) return;
    const inst = new window.Html5Qrcode("mt-qr-reader");
    scanner = inst;
    startPromise = inst.start(
        { facingMode: "environment" },
        { fps: 10, qrbox: { width: 250, height: 250 } },
        onScanSuccess,
        () => {} // ignore per-frame scan failures
    ).catch((err) => {
        console.error("Camera error:", err);
        scanner = null;
        $("mt-qr-reader").innerHTML =
            '<div class="muted" style="padding:20px; text-align:center;">' +
            'Gagal mengakses kamera. Pastikan izin diberikan.<br>' +
            '<button class="btn" id="mt-cam-retry" style="margin-top:12px;">Coba lagi</button></div>';
        $("mt-cam-retry").addEventListener("click", startScanner);
    });
}

async function stopScanner() {
    const inst = scanner;
    if (!inst) return;
    scanner = null;
    try {
        await startPromise;   // don't stop() a camera that is still starting
        await inst.stop();
        inst.clear();
    } catch { /* already stopped */ }
}

function onScanSuccess(text) {
    const code = String(text || "").trim();
    if (!code || scanLocked) return;
    if (code === lastScan.code && Date.now() - lastScan.at < 2500) return;
    openItem(code, "root");
}

function releaseScan(code) {
    scanLocked = false;
    lastScan = { code, at: Date.now() };
}

// Camera only runs while this screen is the active one.
if (screen) {
    new MutationObserver(() => {
        if (screen.classList.contains("active")) {
            if (!modal.classList.contains("show")) scanLocked = false;
            if (isScanTabActive()) startScanner();
        } else {
            stopScanner();
            clearManual();
            activateMtTab("scan"); // reset to Scan QR for the next visit
        }
    }).observe(screen, { attributes: true, attributeFilter: ["class"] });
}

/* ════════════════════════════════════════════════════════════
   2. MANUAL ENTRY (ID or name)
   ════════════════════════════════════════════════════════════ */
const manualInput = $("mt-manual-input");
const manualResults = $("mt-manual-results");

function searchItems(q) {
    q = q.trim().toLowerCase();
    if (!q) return [];
    const all = window.ALL_ITEMS || [];
    const exact = all.find((i) => String(i.id).toLowerCase() === q);
    if (exact) return [exact];
    return all.filter((it) => {
        const hay = [it.id, it.category, it.lokasi, ...Object.values(it.fields || {})].join(" ").toLowerCase();
        return hay.includes(q);
    }).slice(0, 8);
}

// Sort order for the manual list: not inspected today → aman → bermasalah/missing.
// Ties keep whatever order searchItems returned them in.
const SORT_RANK = { none: 0, aman: 1, bermasalah: 2, missing: 2 };

function badgeHtml(status, itemId) {
    if (!status) return '<span class="status-badge none">Belum diperiksa</span>';
    const isOpen = (status === "bermasalah" || status === "missing") && window.OPEN_PROBLEMS?.has(itemId);
    const lock = isOpen
        ? '<svg class="lock-ico" viewBox="0 0 24 24" stroke="currentColor" fill="none"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>'
        : "";
    return `<span class="status-badge ${status}">${lock}${esc(STATUS_LABEL[status] || status)}</span>`;
}

function renderManualResults() {
    const q = manualInput.value.trim();
    if (!q) { manualResults.innerHTML = ""; return; }
    const matches = searchItems(q);
    if (matches.length === 0) {
        manualResults.innerHTML = '<div class="muted" style="text-align:center; padding:14px;">Tidak ada item yang cocok.</div>';
        return;
    }
    const ranked = matches
        .map((it) => ({ it, status: getPrior(it.id)?.status || null }))
        .sort((a, b) => SORT_RANK[a.status || "none"] - SORT_RANK[b.status || "none"]);

    manualResults.innerHTML = ranked.map(({ it, status }) => `
        <div class="link-item${status ? " done" : ""}" data-id="${esc(it.id)}">
            <div class="link-item-info">
                <span class="link-item-id">${esc(it.id)}</span>
                <span class="link-item-name">${esc(itemName(it))} <span class="muted">(${esc(it.category)})</span></span>
            </div>
            ${badgeHtml(status, it.id)}
        </div>`).join("");
}

function clearManual() {
    manualInput.value = "";
    manualResults.innerHTML = "";
}

async function submitManual() {
    const q = manualInput.value.trim();
    if (!q) return;
    const matches = searchItems(q);
    if (matches.length === 1) return openItem(matches[0].id, "root");
    if (matches.length > 1) return toast("Pilih salah satu item dari daftar.", "ok");
    // Nothing in the cached list (or it hasn't loaded yet) → try it as an exact doc ID.
    openItem(q, "root");
}

manualInput.addEventListener("input", renderManualResults);
manualInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); submitManual(); }
});
$("mt-manual-btn").addEventListener("click", submitManual);
manualResults.addEventListener("click", (e) => {
    const row = e.target.closest(".link-item[data-id]");
    if (row) openItem(row.dataset.id, "root");
});

/* ════════════════════════════════════════════════════════════
   2b. BULK MARK ("Periksa Massal") — mark a whole group (same
   kategori + lokasi) Aman in one write, for identical bulk items
   (chairs, tables…) where scanning every unit isn't worth it.

   Only items that are genuinely untouched today are eligible —
   already-inspected-today items and locked (open bermasalah/missing
   report) items are found and excluded automatically, never
   silently overwritten. One setDoc merge covers the whole group
   regardless of how many items match: 50 chairs is still 1 write,
   the same as inspecting a single item.
   ════════════════════════════════════════════════════════════ */
const bulkCatSelect = $("mt-bulk-cat-select");
const bulkLokasiSelect = $("mt-bulk-lokasi-select");
const bulkSummary = $("mt-bulk-summary");
const bulkBtn = $("mt-bulk-btn");

let bulkEligible = []; // items[] currently eligible to mark Aman

function computeBulkMatches() {
    const cat = bulkCatSelect.value;
    const lokasi = bulkLokasiSelect.value;
    if (!cat) return [];
    // Belt-and-suspenders: the dropdown (populated in core.js) only ever
    // lists furniture-type categories, but double-check here too, since
    // CPU/Monitor/Elektronik need a careful one-by-one look, not a
    // one-tap bulk "Aman".
    if (!window.canBulkMark(cat)) return [];
    return (window.ALL_ITEMS || []).filter((it) => {
        if (it.category !== cat) return false;
        if (lokasi && it.lokasi !== lokasi) return false;
        return true;
    });
}

function renderBulkSummary() {
    const matches = computeBulkMatches();

    if (!bulkCatSelect.value) {
        bulkSummary.hidden = true;
        bulkBtn.disabled = true;
        bulkEligible = [];
        return;
    }

    const locked = [];
    const done = [];
    const eligible = [];
    matches.forEach((it) => {
        if (window.OPEN_PROBLEMS?.has(it.id)) locked.push(it);
        else if (getPrior(it.id)) done.push(it);
        else eligible.push(it);
    });
    bulkEligible = eligible;

    bulkSummary.hidden = false;
    const parts = [`Ditemukan <span class="n">${matches.length}</span> item.`];
    parts.push(`<span class="eligible">${eligible.length} siap</span> ditandai Aman.`);
    if (done.length) parts.push(`${done.length} sudah diperiksa hari ini (dilewati).`);
    if (locked.length) parts.push(`${locked.length} sedang terkunci — laporan belum diselesaikan (dilewati).`);
    if (matches.length === 0) parts.push("Coba kategori/lokasi lain.");
    bulkSummary.innerHTML = parts.join(" ");

    bulkBtn.disabled = eligible.length === 0;
    bulkBtn.textContent = eligible.length
        ? `Tandai Semua (${eligible.length}) sebagai Aman`
        : "Tandai Semua sebagai Aman";
}

bulkCatSelect.addEventListener("change", renderBulkSummary);
bulkLokasiSelect.addEventListener("change", renderBulkSummary);

bulkBtn.addEventListener("click", async () => {
    if (bulkEligible.length === 0) return;
    const catLabel = window.CATEGORIES?.[bulkCatSelect.value]?.label || bulkCatSelect.value;
    const lokasiLabel = bulkLokasiSelect.value || "semua lokasi";
    if (!confirm(`Tandai ${bulkEligible.length} item (${catLabel} · ${lokasiLabel}) sebagai Aman?`)) return;

    const user = window.CURRENT_USER || {};
    const date = todayISO();
    const items = {};
    bulkEligible.forEach((it) => {
        items[it.id] = {
            name: itemName(it),
            category: it.category ?? "",
            lokasi: it.lokasi ?? "",
            status: "aman",
            note: "",
            by: user.name ?? null,
            byId: user.id ?? null,
            at: serverTimestamp()
        };
    });

    bulkBtn.disabled = true;
    const originalLabel = bulkBtn.textContent;
    bulkBtn.textContent = "Menyimpan…";
    try {
        await setDoc(doc(db, "maintenance", date), {
            date,
            lastBy: user.name ?? null,
            lastAt: serverTimestamp(),
            items
        }, { merge: true });
        toast(`${bulkEligible.length} item ditandai Aman`, "ok");
        renderBulkSummary(); // MAINT_LATEST updates live via progress.js's listener; this just re-syncs the local summary
    } catch (e) {
        console.error(e);
        toast("Gagal menandai massal: " + e.message, "bad");
        bulkBtn.disabled = false;
        bulkBtn.textContent = originalLabel;
    }
});

// Re-check the current group whenever today's maintenance doc or the
// open-problems set changes (e.g. someone else inspects an item in this
// same group, or an admin resolves a report, while this screen is open).
// Both are live globals already kept fresh elsewhere — this just re-reads
// them locally, no extra Firestore calls.
let lastBulkKey = "";
setInterval(() => {
    if (!bulkCatSelect.value) return;
    const key = `${(window.ALL_ITEMS || []).length}|${window.MAINT_LATEST?.date}|${Object.keys(window.MAINT_LATEST?.items || {}).length}|${window.OPEN_PROBLEMS?.size ?? 0}`;
    if (key !== lastBulkKey) { lastBulkKey = key; renderBulkSummary(); }
}, 1500);

document.addEventListener("visibilitychange", () => {
    if (!document.hidden && bulkCatSelect.value) renderBulkSummary();
});

/* ════════════════════════════════════════════════════════════
   3. INSPECTION MODAL
   ════════════════════════════════════════════════════════════ */
const modal = $("insp-modal");
const backdrop = $("insp-backdrop");

const state = {
    item: null,       // item currently shown
    prior: null,      // today's existing inspection for it (if any)
    status: null,     // "aman" | "bermasalah" | "missing"
    note: "",
    rootId: null,     // the item that was originally scanned / searched
    stack: [],        // ids we navigated away from (via "Tergabung dengan…")
    drafts: {},       // unsaved choices per item id, so going back doesn't lose them
    gate: false,      // true = showing "sudah didata hari ini" warning instead of the form
    locked: false,     // true = showing the "menunggu diselesaikan admin" lock instead of gate/form
    confirmed: {},    // item ids where the user already pressed "Ganti" this session
    saving: false
};

// Cache first: ALL_ITEMS is already kept live by inventory.js, so a scan
// costs 0 reads. Only hit Firestore if the cache hasn't loaded yet.
async function fetchItem(id) {
    const all = window.ALL_ITEMS || [];
    const cached = all.find((i) => i.id === id);
    if (cached) return cached;
    if (all.length > 0) return null; // cache is loaded and this ID isn't in it
    const snap = await getDoc(doc(db, "items", id));
    return snap.exists() ? { ...snap.data(), id: snap.id } : null;
}

// Today's result for this item, from the live summary (no read).
function getPrior(id) {
    const m = window.MAINT_LATEST;
    return m && m.date === todayISO() ? (m.items[id] || null) : null;
}

/* mode: "root" = fresh scan/manual · "push" = open a linked item · "pop" = back */
async function openItem(id, mode = "root") {
    id = String(id || "").trim();
    if (!id) return;

    if (mode === "root") {
        if (scanLocked) return;
        scanLocked = true;
    }

    try {
        const item = await fetchItem(id);
        const prior = item ? getPrior(item.id) : null;
        if (!item) {
            toast(`Item "${id}" tidak ditemukan di database.`, "bad");
            if (mode === "root") releaseScan(id);
            return;
        }

        if (mode === "root") { state.stack = []; state.drafts = {}; state.confirmed = {}; state.rootId = id; }
        if (mode === "push" && state.item) { stashDraft(); state.stack.push(state.item.id); }
        if (mode === "pop") state.stack.pop();

        const draft = state.drafts[item.id] || {};
        state.item = item;
        state.prior = prior;
        state.status = draft.status || null;
        state.note = draft.note || "";
        // A bermasalah/missing report still open (unresolved) locks the item outright.
        // Otherwise, already inspected today and not yet confirmed → warn first.
        const isOpenProblem = (prior?.status === "bermasalah" || prior?.status === "missing")
            && window.OPEN_PROBLEMS?.has(item.id);
        state.locked = !!isOpenProblem;
        state.gate = !!prior && !state.locked && !state.confirmed[item.id];

        render();
        modal.classList.add("show");
        backdrop.classList.add("show");
    } catch (e) {
        console.error(e);
        toast("Gagal memuat item: " + e.message, "bad");
        if (mode === "root") releaseScan(id);
    }
}

function stashDraft() {
    if (!state.item) return;
    state.drafts[state.item.id] = { status: state.status, note: state.note };
}

function timeOf(ts) {
    const d = ts && typeof ts.toDate === "function" ? ts.toDate() : null;
    if (!d) return "";
    const p = (n) => String(n).padStart(2, "0");
    return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

function render() {
    const it = state.item;

    $("insp-id").textContent = it.id;
    $("insp-name").textContent = itemName(it);
    $("insp-meta").textContent = [it.category, it.lokasi].filter(Boolean).join(" · ");

    // back link (only when we got here via a linked item)
    const backBtn = $("insp-back");
    backBtn.hidden = state.gate || state.locked || state.stack.length === 0;
    if (state.stack.length) $("insp-back-id").textContent = state.stack[state.stack.length - 1];

    // locked (open bermasalah/missing report) vs. "sudah didata hari ini" vs. the normal form
    $("insp-locked").hidden = !state.locked;
    $("insp-gate").hidden = state.locked || !state.gate;
    $("insp-form").hidden = state.locked || state.gate;
    if (state.locked) {
        const p = state.prior;
        const t = timeOf(p.at);
        const lines = [`Dilaporkan: ${STATUS_LABEL[p.status] || p.status}` + (p.by ? ` · ${p.by}` : "") + (t ? ` · ${t}` : "")];
        if (p.note) lines.push(`Catatan: ${p.note}`);
        $("insp-locked-prev").textContent = lines.join("\n");
    }
    if (state.gate) {
        const p = state.prior;
        const t = timeOf(p.at);
        const lines = [`Hasil sebelumnya: ${STATUS_LABEL[p.status] || p.status}` + (p.by ? ` · ${p.by}` : "") + (t ? ` · ${t}` : "")];
        if (p.note) lines.push(`Catatan: ${p.note}`);
        $("insp-gate-prev").textContent = lines.join("\n");
    }

    // linked devices chip
    const n = (it.linkedIds || []).length;
    $("insp-linked").hidden = n === 0;
    $("insp-linked-text").textContent = `Tergabung dengan ${n} perangkat`;
    $("insp-linked-list").hidden = true;
    $("insp-linked-list").innerHTML = "";

    // already inspected today?
    const prev = $("insp-prev");
    if (state.prior) {
        const who = state.prior.by ? ` oleh ${state.prior.by}` : "";
        prev.textContent = `Menimpa hasil sebelumnya: ${STATUS_LABEL[state.prior.status] || state.prior.status}${who}.`;
        prev.hidden = false;
    } else {
        prev.hidden = true;
    }

    renderChoice();
    $("insp-note").value = state.note;
}

function renderChoice() {
    document.querySelectorAll(".insp-status-btn").forEach((b) => {
        b.classList.toggle("selected", b.dataset.status === state.status);
    });

    const wrap = $("insp-note-wrap");
    const lbl = $("insp-note-lbl");
    const note = $("insp-note");
    if (state.status === "bermasalah") {
        wrap.hidden = false;
        lbl.innerHTML = 'Alasan / masalah <span class="req">*</span>';
        note.placeholder = "Tulis apa yang bermasalah (wajib diisi)…";
    } else if (state.status === "missing") {
        wrap.hidden = false;
        lbl.textContent = "Catatan (opsional)";
        note.placeholder = "Terakhir terlihat di mana, dll…";
    } else {
        wrap.hidden = true;
    }
    refreshSave();
}

function canSave() {
    if (!state.status || state.saving) return false;
    if (state.status === "bermasalah" && !state.note.trim()) return false;
    return true;
}

function refreshSave() {
    const btn = $("insp-save");
    btn.disabled = !canSave();
    btn.textContent = state.saving ? "Menyimpan…" : "Simpan";
}

/* status buttons */
document.querySelectorAll(".insp-status-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
        if (state.saving) return;
        state.status = btn.dataset.status;
        if (state.status === "aman") state.note = ""; // an "aman" item carries no note
        if (state.status === "aman") $("insp-note").value = "";
        renderChoice();
        if (state.status !== "aman") $("insp-note").focus();
    });
});

$("insp-note").addEventListener("input", (e) => {
    state.note = e.target.value;
    refreshSave();
});

/* linked items */
$("insp-linked").addEventListener("click", async () => {
    const ids = state.item?.linkedIds || [];
    if (ids.length === 0) return;
    if (ids.length === 1) return openItem(ids[0], "push");

    // more than one partner (not expected by current link rules, but data allows it)
    const box = $("insp-linked-list");
    if (!box.hidden) { box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML = '<div class="muted" style="text-align:center; padding:10px;">Memuat…</div>';
    const items = (await Promise.all(ids.map((i) => fetchItem(i).catch(() => null)))).filter(Boolean);
    box.innerHTML = items.map((l) => `
        <div class="link-item" data-id="${esc(l.id)}">
            <div class="link-item-info">
                <span class="link-item-id">${esc(l.id)}</span>
                <span class="link-item-name">${esc(itemName(l))} <span class="muted">(${esc(l.category)})</span></span>
            </div>
            <span class="muted">Buka</span>
        </div>`).join("");
});
$("insp-linked-list").addEventListener("click", (e) => {
    const row = e.target.closest(".link-item[data-id]");
    if (row) openItem(row.dataset.id, "push");
});

$("insp-back").addEventListener("click", () => {
    if (state.saving || state.stack.length === 0) return;
    stashDraft();
    openItem(state.stack[state.stack.length - 1], "pop");
});

/* "sudah didata hari ini" warning */
$("insp-gate-replace").addEventListener("click", () => {
    if (!state.item) return;
    state.confirmed[state.item.id] = true;
    state.gate = false;
    render(); // shows the normal form; Simpan will overwrite today's entry
});
$("insp-gate-cancel").addEventListener("click", () => {
    if (state.stack.length) openItem(state.stack[state.stack.length - 1], "pop"); // linked item → back to previous
    else hideModal();                                                              // scanned/searched item → abort
});

/* locked (open bermasalah/missing report) — same exit as "Batalkan" above */
$("insp-locked-close").addEventListener("click", () => {
    if (state.stack.length) openItem(state.stack[state.stack.length - 1], "pop");
    else hideModal();
});

/* close */
function hideModal() {
    modal.classList.remove("show");
    backdrop.classList.remove("show");
    const root = state.rootId;
    state.item = null; state.prior = null; state.status = null; state.note = "";
    state.stack = []; state.drafts = {}; state.confirmed = {}; state.gate = false; state.locked = false; state.rootId = null;
    releaseScan(root);
}

function closeModal() {
    if (state.saving) return;
    if (state.note.trim() && !confirm("Buang isian yang belum disimpan?")) return;
    hideModal();
}
$("insp-close").addEventListener("click", closeModal);
// backdrop tap is intentionally NOT bound: a stray tap shouldn't wipe a typed reason.

/* save */
$("insp-save").addEventListener("click", async () => {
    if (!canSave()) return;
    const it = state.item;
    const user = window.CURRENT_USER || {};
    const date = todayISO();
    const status = state.status;

    state.saving = true;
    refreshSave();
    try {
        const writes = [
            setDoc(doc(db, "maintenance", date), {
                date,
                lastBy: user.name ?? null,
                lastAt: serverTimestamp(),
                items: {
                    [it.id]: {
                        name: itemName(it),
                        category: it.category ?? "",
                        lokasi: it.lokasi ?? "",
                        status,
                        note: state.note.trim(),
                        by: user.name ?? null,
                        byId: user.id ?? null,
                        at: serverTimestamp()
                    }
                }
            }, { merge: true }) // merge → adds/overwrites only this item's entry
        ];

        // Bermasalah/missing also (re)opens this item's single problem report.
        // A fresh report always resets resolved → false, even over an old
        // resolved one — problems.js only ever shows resolved === false.
        if (status === "bermasalah" || status === "missing") {
            writes.push(setDoc(doc(db, "problems", it.id), {
                itemId: it.id,
                name: itemName(it),
                category: it.category ?? "",
                lokasi: it.lokasi ?? "",
                status,
                note: state.note.trim(),
                reportedBy: user.name ?? null,
                reportedById: user.id ?? null,
                reportedAt: serverTimestamp(),
                resolved: false,
                resolvedBy: null,
                resolvedAt: null,
                resolutionNote: null
            }));
        }

        await Promise.all(writes);

        state.saving = false;
        state.note = ""; // so hideModal's discard-check doesn't fire
        hideModal();
        clearManual();
        toast(`Tersimpan: ${it.id} → ${STATUS_LABEL[status]}`, "ok");
    } catch (e) {
        console.error(e);
        state.saving = false;
        refreshSave();
        toast("Gagal menyimpan: " + e.message, "bad");
    }
});
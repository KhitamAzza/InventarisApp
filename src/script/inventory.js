/* ════════════════════════════════════════════════════════════
inventory.js — Add new items, dynamic schema, and live list
Relies on: core.js (must be loaded first)
════════════════════════════════════════════════════════════ */
import { runTransaction, writeBatch, doc, getDoc, setDoc, deleteDoc, collection, onSnapshot }
from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

/* ── Generate Sequential ID ───────────────────────────────── */
async function generateItemId() {
    const ref = doc(db, "meta", "counters");
    const next = await runTransaction(db, async (tx) => {
        const snap = await tx.get(ref);
        const last = snap.exists() ? (snap.data().lastInvNumber || 0) : 0;
        const n = last + 1;
        tx.set(ref, { lastInvNumber: n }, { merge: true });
        return n;
    });
    return `INV.KD${String(next).padStart(4, "0")}.${yymmdd()}`;
}

/* Reserve N sequential INV ids in ONE transaction — used by "Tambah
   Massal" instead of calling generateItemId() in a loop, so creating
   50 items costs 1 counter transaction, not 50. Each item document
   itself is still a separate write (Firestore has no way around that —
   50 physical units really do need 50 distinct documents), but they go
   out together as one atomic batch below. */
async function reserveItemIdBlock(n) {
    const ref = doc(db, "meta", "counters");
    const start = await runTransaction(db, async (tx) => {
        const snap = await tx.get(ref);
        const last = snap.exists() ? (snap.data().lastInvNumber || 0) : 0;
        tx.set(ref, { lastInvNumber: last + n }, { merge: true });
        return last;
    });
    const dateStr = yymmdd();
    const ids = [];
    for (let i = 1; i <= n; i++) ids.push(`INV.KD${String(start + i).padStart(4, "0")}.${dateStr}`);
    return ids;
}

/* ── Short Index (PC-01, MON-03, KURSI-14, …) ─────────────────
   A second, human-friendly identifier alongside the INV.xxxx doc ID.
   INV.xxxx stays the Firestore key and what the QR code encodes —
   shortId is just what people say and read off the printed label.
   One counter per prefix (shortIdCounters/{prefix}.next), so PC-01,
   PC-02… and MON-01, MON-02… count up independently. ─────────────── */
async function generateShortId(prefix) {
    const ref = doc(db, "shortIdCounters", prefix);
    const next = await runTransaction(db, async (tx) => {
        const snap = await tx.get(ref);
        const last = snap.exists() ? (snap.data().next || 0) : 0;
        const n = last + 1;
        tx.set(ref, { next: n }, { merge: true });
        return n;
    });
    return `${prefix}-${String(next).padStart(2, "0")}`;
}

// Same idea as reserveItemIdBlock, for the shortId side: PC-08, PC-09…
// reserved in one transaction on that prefix's counter.
async function reserveShortIdBlock(prefix, n) {
    const ref = doc(db, "shortIdCounters", prefix);
    const start = await runTransaction(db, async (tx) => {
        const snap = await tx.get(ref);
        const last = snap.exists() ? (snap.data().next || 0) : 0;
        tx.set(ref, { next: last + n }, { merge: true });
        return last;
    });
    const ids = [];
    for (let i = 1; i <= n; i++) ids.push(`${prefix}-${String(start + i).padStart(2, "0")}`);
    return ids;
}

// A starting guess only — always editable in the form (or at retrofit
// time for older items), since one category (Furnitur) covers several
// different kinds of item that shouldn't share one prefix.
const PREFIX_SUGGESTIONS = { pc: "PC", monitor: "MON" };
function suggestPrefix(catId, label) {
    const known = PREFIX_SUGGESTIONS[String(catId || "").toLowerCase()];
    if (known) return known;
    const base = String(label || catId || "ITEM").toUpperCase().replace(/[^A-Z0-9]/g, "");
    return base.slice(0, 5) || "ITEM";
}

// Firestore read, so debounce it — fires as the user edits the prefix
// field, not on every keystroke.
let shortIdPreviewTimer = null;
async function updateShortIdPreview(prefix) {
    const el = $("shortid-preview");
    if (!el) return;
    if (!prefix) { el.textContent = ""; return; }
    clearTimeout(shortIdPreviewTimer);
    shortIdPreviewTimer = setTimeout(async () => {
        try {
            const snap = await getDoc(doc(db, "shortIdCounters", prefix));
            const last = snap.exists() ? (snap.data().next || 0) : 0;
            el.textContent = `Index ≈ ${prefix}-${String(last + 1).padStart(2, "0")}`;
        } catch { el.textContent = ""; }
    }, 400);
}

window.updateIdPreview = async function() {
    try {
        const snap = await getDoc(doc(db, "meta", "counters"));
        const last = snap.exists() ? (snap.data().lastInvNumber || 0) : 0;
        $("id-preview").textContent = `ID berikutnya ≈ INV.KD${String(last + 1).padStart(4, "0")}.${yymmdd()}`;
    } catch {}
}

/* ── Dynamic Form (Per Category) ──────────────────────────── */
// Shared by the single-add and bulk-add forms — renders one category's
// schema fields into whichever container is passed in.
function renderDynamicFields(catId, box) {
    box.innerHTML = "";
    if (!catId || !CATEGORIES[catId]) return;
    CATEGORIES[catId].schema.forEach((f) => {
        const wrap = document.createElement("label");
        wrap.className = "field";
        wrap.innerHTML = `<span class="lbl">${escapeHtml(f.label)}${f.required ? ' <span class="req">*</span>' : ""}</span> 
                          <input data-key="${escapeHtml(f.key)}" type="${f.type || "text"}" ${f.required ? "required" : ""} ${f.type === "number" ? 'step="any"' : ""} />`;
        box.appendChild(wrap);
    });
}

let lastSuggestedPrefix = ""; // so switching category doesn't stomp a prefix the user already edited

$("cat-select").addEventListener("change", () => {
    const id = $("cat-select").value;
    const prefixInput = $("shortid-prefix");
    if (prefixInput) {
        const suggestion = id && CATEGORIES[id] ? suggestPrefix(id, CATEGORIES[id].label) : "";
        // only overwrite if the field is empty or still holds the previous auto-suggestion
        if (!prefixInput.value.trim() || prefixInput.value.trim() === lastSuggestedPrefix) {
            prefixInput.value = suggestion;
        }
        lastSuggestedPrefix = suggestion;
        updateShortIdPreview(prefixInput.value.trim().toUpperCase());
    }
    renderDynamicFields(id, $("dynamic-fields"));
});

$("shortid-prefix")?.addEventListener("input", (e) => {
    updateShortIdPreview(e.target.value.trim().toUpperCase());
});

/* ── Tambah Massal ─────────────────────────────────────────── */
let lastSuggestedBulkPrefix = "";

document.querySelectorAll("[data-add-mode]").forEach((tab) => {
    tab.addEventListener("click", () => {
        const mode = tab.dataset.addMode;
        document.querySelectorAll("[data-add-mode]").forEach((t) => t.classList.toggle("active", t === tab));
        $("add-mode-single").hidden = mode !== "single";
        $("add-mode-bulk").hidden = mode !== "bulk";
    });
});

$("bulk-cat-select")?.addEventListener("change", () => {
    const id = $("bulk-cat-select").value;
    const prefixInput = $("bulk-shortid-prefix");
    if (prefixInput) {
        const suggestion = id && CATEGORIES[id] ? suggestPrefix(id, CATEGORIES[id].label) : "";
        if (!prefixInput.value.trim() || prefixInput.value.trim() === lastSuggestedBulkPrefix) {
            prefixInput.value = suggestion;
        }
        lastSuggestedBulkPrefix = suggestion;
    }
    updateBulkPreview();
    renderDynamicFields(id, $("bulk-dynamic-fields"));
});

function updateBulkPreview() {
    const el = $("bulk-shortid-preview");
    if (!el) return;
    const prefix = ($("bulk-shortid-prefix")?.value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    const qty = parseInt($("bulk-qty")?.value, 10);
    if (!prefix || !qty || qty < 1) { el.textContent = ""; return; }
    clearTimeout(shortIdPreviewTimer);
    shortIdPreviewTimer = setTimeout(async () => {
        try {
            const snap = await getDoc(doc(db, "shortIdCounters", prefix));
            const last = snap.exists() ? (snap.data().next || 0) : 0;
            const first = `${prefix}-${String(last + 1).padStart(2, "0")}`;
            const lastId = `${prefix}-${String(last + qty).padStart(2, "0")}`;
            el.textContent = `Akan dibuat: ${first} … ${lastId} (${qty} unit)`;
        } catch { el.textContent = ""; }
    }, 400);
}
$("bulk-shortid-prefix")?.addEventListener("input", updateBulkPreview);
$("bulk-qty")?.addEventListener("input", updateBulkPreview);

$("bulk-add-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const catId = $("bulk-cat-select").value;
    const lokasi = $("bulk-lokasi-select").value;
    const prefix = ($("bulk-shortid-prefix").value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    const qty = parseInt($("bulk-qty").value, 10);

    if (!catId || !CATEGORIES[catId]) return toast("Pilih kategori dulu", "bad");
    if (!lokasi) return toast("Pilih lokasi dulu", "bad");
    if (!prefix) return toast("Isi prefix index dulu (mis. KURSI, MEJA)", "bad");
    if (!qty || qty < 1) return toast("Isi jumlah unit dulu", "bad");
    if (qty > 200) return toast("Maksimal 200 unit sekali input — bagi jadi beberapa batch", "bad");

    const inputs = $("bulk-dynamic-fields").querySelectorAll("input[data-key]");
    const fields = {};
    for (const inp of inputs) {
        const v = inp.value.trim();
        if (inp.required && !v) return toast(`"${inp.dataset.key}" wajib diisi`, "bad");
        if (v) fields[inp.dataset.key] = inp.type === "number" ? Number(v) : v;
    }

    const btn = $("bulk-submit-btn");
    btn.disabled = true;
    const originalLabel = btn.textContent;
    btn.textContent = `Membuat ${qty} unit…`;
    try {
        // 2 counter transactions total (not one per unit), then every
        // item document goes out together as one atomic batch.
        const [itemIds, shortIds] = await Promise.all([
            reserveItemIdBlock(qty),
            reserveShortIdBlock(prefix, qty)
        ]);

        const batch = writeBatch(db);
        const addedAt = todayISO();
        const created = itemIds.map((itemId, i) => {
            const shortId = shortIds[i];
            batch.set(doc(db, "items", itemId), { category: catId, lokasi, addedAt, fields, shortId });
            return { id: itemId, shortId };
        });
        await batch.commit();

        $("bulk-add-form").reset();
        $("bulk-dynamic-fields").innerHTML = "";
        $("bulk-shortid-preview").textContent = "";
        lastSuggestedBulkPrefix = "";
        window.openBulkSuccessModal(created);
    } catch (err) {
        console.error(err);
        toast("Gagal membuat unit: " + err.message, "bad");
    } finally {
        btn.disabled = false;
        btn.textContent = originalLabel;
    }
});

/* ── Add Item Submission ──────────────────────────────────── */
$("add-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const catId  = $("cat-select").value;
    const lokasi = $("lokasi-select").value;
    
    if (!catId || !CATEGORIES[catId]) return toast("Pilih kategori dulu", "bad");
    if (!lokasi) return toast("Pilih lokasi dulu", "bad");

    const prefix = ($("shortid-prefix")?.value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!prefix) return toast("Isi prefix index dulu (mis. PC, MON, KURSI)", "bad");

    const inputs = $("dynamic-fields").querySelectorAll("input[data-key]");
    const fields = {};
    for (const inp of inputs) {
        const v = inp.value.trim();
        if (inp.required && !v) return toast(`"${inp.dataset.key}" wajib diisi`, "bad");
        if (v) fields[inp.dataset.key] = inp.type === "number" ? Number(v) : v;
    }

    $("submit-btn").disabled = true;
    try {
        const [itemId, shortId] = await Promise.all([generateItemId(), generateShortId(prefix)]);
        await setDoc(doc(db, "items", itemId), {
            category: catId, lokasi, addedAt: todayISO(), fields, shortId
        });
        $("add-form").reset();
        $("dynamic-fields").innerHTML = "";
        $("id-preview").textContent = "";
        if ($("shortid-preview")) $("shortid-preview").textContent = "";
        lastSuggestedPrefix = "";
        updateIdPreview();
        window.openAddSuccessModal(itemId, catId, shortId);
    } catch (err) {
        console.error(err);
        toast("Gagal menyimpan: " + err.message, "bad");
    } finally {
        $("submit-btn").disabled = false;
    }
});

/* ── Live Items List ──────────────────────────────────────── */
window.subscribeItems = function() {
    onSnapshot(collection(db, "items"), (snap) => {
        window.ALL_ITEMS = []; // 👈 Add 'window.' here
        snap.forEach((d) => window.ALL_ITEMS.push({ id: d.id, ...d.data() })); // 👈 Add 'window.' here
        window.ALL_ITEMS.sort((a, b) => // 👈 Add 'window.' here
            (b.addedAt || "").localeCompare(a.addedAt || "") || b.id.localeCompare(a.id)
        );
        renderItems();
    }, (err) => {
        console.error(err);
        toast("Gagal memuat daftar: " + err.message, "bad");
    });
};

["filter-text", "filter-lokasi"].forEach((id) => {
    const el = $(id);
    if(el) el.addEventListener("input", renderItems);
});

// Role can be determined after the item list has already rendered (the
// items snapshot may resolve before login finishes) — re-render on
// login/restoreSession/logout so the edit/delete/link buttons show or
// hide without waiting for the next Firestore update. Same pattern as
// problems.js's renderList registration.
(window.ROLE_LISTENERS = window.ROLE_LISTENERS || []).push(renderItems);

function applyFilters() {
    const q  = $("filter-text").value.trim().toLowerCase();
    const lk = $("filter-lokasi").value.trim();
    return ALL_ITEMS.filter((it) => {
        if (lk && (it.lokasi || "") !== lk) return false;
        if (!q) return true;
        const hay = [
            it.id, it.category, it.lokasi, it.addedAt,
            ...Object.entries(it.fields || {}).flat()
        ].join(" ").toLowerCase();
        return hay.includes(q);
    });
}

function renderItems() {
    const rows = applyFilters();
    const tbody = $("items-tbody");
    const cards = $("items-cards");
    if (!tbody || !cards) return;

    // pengawas gets in via the allow-list in core.js, but this screen was
    // built admin-only — every action here (link, generate index, delete)
    // is destructive/editing, so it's view-only for anyone but admin.
    const canEdit = window.CURRENT_USER?.role === "admin";

    if (rows.length === 0) {
        const emptyMsg = ALL_ITEMS.length === 0 ? "Belum ada item." : "Tidak ada yang cocok.";
        tbody.innerHTML = `<tr><td colspan="6" class="muted" style="padding:16px">${emptyMsg}</td></tr>`;
        cards.innerHTML = `<div class="muted" style="padding:16px">${emptyMsg}</div>`;
        return;
    }

    /* Desktop Table */
    tbody.innerHTML = rows.map((it) => {
        const specs = Object.entries(it.fields || {})
            .map(([k, v]) => `<div><span class="k">${escapeHtml(k)}:</span> ${escapeHtml(v)}</div>`)
            .join("");
            
        // 1. Smart Link Button Logic — hidden entirely for categories that
        // can never be linked (Furnitur, Elektronik, ...)
        const hasLinks = it.linkedIds && it.linkedIds.length > 0;
        const btnColor = hasLinks ? 'var(--gold)' : 'var(--muted)'; // Gold if linked, Gray if not

        const linkBtn = (!canEdit || !window.canCategoryLink(it.category)) ? "" : `<button class="btn smart-link-btn" data-link-id="${escapeHtml(it.id)}" title="Kelola Link" style="margin-right:8px; padding:6px 10px; color: ${btnColor}; border-color: ${hasLinks ? 'var(--gold-dim)' : 'var(--border)'};">
            <svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
        </button>`;

        // Legacy items (added before shortId existed) get a one-off "buat
        // index" action instead of the shortId badge.
        const genBtn = !canEdit ? "" : `<button class="btn" data-gen-short="${escapeHtml(it.id)}" data-cat="${escapeHtml(it.category)}" title="Buat index pendek" style="margin-right:8px; padding:6px 10px;">#</button>`;

        return `<tr>
            <td>
                ${it.shortId ? `<span style="color:var(--gold); font-weight:700;">${escapeHtml(it.shortId)}</span><br>` : ""}
                <code style="font-size:11px; color:var(--muted);">${escapeHtml(it.id)}</code>
            </td>
            <td>${escapeHtml(it.category)}</td>
            <td>${escapeHtml(it.lokasi)}</td>
            <td>${escapeHtml(it.addedAt || "")}</td>
            <td class="specs">${specs}</td>
            <td>${it.shortId ? "" : genBtn}${linkBtn}${canEdit ? `<button class="btn danger" data-del="${escapeHtml(it.id)}" title="Hapus">✕</button>` : ""}</td>
        </tr>`;
    }).join("");

    /* Mobile Cards */
    cards.innerHTML = rows.map((it) => {
        const specs = Object.entries(it.fields || {})
            .map(([k, v]) => `<div><span class="k">${escapeHtml(k)}:</span> ${escapeHtml(v)}</div>`)
            .join("");
            
        // 1. Smart Link Button Logic — hidden entirely for categories that
        // can never be linked (Furnitur, Elektronik, ...)
        const hasLinks = it.linkedIds && it.linkedIds.length > 0;
        const btnColor = hasLinks ? 'var(--gold)' : 'var(--muted)';

        const linkBtn = (!canEdit || !window.canCategoryLink(it.category)) ? "" : `<button class="btn smart-link-btn" data-link-id="${escapeHtml(it.id)}" title="Kelola Link" style="margin-right:8px; padding:6px 10px; color: ${btnColor}; border-color: ${hasLinks ? 'var(--gold-dim)' : 'var(--border)'};">
            <svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
        </button>`;

        const genBtn = !canEdit ? "" : `<button class="btn" data-gen-short="${escapeHtml(it.id)}" data-cat="${escapeHtml(it.category)}" title="Buat index pendek" style="margin-right:8px; padding:6px 10px;">#</button>`;

        return `<div class="item-card">
            <div class="item-head">
                <div>
                    <div class="item-id">${it.shortId ? escapeHtml(it.shortId) : escapeHtml(it.id)}</div>
                    ${it.shortId ? `<div class="muted" style="font-size:11px; font-family:monospace;">${escapeHtml(it.id)}</div>` : ""}
                    <div class="item-meta">${escapeHtml(it.category)} · ${escapeHtml(it.lokasi)} · ${escapeHtml(it.addedAt || "")}</div>
                </div>
                <div>${it.shortId ? "" : genBtn}${linkBtn}${canEdit ? `<button class="btn danger" data-del="${escapeHtml(it.id)}" title="Hapus">✕</button>` : ""}</div>
            </div>
            <div class="item-specs">${specs}</div>
        </div>`;
    }).join("");
}

/* ── Smart Link Button Listener ────────────────────────────── */
document.body.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-link-id]");
    if (btn) {
        e.stopPropagation();
        window.openSimpleLinkModal(btn.dataset.linkId);
    }
});
/* ── "Buat Index" Listener (retrofit shortId onto a legacy item) ─── */
document.body.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-gen-short]");
    if (!btn) return;
    const id = btn.dataset.genShort;
    const catId = btn.dataset.cat;
    const catLabel = window.CATEGORIES?.[catId]?.label || catId;
    const suggestion = suggestPrefix(catId, catLabel);
    const raw = prompt(`Prefix index untuk ${id} (kategori: ${catLabel})`, suggestion);
    if (raw === null) return; // cancelled
    const prefix = raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!prefix) return toast("Prefix tidak boleh kosong", "bad");

    btn.disabled = true;
    try {
        const shortId = await generateShortId(prefix);
        await setDoc(doc(db, "items", id), { shortId }, { merge: true });
        toast(`Index dibuat: ${shortId}`);
    } catch (err) {
        console.error(err);
        toast("Gagal membuat index: " + err.message, "bad");
        btn.disabled = false;
    }
});

/* ── Delete Item Listener ─────────────────────────────────── */
document.body.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-del]");
    if (!btn) return;
    const id = btn.dataset.del;
    if (!confirm(`Hapus ${id}?`)) return;
    try {
        await deleteDoc(doc(db, "items", id));
        toast(`Terhapus: ${id}`);
    } catch (err) {
        toast("Gagal hapus: " + err.message, "bad");
    }
});
/* ── Link Button Listener ─────────────────────────────────── */
document.body.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-link]");
    if (btn) {
        e.stopPropagation(); // Prevent row click if any
        window.openLinkModal(btn.dataset.link);
    }
});

/* ════════════════════════════════════════════════════════════
ADD-SUCCESS MODAL — shown right after saving a new item, with a
shortcut into the print screen (script/qr-print.js) for that item.
════════════════════════════════════════════════════════════ */
const addSuccessModal = $("add-success-modal");
const addSuccessBackdrop = $("add-success-backdrop");
let addSuccessItem = null; // { id, category } of the just-added item

window.openAddSuccessModal = function(itemId, category, shortId) {
    addSuccessItem = { id: itemId, category };
    $("add-success-id").textContent = itemId;
    $("add-success-shortid").textContent = shortId || "";
    addSuccessModal.classList.add("show");
    addSuccessBackdrop.classList.add("show");
};

function closeAddSuccessModal() {
    addSuccessModal.classList.remove("show");
    addSuccessBackdrop.classList.remove("show");
    addSuccessItem = null;
}

$("add-success-close").addEventListener("click", closeAddSuccessModal);
$("add-success-back").addEventListener("click", closeAddSuccessModal);
addSuccessBackdrop.addEventListener("click", closeAddSuccessModal);

$("add-success-print").addEventListener("click", async () => {
    if (!addSuccessItem) return;
    const { id, category } = addSuccessItem;
    closeAddSuccessModal();
    if (window.preselectPrintItem) {
        await window.preselectPrintItem(id, category);
    } else {
        // qr-print.js didn't load for some reason — fall back to the
        // plain print screen so the user isn't stuck.
        window.showScreen("print");
    }
});

/* ════════════════════════════════════════════════════════════
BULK-SUCCESS MODAL — shown after "Tambah Massal" finishes, listing
every unit that was just created.
════════════════════════════════════════════════════════════ */
const bulkSuccessModal = $("bulk-success-modal");
const bulkSuccessBackdrop = $("bulk-success-backdrop");

window.openBulkSuccessModal = function(created) {
    $("bulk-success-count").textContent = `${created.length} unit dibuat`;
    $("bulk-success-list").innerHTML = created
        .map((it) => `<div><span style="color:var(--gold); font-weight:600;">${escapeHtml(it.shortId)}</span> — ${escapeHtml(it.id)}</div>`)
        .join("");
    bulkSuccessModal.classList.add("show");
    bulkSuccessBackdrop.classList.add("show");
};

function closeBulkSuccessModal() {
    bulkSuccessModal.classList.remove("show");
    bulkSuccessBackdrop.classList.remove("show");
}
$("bulk-success-close").addEventListener("click", closeBulkSuccessModal);
$("bulk-success-ok").addEventListener("click", closeBulkSuccessModal);
bulkSuccessBackdrop.addEventListener("click", closeBulkSuccessModal);
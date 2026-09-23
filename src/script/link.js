/* ════════════════════════════════════════════════════════════
link.js — Bidirectional item linking (CPU <-> Monitor)
════════════════════════════════════════════════════════════ */
import { doc, updateDoc, arrayRemove, getDoc } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const $ = (id) => document.getElementById(id);
const modal = $("link-modal");
const backdrop = $("link-modal-backdrop");
let currentSourceId = null;

/* ── Open/Close Modal ─────────────────────────────────────── */
window.openLinkModal = function(itemId) {
    const item = window.ALL_ITEMS.find(i => i.id === itemId);
    if (!item) return;

    if (!window.canCategoryLink(item.category)) {
        window.toast("Kategori ini tidak dapat dihubungkan ke perangkat lain.", "bad");
        return;
    }
    if (item.linkedIds && item.linkedIds.length > 0) {
        window.toast(`Item ini sudah terhubung dengan ${item.linkedIds[0]}. Putus dulu sebelum menghubungkan yang baru.`, "bad");
        return;
    }

    currentSourceId = itemId;
    $("link-source-id").textContent = itemId;
    $("link-search").value = "";
    $("link-search-results").innerHTML = '<div class="muted" style="text-align:center; padding:20px;">Ketik untuk mencari...</div>';
    modal.classList.add("show");
    backdrop.classList.add("show");
    $("link-search").focus();
};

function closeLinkModal() {
    modal.classList.remove("show");
    backdrop.classList.remove("show");
    currentSourceId = null;
}

$("link-modal-close").addEventListener("click", closeLinkModal);
backdrop.addEventListener("click", closeLinkModal);

/* ── Search & Render Linkable Items ───────────────────────── */
$("link-search").addEventListener("input", (e) => {
    const q = e.target.value.trim().toLowerCase();
    const resultsBox = $("link-search-results");

    if (!q) { resultsBox.innerHTML = '<div class="muted" style="text-align:center; padding:20px;">Ketik untuk mencari...</div>'; return; }
    if (!currentSourceId) return;

    // Pull the live source item straight from ALL_ITEMS (kept in sync by
    // inventory.js's onSnapshot listener) instead of a fresh getDoc —
    // avoids a Firestore read on every keystroke.
    const sourceItem = window.ALL_ITEMS.find(i => i.id === currentSourceId);
    if (!sourceItem) return;

    const partnerCategory = window.getLinkPartnerCategory(sourceItem.category);
    const existingLinks = sourceItem.linkedIds || [];

    if (!partnerCategory) {
        resultsBox.innerHTML = '<div class="muted" style="text-align:center; padding:20px;">Kategori ini tidak dapat dihubungkan.</div>';
        return;
    }

    // Only the paired category is ever eligible (e.g. PC only ever
    // searches Monitor items, and vice versa). Furnitur/Elektronik
    // never appear here since no category pairs with them.
    const matches = window.ALL_ITEMS.filter(it => {
        if (it.id === currentSourceId) return false; // Don't link to self
        if (it.category !== partnerCategory) return false;
        const hay = [it.id, it.category, it.lokasi, ...Object.values(it.fields || {})].join(" ").toLowerCase();
        return hay.includes(q);
    });

    if (matches.length === 0) {
        resultsBox.innerHTML = '<div class="muted" style="text-align:center; padding:20px;">Tidak ada item ditemukan.</div>';
        return;
    }

    resultsBox.innerHTML = matches.map(it => {
        const isLinkedToSource = existingLinks.includes(it.id);
        const isLinkedElsewhere = !isLinkedToSource && !!(it.linkedIds && it.linkedIds.length > 0);
        const unavailable = isLinkedToSource || isLinkedElsewhere;
        const name = it.fields?.merk || it.fields?.name || "Tanpa Nama";
        const statusLabel = isLinkedToSource ? '✓ Terhubung' : isLinkedElsewhere ? '⚠ Terhubung ke lain' : '+ Hubungkan';
        return `
            <div class="link-item ${unavailable ? 'already-linked' : ''}" data-target-id="${it.id}">
                <div class="link-item-info">
                    <span class="link-item-id">${it.id}</span>
                    <span class="link-item-name">${name} (${it.category})</span>
                </div>
                <span>${statusLabel}</span>
            </div>
        `;
    }).join("");

    // Attach click listeners
    resultsBox.querySelectorAll(".link-item:not(.already-linked)").forEach(el => {
        el.addEventListener("click", () => createLink(currentSourceId, el.dataset.targetId));
    });
});

/* ── Create Bidirectional Link ─────────────────────────────── */
async function createLink(id1, id2) {
    try {
        // Re-check against FRESH Firestore data, not the cached ALL_ITEMS
        // list, so a race (two people linking at once, or stale UI state)
        // can't slip through the client-side filtering above.
        const [snap1, snap2] = await Promise.all([
            getDoc(doc(db, "items", id1)),
            getDoc(doc(db, "items", id2))
        ]);
        if (!snap1.exists() || !snap2.exists()) {
            return window.toast("Salah satu item tidak ditemukan.", "bad");
        }
        const data1 = snap1.data();
        const data2 = snap2.data();

        if (window.getLinkPartnerCategory(data1.category) !== data2.category) {
            return window.toast("Kombinasi kategori ini tidak boleh dihubungkan.", "bad");
        }

        const links1 = data1.linkedIds || [];
        const links2 = data2.linkedIds || [];
        if (links1.length > 0 && !links1.includes(id2)) {
            return window.toast(`${id1} sudah terhubung dengan ${links1[0]}. Putus dulu sebelum menghubungkan yang baru.`, "bad");
        }
        if (links2.length > 0 && !links2.includes(id1)) {
            return window.toast(`${id2} sudah terhubung dengan ${links2[0]}. Putus dulu sebelum menghubungkan yang baru.`, "bad");
        }

        // Each item may only ever have one partner, so set (not append).
        await Promise.all([
            updateDoc(doc(db, "items", id1), { linkedIds: [id2] }),
            updateDoc(doc(db, "items", id2), { linkedIds: [id1] })
        ]);
        window.toast(`Berhasil menghubungkan ${id1} & ${id2}`, "ok");

        // Refresh search results to show "✓ Terhubung"
        $("link-search").dispatchEvent(new Event('input'));
    } catch (e) {
        window.toast("Gagal menghubungkan: " + e.message, "bad");
    }
}
/* ── View Links Modal Logic ─────────────────────────────────── */
const viewLinksModal = $("view-links-modal");
const viewLinksBackdrop = $("view-links-backdrop");

window.openViewLinksModal = async function(itemId) {
    $("view-links-source-id").textContent = itemId;
    $("view-links-list").innerHTML = '<div class="muted" style="text-align:center; padding:20px;">Memuat...</div>';
    viewLinksModal.classList.add("show");
    viewLinksBackdrop.classList.add("show");

    try {
        const snap = await getDoc(doc(db, "items", itemId));
        if (!snap.exists()) {
            $("view-links-list").innerHTML = '<div class="muted">Item tidak ditemukan.</div>';
            return;
        }
        
        const data = snap.data();
        const linkedIds = data.linkedIds || [];

        if (linkedIds.length === 0) {
            $("view-links-list").innerHTML = '<div class="muted" style="text-align:center; padding:20px;">Tidak ada perangkat terkait.</div>';
            return;
        }

        // Fetch all linked items in parallel
        const linkedSnaps = await Promise.all(linkedIds.map(id => getDoc(doc(db, "items", id))));
        const linkedItems = linkedSnaps.filter(s => s.exists()).map(s => ({ id: s.id, ...s.data() }));

        $("view-links-list").innerHTML = linkedItems.map(l => {
            const name = l.fields?.merk || l.fields?.name || "Tanpa Nama";
            return `
                <div class="link-item">
                    <div class="link-item-info">
                        <span class="link-item-id">${l.id}</span>
                        <span class="link-item-name">${name} <span class="muted">(${l.category})</span></span>
                    </div>
                    <button class="btn danger unlink-btn" data-unlink="${itemId}|${l.id}" style="padding: 6px 10px; font-size: 12px;">Putus</button>
                </div>
            `;
        }).join("");

        // Attach unlink listeners
        $("view-links-list").querySelectorAll(".unlink-btn").forEach(btn => {
            btn.addEventListener("click", async (e) => {
                e.stopPropagation();
                const [id1, id2] = btn.dataset.unlink.split("|");
                await unlinkItems(id1, id2);
            });
        });

    } catch (e) {
        $("view-links-list").innerHTML = `<div class="muted" style="color:var(--danger)">Error: ${e.message}</div>`;
    }
};

function closeViewLinksModal() {
    viewLinksModal.classList.remove("show");
    viewLinksBackdrop.classList.remove("show");
}

$("view-links-close").addEventListener("click", closeViewLinksModal);
viewLinksBackdrop.addEventListener("click", closeViewLinksModal);

/* ── Unlink Logic ───────────────────────────────────────────── */
async function unlinkItems(id1, id2) {
    if (!confirm("Putus hubungan antara kedua item ini?")) return;
    try {
        // Remove id2 from id1's list, and id1 from id2's list
        await Promise.all([
            updateDoc(doc(db, "items", id1), { linkedIds: arrayRemove(id2) }),
            updateDoc(doc(db, "items", id2), { linkedIds: arrayRemove(id1) })
        ]);
        window.toast("Hubungan diputus", "ok");
        // Refresh the modal list immediately
        window.openViewLinksModal(id1);
    } catch (e) {
        window.toast("Gagal memutus: " + e.message, "bad");
    }
}
/* ════════════════════════════════════════════════════════════
SIMPLE LINK MODAL LOGIC
════════════════════════════════════════════════════════════ */
const slmModal = $("simple-link-modal");
const slmBackdrop = $("simple-link-backdrop");
let slmCurrentId = null;

window.openSimpleLinkModal = async function(itemId) {
    slmCurrentId = itemId;
    
    // Find item data from global ALL_ITEMS
    const item = window.ALL_ITEMS.find(i => i.id === itemId);
    if (!item) return;

    // Populate Basic Data
    $("slm-id").textContent = item.id;
    const merk = item.fields?.merk || item.fields?.name || "Tanpa Nama";
    $("slm-merk").textContent = merk;

    const btnLink = $("slm-btn-link");
    const btnUnlink = $("slm-btn-unlink");
    const linkedSection = $("slm-linked-section");
    const linkedList = $("slm-linked-list");
    const hint = $("slm-hint");

    // Some categories (Furnitur, Elektronik, ...) can never be linked at
    // all — don't even offer the option.
    if (!window.canCategoryLink(item.category)) {
        btnLink.hidden = true;
        btnUnlink.hidden = true;
        linkedSection.hidden = true;
        hint.textContent = "Kategori ini tidak dapat dihubungkan ke perangkat lain.";
        slmModal.classList.add("show");
        slmBackdrop.classList.add("show");
        return;
    }
    btnUnlink.hidden = false;

    // Check Link Status
    const hasLinks = item.linkedIds && item.linkedIds.length > 0;

    if (hasLinks) {
        // ✅ ALREADY LINKED STATE
        btnLink.hidden = true; // Hide the "Hubungkan" button
        btnUnlink.disabled = false;
        btnUnlink.textContent = "Putus Link";
        hint.textContent = `Sudah terhubung dengan ${item.linkedIds[0]}. Klik 'Putus Link' untuk memutuskan koneksi.`;
        
        // Show and populate the linked devices section
        linkedSection.hidden = false;
        linkedList.innerHTML = '<div class="muted" style="text-align:center; padding:10px;">Memuat...</div>';

        try {
            // Fetch all linked items in parallel
            const linkedSnaps = await Promise.all(item.linkedIds.map(id => getDoc(doc(db, "items", id))));
            const linkedItems = linkedSnaps.filter(s => s.exists()).map(s => ({ id: s.id, ...s.data() }));

            linkedList.innerHTML = linkedItems.map(l => {
                const name = l.fields?.merk || l.fields?.name || "Tanpa Nama";
                return `
                    <div class="link-item" style="margin-bottom: 8px; padding: 10px;">
                        <div class="link-item-info">
                            <span class="link-item-id">${l.id}</span>
                            <span class="link-item-name">${name} <span class="muted">(${l.category})</span></span>
                        </div>
                    </div>
                `;
            }).join("");
        } catch (e) {
            linkedList.innerHTML = '<div class="muted">Gagal memuat perangkat terkait.</div>';
        }

    } else {
        // ❌ NOT LINKED STATE
        btnLink.hidden = false; // Show the "Hubungkan" button
        btnUnlink.disabled = true;
        btnUnlink.textContent = "Putus Link";
        hint.textContent = "Klik 'Hubungkan' untuk mencari perangkat lain.";
        linkedSection.hidden = true; // Hide the linked devices section
    }

    // Show Modal
    slmModal.classList.add("show");
    slmBackdrop.classList.add("show");
};

function closeSimpleLinkModal() {
    slmModal.classList.remove("show");
    slmBackdrop.classList.remove("show");
    slmCurrentId = null;
}

$("simple-link-close").addEventListener("click", closeSimpleLinkModal);
slmBackdrop.addEventListener("click", closeSimpleLinkModal);

/* ── Handle "Hubungkan" Click ──────────────────────────────── */
$("slm-btn-link").addEventListener("click", () => {
    const itemId = slmCurrentId; // capture before closeSimpleLinkModal() clears it
    closeSimpleLinkModal();
    // Open the full search modal
    window.openLinkModal(itemId);
});

/* ── Handle "Putus Link" Click ─────────────────────────────── */
$("slm-btn-unlink").addEventListener("click", async () => {
    if (!slmCurrentId) return;
    if (!confirm("Apakah anda ingin memutus link item ini?")) return;

    try {
        const item = window.ALL_ITEMS.find(i => i.id === slmCurrentId);
        const linkedIds = item.linkedIds || [];

        // 1. Remove this item's ID from all linked partners
        const removePromises = linkedIds.map(targetId => 
            updateDoc(doc(db, "items", targetId), { linkedIds: arrayRemove(slmCurrentId) })
        );

        // 2. Clear this item's linkedIds array completely
        removePromises.push(updateDoc(doc(db, "items", slmCurrentId), { linkedIds: [] }));

        await Promise.all(removePromises);
        
        window.toast("Semua link diputus", "ok");
        closeSimpleLinkModal();
    } catch (e) {
        window.toast("Gagal memutus link: " + e.message, "bad");
    }
});
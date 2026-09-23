
/* ════════════════════════════════════════════════════════════
core.js — Firebase init, global helpers, router, and config loaders
MUST RUN FIRST.
════════════════════════════════════════════════════════════ */
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
    getFirestore, collection, doc, getDocs, deleteDoc,
    query, orderBy
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

/* ── Firebase Init ────────────────────────────────────────── */
const firebaseConfig = {
    apiKey: "AIzaSyAoW-WTDueAHLYNfPAuDcf6m1U4pSPie-o",
    authDomain: "inventorazz.firebaseapp.com",
    databaseURL: "https://inventorazz-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "inventorazz",
    storageBucket: "inventorazz.firebasestorage.app",
    messagingSenderId: "754984170276",
    appId: "1:754984170276:web:ddd7f9f7880e6101a539b1"
};
const app = initializeApp(firebaseConfig);
window.db = getFirestore(app);


// Attach to window so other modular files can access it
window.db = getFirestore(app);
window.CATEGORIES = {};
window.ALL_ITEMS = [];

/* ── Linking Rules ────────────────────────────────────────────
   Which categories are allowed to link to each other, and to what.
   Values MUST match the category *document IDs* in Firestore's
   "categories" collection exactly (the same ids stored on item.category,
   e.g. as shown in the inventory list: "PC", "Monitor") — NOT the label.
   Lookups below are case-insensitive, but the VALUE you map to here is
   used verbatim to filter items, so its casing must match Firestore.
   PC <-> Monitor is currently the only allowed pair. Furnitur and
   Elektronik are intentionally left out — they can never be linked.
   ─────────────────────────────────────────────────────────────── */
window.LINK_PARTNER = {
    pc: "Monitor",
    monitor: "PC"
};

window.canCategoryLink = function(category) {
    return !!window.LINK_PARTNER[String(category || "").toLowerCase()];
};

window.getLinkPartnerCategory = function(category) {
    return window.LINK_PARTNER[String(category || "").toLowerCase()] || null;
};

/* ── "Periksa Massal" (bulk mark) eligibility ─────────────────
   Mode Maintenance's bulk-mark tool can only ever be used on
   furniture-type categories (chairs, tables — identical items that
   are either all there or not). CPU, Monitor and Elektronik always
   need a one-by-one look, so they're excluded here at the source:
   loadCategories() below only offers eligible categories in the
   "Massal" dropdown, and maintenance.js double-checks this before
   ever writing a bulk result.
   Keys are lowercased category *document IDs* (same convention as
   LINK_PARTNER above) — add more here if another category later
   turns out to be safe for bulk marking too. ─────────────────── */
window.BULK_MARK_CATEGORIES = ["furnitur"];

window.canBulkMark = function(category) {
    return window.BULK_MARK_CATEGORIES.includes(String(category || "").toLowerCase());
};

/* ── Global Helpers ───────────────────────────────────────── */
window.$ = (id) => document.getElementById(id);

window.toast = function(msg, kind = "ok") {
    const el = $("toast");
    el.textContent = msg;
    el.className = "toast show " + kind;
    clearTimeout(el._t);
    el._t = setTimeout(() => (el.className = "toast"), 2400);
};

window.todayISO = function() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

window.yymmdd = function() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return String(d.getFullYear()).slice(-2) + p(d.getMonth() + 1) + p(d.getDate());
};

window.escapeHtml = function(s) {
    return String(s ?? " ").replace(/[&<>"']/g, (c) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
};

/* ── Router ───────────────────────────────────────────────── */
const SCREENS = ["splash", "login", "menu", "add", "list", "scan", "problem", "maintenance", "print", "laporan", "pengawas-home"];

// Screens the limited "operator" role may never navigate into, even if
// a button somehow stays clickable. This is the single choke point for
// all in-app navigation, so it's enforced here regardless of what
// triggered the click. (Client-side only — see login.js for why.)
//
// Operators are the field team: they run inspections, so "maintenance"
// is open to them. "menu" (home / today's summary) and "problem"
// (Inventaris Bermasalah) are view-only for operators — allowed here,
// with the actual admin-only actions on those screens (resolving a
// report, Dev Tools, etc.) hidden individually via data-role="admin"
// in the markup instead.
const OPERATOR_RESTRICTED_SCREENS = ["add", "list", "print"];

// "pengawas" is the opposite shape of restriction: instead of a few
// screens carved out, almost everything is off-limits. An allow-list
// (rather than another deny-list) is deliberate here — anything new
// added to the app later is blocked for pengawas by default instead of
// silently becoming reachable. Both "list" (Daftar Inventaris) and
// "laporan" are view-only for this role; the delete/edit/link controls
// on "list" are hidden individually via role checks in inventory.js,
// same spirit as the data-role="admin" markup pattern above.
const PENGAWAS_ALLOWED_SCREENS = ["pengawas-home", "laporan", "list"];


/* ── Back-button navigation stack ──────────────────────────────
   As an installed web app, the phone's back button/gesture closes
   the app outright if the page has no browser history to step back
   through — and since this router never changes the URL (just
   toggles which .screen is .active), by default there IS no history,
   so back always closed it immediately.

   Fix: every real navigation pushes a history entry carrying the
   screen name. The back button then pops through THOSE first —
   scan → menu → whatever came before — before it ever reaches the
   floor (the page-load entry, which has no state). Reaching the
   floor while logged in is treated as "at the dashboard, wants to
   exit": show a toast and require a second back press within a
   couple seconds to actually leave, instead of exiting on the first.
   Not logged in (login/splash) has nothing worth protecting, so a
   single back press there behaves normally.

   Screens are still shown by calling showScreen(name) exactly as
   before everywhere else in the app — the push happens inside this
   one function, so nothing else needed to change. ───────────────── */
const NO_HISTORY_SCREENS = ["splash", "login"]; // never worth a back-stack entry
let currentScreenName = null;

function currentDashboardScreen() {
    return window.CURRENT_USER?.role === "pengawas" ? "pengawas-home" : "menu";
}

window.showScreen = function(name, opts = {}) {
    SCREENS.forEach((s) => {
        const el = $("screen-" + s);
        if(el) el.classList.toggle("active", s === name);
    });
    window.scrollTo(0, 0);

    const changed = name !== currentScreenName;
    currentScreenName = name;

    // A screen reached via the back/forward button is already the
    // browser's current history entry — pushing again would just
    // stack a duplicate on top of itself.
    if (opts.fromPopstate) return;
    if (changed && !NO_HISTORY_SCREENS.includes(name)) {
        history.pushState({ screen: name }, "", location.href);
    }
};

let lastExitAttemptAt = 0;
const EXIT_CONFIRM_WINDOW_MS = 2000;

window.addEventListener("popstate", (e) => {
    const target = e.state?.screen;

    // Logged out, but the browser still remembers screens pushed
    // during a now-ended session (e.g. right after logout) — never
    // honor those, straight back to the login gate instead.
    if (!window.CURRENT_USER && target && target !== "login") {
        window.showScreen("login", { fromPopstate: true });
        return;
    }

    if (target) {
        window.showScreen(target, { fromPopstate: true });
        return;
    }

    // No state → popped past our own stack, back to the page-load
    // floor. Not logged in → nothing to protect, let the back press
    // behave normally (closes the app). Logged in → this is the
    // "press back again to exit" moment.
    if (!window.CURRENT_USER) return;

    const now = Date.now();
    if (now - lastExitAttemptAt < EXIT_CONFIRM_WINDOW_MS) {
        return; // second press within the window — let it actually exit
    }
    lastExitAttemptAt = now;
    toast("Tekan sekali lagi untuk keluar", "ok");
    // "Undo" this pop so the visible screen doesn't change and
    // there's something to pop again on the next back press.
    history.pushState({ screen: currentDashboardScreen() }, "", location.href);
});

document.body.addEventListener("click", (e) => {
    const nav = e.target.closest("[data-nav]");
    if (!nav) return;
    let target = nav.dataset.nav;

    // pengawas has no "menu" (Beranda) screen of its own — every
    // "← back" button in the app targets data-nav="menu", so redirect
    // those to pengawas' own mini-home instead of blocking them below.
    if (window.CURRENT_USER?.role === "pengawas" && target === "menu") {
        target = "pengawas-home";
    }

    if (window.CURRENT_USER?.role === "operator" && OPERATOR_RESTRICTED_SCREENS.includes(target)) {
        toast("Halaman ini tidak tersedia untuk mode inspektor.", "bad");
        return;
    }
    if (window.CURRENT_USER?.role === "pengawas" && !PENGAWAS_ALLOWED_SCREENS.includes(target)) {
        toast("Halaman ini tidak tersedia untuk mode pengawas.", "bad");
        return;
    }
    showScreen(target);
});

/* ── Dev Tools Toggle ─────────────────────────────────────── */
const devToggle = $("dev-toggle");
const devPanel  = $("dev-panel");
if(devToggle && devPanel) {
    devToggle.addEventListener("click", () => {
        devPanel.hidden = !devPanel.hidden;
        devToggle.classList.toggle("active", !devPanel.hidden);
    });
}

/* ── Config Loaders ───────────────────────────────────────── */
async function loadCategories() {
    const snap = await getDocs(query(collection(db, "categories"), orderBy("order")));
    window.CATEGORIES = {}; // 👈 Add 'window.' here
    const sel = $("cat-select");
    // "Tambah Massal" and Mode Maintenance's "Periksa Massal" reuse the
    // same category list — filled here too, so it's still one read.
    const bulkSel = $("bulk-cat-select");
    const mtBulkSel = $("mt-bulk-cat-select");
    // Laporan's category filter — every category, unlike mtBulkSel above.
    const lapSel = $("lap-cat-filter");
    const emptyOpt = '<option value="">— pilih kategori —</option>';
    sel.innerHTML = emptyOpt;
    if (bulkSel) bulkSel.innerHTML = emptyOpt;
    if (mtBulkSel) mtBulkSel.innerHTML = '<option value="">— kategori —</option>';
    if (lapSel) lapSel.innerHTML = '<option value="">Semua kategori</option>';
    if (snap.empty) {
        const msg = '<option value="" disabled>(belum ada — klik Seed Config)</option>';
        sel.innerHTML += msg;
        if (bulkSel) bulkSel.innerHTML += msg;
        if (mtBulkSel) mtBulkSel.innerHTML += msg;
        return;
    }
    snap.forEach((d) => {
        window.CATEGORIES[d.id] = d.data(); //  Add 'window.' here
        const o = document.createElement("option");
        o.value = d.id; o.textContent = d.data().label || d.id;
        sel.appendChild(o);
        if (bulkSel) bulkSel.appendChild(o.cloneNode(true));
        // Mode Maintenance's "Periksa Massal" only ever offers categories
        // safe for bulk marking (see window.BULK_MARK_CATEGORIES) — CPU,
        // Monitor and Elektronik need a one-by-one inspection instead.
        if (mtBulkSel && window.canBulkMark(d.id)) mtBulkSel.appendChild(o.cloneNode(true));
        if (lapSel) lapSel.appendChild(o.cloneNode(true));
    });
}

async function loadLocations() {
    const snap = await getDocs(query(collection(db, "locations"), orderBy("order")));
    const addSel = $("lokasi-select");
    const filSel = $("filter-lokasi");
    const bulkSel = $("bulk-lokasi-select");       // "Tambah Massal"
    const mtBulkSel = $("mt-bulk-lokasi-select");   // "Periksa Massal" — both same source, no extra read
    addSel.innerHTML = '<option value="">— pilih lokasi —</option>';
    filSel.innerHTML = '<option value="">Semua lokasi</option>';
    if (bulkSel) bulkSel.innerHTML = '<option value="">— pilih lokasi —</option>';
    if (mtBulkSel) mtBulkSel.innerHTML = '<option value="">— lokasi —</option>';
    if (snap.empty) {
        const msg = '<option value="" disabled>(belum ada — klik Seed Config)</option>';
        addSel.innerHTML += msg;
        if (bulkSel) bulkSel.innerHTML += msg;
        if (mtBulkSel) mtBulkSel.innerHTML += msg;
        return;
    }
    snap.forEach((d) => {
        const name = d.data().name || d.id;
        addSel.appendChild(new Option(name, name));
        filSel.appendChild(new Option(name, name));
        if (bulkSel) bulkSel.appendChild(new Option(name, name));
        if (mtBulkSel) mtBulkSel.appendChild(new Option(name, name));
    });
}

/* ── NEW: Delete Identifiers (Categories & Locations) ─────── */
window.deleteCategory = async function(id) {
    if (!confirm(`Hapus kategori "${id}"? Item dengan kategori ini tidak akan terhapus, tapi dropdown akan hilang.`)) return;
    try {
        await deleteDoc(doc(db, "categories", id));
        toast(`Kategori ${id} dihapus`);
        await loadCategories();
    } catch (e) { toast("Gagal hapus kategori: " + e.message, "bad"); }
};

window.deleteLocation = async function(id) {
    if (!confirm(`Hapus lokasi "${id}"?`)) return;
    try {
        await deleteDoc(doc(db, "locations", id));
        toast(`Lokasi ${id} dihapus`);
        await loadLocations();
    } catch (e) { toast("Gagal hapus lokasi: " + e.message, "bad"); }
};

/* ── Boot Sequence ────────────────────────────────────────── */
(async function boot() {
    const startedAt = Date.now();
    try {
        await Promise.all([loadCategories(), loadLocations()]);
        // updateIdPreview is in inventory.js, check if it exists before calling
        if(window.updateIdPreview) window.updateIdPreview(); 
    } catch (e) {
        console.error(e);
        toast("Init error: " + e.message, "bad");
    }
    
    // subscribeItems is in inventory.js
    if(window.subscribeItems) window.subscribeItems();

    const MIN_SPLASH = 1400;
    const wait = Math.max(0, MIN_SPLASH - (Date.now() - startedAt));
    setTimeout(() => {
        // restoreSession (login.js) sends an already-logged-in-today
        // user straight to their home screen; otherwise → login.
        if (!window.restoreSession || !window.restoreSession()) {
            showScreen("login");
        }
    }, wait);
})();


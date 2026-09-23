/* ════════════════════════════════════════════════════════════
seed.js — Seed initial categories & locations to Firestore
HOW TO EDIT: 
1. Modify the SEED_CATEGORIES or SEED_LOCATIONS objects below.
2. Click the "Seed Config" button in the Dev Tools panel.
3. If you made a mistake, use the "Clear Config" button to wipe 
   them from Firestore, fix the code, and seed again.
════════════════════════════════════════════════════════════ */
import { collection, getDocs, getDoc, deleteDoc, doc, setDoc } 
from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

/* ── EDIT YOUR CATEGORIES HERE ────────────────────────────── 
   To add a new category, copy a block and change the key (e.g., "Printer").
   To add a new field to a category, add an object to the "schema" array.
   Types can be "text" or "number".
*/
const SEED_CATEGORIES = {
    PC: {
        label: "PC", order: 1,
        schema: [
            { key: "merk",      label: "Merk",      type: "text",   required: true },
            { key: "processor", label: "Processor", type: "text",   required: true },
            { key: "ram",       label: "RAM",       type: "text",   required: true },
            { key: "storage",   label: "Storage",   type: "text",   required: true },
            { key: "vga",       label: "VGA",       type: "text",   required: true }
        ]
    },
    Monitor: {
        label: "Monitor", order: 2,
        schema: [
            { key: "merk", label: "Merk",          type: "text",   required: true },
            { key: "size", label: "Ukuran (inch)", type: "number", required: true }
        ]
    },
    Furnitur: {
        label: "Furnitur", order: 3,
        schema: [{ key: "name", label: "Nama", type: "text", required: true }]
    },
    Elektronik: {
        label: "Elektronik", order: 4,
        schema: [{ key: "name", label: "Nama", type: "text", required: true }]
    }
    // Example of how to add a new one:
    // Printer: { label: "Printer", order: 5, schema: [{ key: "type", label: "Tipe", type: "text", required: true }] }
};

/* ── EDIT YOUR LOCATIONS HERE ─────────────────────────────── 
   Just add or remove objects from this array. 
   Keep the 'order' number sequential.
*/
const SEED_LOCATIONS = [
    { id: "Lab DKV",  name: "Lab DKV",  order: 1 }
];

/* ── EDIT YOUR DEFAULT OPERATOR ACCOUNTS HERE ─────────────────
   role: "admin" (full access — current app behavior) or
         "operator" (scan + inspect only, everything else hidden).
   Unlike categories/locations above, seeding this does NOT
   overwrite an account that already exists — it only creates the
   ones that are missing. That makes it safe to click again after
   changing a password by hand in the Firestore console, or after
   adding a new operator to this list below.
   CHANGE THE DEFAULT PASSWORD before real use.
*/
const SEED_OPERATORS = {
    admin1: { name: "Admin", password: "admin123", role: "admin" }
    // inspector1: { name: "Sari", password: "insp123", role: "operator" }
};

/* ── Seed Button Logic ────────────────────────────────────── */
$("seed-btn").addEventListener("click", async () => {
    if (!confirm("Tulis konfigurasi kategori & lokasi ke Firestore? (aman diulang)")) return;
    $("seed-btn").disabled = true;
    try {
        for (const [id, data] of Object.entries(SEED_CATEGORIES)) {
            await setDoc(doc(db, "categories", id), data);
        }
        for (const loc of SEED_LOCATIONS) {
            await setDoc(doc(db, "locations", loc.id), { name: loc.name, order: loc.order });
        }
        toast("Config seeded ✓");
        await Promise.all([loadCategories(), loadLocations()]);
    } catch (e) {
        console.error(e);
        toast("Seed failed: " + e.message, "bad");
    } finally {
        $("seed-btn").disabled = false;
    }
});

/* ── NEW: Clear / Delete Config (If you made a mistake) ───── */
// You can trigger this by adding a button in your HTML, or running it in the console.
window.clearAllConfig = async function() {
    if (!confirm("PERINGATAN: Ini akan menghapus SEMUA kategori dan lokasi dari database. Lanjutkan?")) return;
    
    try {
        // Delete Categories
        const catSnap = await getDocs(collection(db, "categories"));
        for (const d of catSnap.docs) {
            await deleteDoc(d.ref);
        }
        
        // Delete Locations
        const locSnap = await getDocs(collection(db, "locations"));
        for (const d of locSnap.docs) {
            await deleteDoc(d.ref);
        }
        
        toast("Semua config dihapus. Silakan seed ulang.");
        await Promise.all([loadCategories(), loadLocations()]);
    } catch (e) {
        toast("Gagal clear config: " + e.message, "bad");
    }
};

// Optional: Auto-wire a clear button if you add it to your HTML dev panel
const clearBtn = $("clear-config-btn");
if(clearBtn) {
    clearBtn.addEventListener("click", clearAllConfig);
}

/* ── Seed Operators Button Logic ──────────────────────────────
   Skip-if-exists, unlike the categories/locations seeding above —
   see the comment on SEED_OPERATORS for why. ────────────────── */
$("seed-operators-btn")?.addEventListener("click", async () => {
    if (!confirm("Buat akun operator awal yang belum ada? Akun yang sudah ada TIDAK akan diubah.")) return;
    $("seed-operators-btn").disabled = true;
    try {
        let created = 0;
        for (const [id, data] of Object.entries(SEED_OPERATORS)) {
            const ref = doc(db, "operators", id);
            const existing = await getDoc(ref);
            if (existing.exists()) continue; // never clobber an existing account/password
            await setDoc(ref, data);
            created++;
        }
        toast(created > 0 ? `${created} akun operator dibuat ✓` : "Semua akun sudah ada, tidak ada perubahan");
    } catch (e) {
        console.error(e);
        toast("Seed akun operator gagal: " + e.message, "bad");
    } finally {
        $("seed-operators-btn").disabled = false;
    }
});

/* ── NEW: Clear ALL operator accounts (careful — this locks
   everyone out, including yourself, until you seed again) ───── */
// Trigger by adding a button in your HTML (id="clear-operators-btn"), or from the console.
window.clearAllOperators = async function() {
    if (!confirm("PERINGATAN: Ini akan menghapus SEMUA akun operator (termasuk admin) dari database. Lanjutkan?")) return;
    try {
        const snap = await getDocs(collection(db, "operators"));
        for (const d of snap.docs) {
            await deleteDoc(d.ref);
        }
        toast("Semua akun operator dihapus. Silakan seed ulang.");
    } catch (e) {
        toast("Gagal hapus akun operator: " + e.message, "bad");
    }
};

const clearOperatorsBtn = $("clear-operators-btn");
if (clearOperatorsBtn) {
    clearOperatorsBtn.addEventListener("click", clearAllOperators);
}
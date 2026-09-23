/* ════════════════════════════════════════════════════════════
qr-print.js — Category/Item selection & Bluetooth Thermal Printing
Relies on: core.js, inventory.js (for ALL_ITEMS)
════════════════════════════════════════════════════════════ */
// ✅ UPDATED (Added orderBy)
import { collection, getDocs, query, where, orderBy } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

/* ── State ────────────────────────────────────────────────── */
let btPrinter = null;
let btDevice = null;
let selectedItemId = null;
let selectedItemData = null; // full item doc, incl. shortId — set alongside selectedItemId

/* ── DOM Elements ─────────────────────────────────────────── */
const $ = (id) => document.getElementById(id);
const catSelect = $("print-cat-select");
const itemSelect = $("print-item-select");
const detailsBox = $("print-item-details");
const btStatus = $("print-bt-status");
const btnConnect = $("print-bt-connect");
const btnPrint = $("print-bt-print");
const qrRenderBox = $("qr-hidden-render");

/* ── 1. Load Categories (Fetches directly from Firestore) ─── */
async function loadPrintCategories() {
    catSelect.innerHTML = '<option value="">— pilih kategori —</option>';
    try {
        // We query Firestore directly here to avoid timing issues with core.js
        const snap = await getDocs(query(collection(window.db, "categories"), orderBy("order")));
        
        if (snap.empty) {
            catSelect.innerHTML += '<option value="" disabled>Belum ada kategori (Seed dulu)</option>';
            return;
        }
        
        snap.forEach((d) => {
            const data = d.data();
            catSelect.appendChild(new Option(data.label || d.id, d.id));
        });
    } catch (e) {
        console.error(e);
        window.toast("Gagal memuat kategori", "bad");
    }
}

catSelect.addEventListener("change", async () => {
    await loadItemsForCategory(catSelect.value);
});

/* Reusable: populate print-item-select for a given category. Shared by
   the change handler above and window.preselectPrintItem below, so both
   paths stay in sync. */
async function loadItemsForCategory(catId) {
    itemSelect.innerHTML = '<option value="">— pilih item —</option>';
    $("print-step-2").hidden = !catId;
    $("print-step-3").hidden = true;

    if (!catId) return;

    // Fetch items for this category directly from Firestore
    try {
        const q = query(collection(window.db, "items"), where("category", "==", catId));
        const snap = await getDocs(q);

        if (snap.empty) {
            itemSelect.innerHTML = '<option value="" disabled>Tidak ada item di kategori ini</option>';
            return;
        }

        snap.forEach(d => {
            const data = d.data();
            // Triangulate by Merk or Name
            const merk = data.fields?.merk || data.fields?.name || data.fields?.type || "Tanpa Nama";
            const optText = data.shortId ? `${data.shortId} — ${merk} (${d.id})` : `${d.id} - ${merk}`;
            const opt = new Option(optText, d.id);
            opt.dataset.itemData = JSON.stringify(data);
            itemSelect.appendChild(opt);
        });
    } catch (e) {
        console.error(e);
        window.toast("Gagal memuat item", "bad");
    }
}

/* ── 2. Select Item & Show Details ────────────────────────── */
itemSelect.addEventListener("change", () => {
    selectPrintItem(itemSelect.value);
});

/* Reusable: mark an item as selected (must already be an <option> in
   print-item-select) and render its details box. Shared by the change
   handler above and window.preselectPrintItem below. */
function selectPrintItem(itemId) {
    itemSelect.value = itemId;
    $("print-step-3").hidden = !itemId;
    if (!itemId) { selectedItemId = null; selectedItemData = null; return; }

    const opt = itemSelect.options[itemSelect.selectedIndex];
    if (!opt || opt.value !== itemId) return; // option wasn't found/selected

    selectedItemId = itemId;
    const data = JSON.parse(opt.dataset.itemData);
    selectedItemData = data;

    // Render Specs
    let specsHtml = data.shortId
        ? `<div style="color:var(--gold); font-weight:700; font-size:16px; margin-bottom:2px;">${data.shortId}</div>
           <div class="muted" style="font-size:11px; margin-bottom:8px;">${itemId}</div>`
        : `<div style="color:var(--gold); font-weight:600; margin-bottom:4px;">${itemId}</div>
           <div class="muted" style="font-size:11px; margin-bottom:8px;">⚠️ Item ini belum punya index pendek (mis. PC-01) — hanya ID lengkap yang akan tercetak.</div>`;
    specsHtml += `<div><strong>Kategori:</strong> ${data.category}</div>`;
    specsHtml += `<div><strong>Lokasi:</strong> ${data.lokasi}</div>`;

    if (data.fields) {
        specsHtml += `<div style="margin-top:8px; border-top:1px solid var(--border); padding-top:8px;">`;
        for (const [k, v] of Object.entries(data.fields)) {
            specsHtml += `<div><strong>${k}:</strong> ${v}</div>`;
        }
        specsHtml += `</div>`;
    }
    detailsBox.innerHTML = specsHtml;
    detailsBox.classList.remove("muted");
}

/* ── Jump straight to the print screen with a category + item already
   selected — used by the "Cetak QR Kode" button on the add-success
   modal in inventory.js right after a new item is saved. ─────────── */
window.preselectPrintItem = async function(itemId, category) {
    window.showScreen("print");
    catSelect.value = category;
    await loadItemsForCategory(category);
    selectPrintItem(itemId);
};

/* ── 3. Bluetooth Connection (From your working app.js) ───── */
btnConnect.addEventListener("click", async () => {
    if (!navigator.bluetooth) {
        window.toast("Web Bluetooth tidak didukung. Gunakan Chrome di Android.", "bad");
        return;
    }

    try {
        btStatus.innerHTML = `<span class="status-dot searching"></span> Mencari printer...`;
        const device = await navigator.bluetooth.requestDevice({
            acceptAllDevices: true,
            optionalServices: [
                '000018f0-0000-1000-8000-00805f9b34fb', '0000ff00-0000-1000-8000-00805f9b34fb', 
                'e7810a71-73ae-499d-8c15-faa9aef0c3f2', '49535343-fe7d-4ae5-8fa9-9fafd205e455', 
                '0000fee7-0000-1000-8000-00805f9b34fb', '00001101-0000-1000-8000-00805f9b34fb', 
                '0000fff0-0000-1000-8000-00805f9b34fb', '0000ffe0-0000-1000-8000-00805f9b34fb'
            ]
        });

        btStatus.innerHTML = `<span class="status-dot searching"></span> Menghubungkan ke ${device.name || 'Printer'}...`;
        const server = await device.gatt.connect();
        btPrinter = server;
        btDevice = device;

        device.addEventListener('gattserverdisconnected', () => {
            btPrinter = null;
            btDevice = null;
            btnPrint.disabled = true;
            btnConnect.style.display = 'block';
            btStatus.innerHTML = `<span class="status-dot disconnected"></span> Printer terputus`;
            window.toast("Printer terputus", "bad");
        });

        btStatus.innerHTML = `<span class="status-dot connected"></span> Terhubung: ${device.name || 'Unknown'}`;
        btnConnect.style.display = 'none';
        btnPrint.disabled = false;
        window.toast("Printer terhubung!", "ok");
    } catch (error) {
        if (error.name !== 'NotFoundError') {
            btStatus.innerHTML = `<span class="status-dot disconnected"></span> Gagal: ${error.message}`;
            window.toast("Gagal connect: " + error.message, "bad");
        } else {
            btStatus.innerHTML = `<span class="status-dot disconnected"></span> Bluetooth: Belum terhubung`;
        }
    }
});

/* ── 4. Print Logic (QR Generation + ESC/POS) ─────────────── */
btnPrint.addEventListener("click", async () => {
    if (!btPrinter) return window.toast("Hubungkan printer dulu", "bad");
    if (!selectedItemId) return;
    if (!window.QRCode) return window.toast("Library QR Code belum termuat — cek koneksi internet lalu muat ulang halaman", "bad");

    const includeHeader = $("print-include-header").checked;
    const size = parseInt(document.querySelector('input[name="qr-size"]:checked').value);

    btnPrint.disabled = true;
    btnPrint.textContent = "Sedang Mencetak...";

    try {
        // 1. Generate QR Code into hidden canvas
        qrRenderBox.innerHTML = "";
        new window.QRCode(qrRenderBox, {
    text: selectedItemId,
    width: size,
    height: size,
    colorDark: "#000000",
    colorLight: "#ffffff",
    correctLevel: window.QRCode.CorrectLevel.H // Also use window.QRCode here
});
        // Wait a tick for canvas to render
        await new Promise(r => setTimeout(r, 100));
        const qrCanvas = qrRenderBox.querySelector("canvas");
        if (!qrCanvas) throw new Error("QR Canvas not found");

        // 2. Build ESC/POS Commands
        const commands = [];
        commands.push(0x1B, 0x40);       // Initialize
        commands.push(0x1B, 0x61, 0x01); // Center align

        // Header — Index (shortId) always prints when the item has one;
        // the full INV.xxxx ID prints below it only if the checkbox is on.
        // An item with no shortId yet (added before this feature) falls
        // back to the old behavior: just the full ID, if checked.
        const shortId = selectedItemData?.shortId || null;

        if (shortId) {
            commands.push(0x1B, 0x21, 0x30); // double width + double height
            commands.push(...stringToBytes(shortId));
            commands.push(0x0A);
            commands.push(0x1B, 0x21, 0x00); // reset text
            if (includeHeader) {
                commands.push(...stringToBytes(selectedItemId));
                commands.push(0x0A);
            }
            commands.push(0x0A);
        } else if (includeHeader) {
            commands.push(0x1B, 0x21, 0x10); // Double height text
            commands.push(...stringToBytes(selectedItemId));
            commands.push(0x0A);
            commands.push(0x1B, 0x21, 0x00); // Reset text
            commands.push(0x0A); // Line break
        }

        // QR Image (Raster)
        commands.push(...getRasterCommands(qrCanvas));
        
        // Feed and cut
        commands.push(0x0A, 0x0A, 0x0A, 0x0A);
        commands.push(0x1D, 0x56, 0x00); // Full cut

        // 3. Send to Printer
        await sendCommandsToPrinter(commands);

        window.toast("Label berhasil dicetak! ✓", "ok");
    } catch (err) {
        console.error(err);
        window.toast("Gagal cetak: " + err.message, "bad");
    } finally {
        btnPrint.disabled = false;
        btnPrint.textContent = "Cetak Label Sekarang";
    }
});

/* ── ESC/POS Helper Functions (From your working app.js) ──── */
function getRasterCommands(canvas) {
    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;
    const imageData = ctx.getImageData(0, 0, width, height).data;
    const widthBytes = Math.ceil(width / 8);
    const commands = [];

    commands.push(0x1D, 0x76, 0x30, 0x00); // GS v 0 m=0
    commands.push(widthBytes % 256, Math.floor(widthBytes / 256));
    commands.push(height % 256, Math.floor(height / 256));

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x += 8) {
            let byte = 0;
            for (let bit = 0; bit < 8; bit++) {
                if (x + bit < width) {
                    const idx = (y * width + (x + bit)) * 4;
                    const brightness = (imageData[idx] + imageData[idx + 1] + imageData[idx + 2]) / 3;
                    if (brightness < 128) byte |= (1 << (7 - bit));
                }
            }
            commands.push(byte);
        }
    }
    return commands;
}

async function sendCommandsToPrinter(commands) {
    const services = await btPrinter.getPrimaryServices();
    let targetChar = null;
    for (const service of services) {
        const characteristics = await service.getCharacteristics();
        for (const char of characteristics) {
            if (char.properties.writeWithoutResponse || char.properties.write) {
                targetChar = char;
                break;
            }
        }
        if (targetChar) break;
    }
    if (!targetChar) throw new Error('Karakteristik write tidak ditemukan');

    const useNoResponse = targetChar.properties.writeWithoutResponse;
    const chunkSize = 64; // Safe chunk size for thermal printers

    for (let i = 0; i < commands.length; i += chunkSize) {
        const chunk = new Uint8Array(commands.slice(i, i + chunkSize));
        if (useNoResponse) await targetChar.writeValueWithoutResponse(chunk);
        else await targetChar.writeValue(chunk);
        await new Promise(r => setTimeout(r, 30)); // 30ms delay prevents buffer overflow
    }
}

function stringToBytes(str) {
    const bytes = [];
    for (let i = 0; i < str.length; i++) bytes.push(str.charCodeAt(i));
    return bytes;
}

/* ── Boot ─────────────────────────────────────────────────── */
loadPrintCategories();
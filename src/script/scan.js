/* ════════════════════════════════════════════════════════════
scan.js — QR Scanning & displaying linked items
════════════════════════════════════════════════════════════ */
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const $ = (id) => document.getElementById(id);
let html5QrcodeScanner = null;

/* ── Initialize Scanner when screen is shown ───────────────── */
// We use a MutationObserver to start the camera only when the scan screen is active
const scanScreen = $("screen-scan");
if (scanScreen) {
    new MutationObserver((mutations) => {
        if (scanScreen.classList.contains("active")) {
            startScanner();
        } else {
            stopScanner();
        }
    }).observe(scanScreen, { attributes: true, attributeFilter: ["class"] });
}

function startScanner() {
    if (html5QrcodeScanner) return; // Already running

    // Change it to this:
    html5QrcodeScanner = new window.Html5Qrcode("qr-reader");
    const config = { fps: 10, qrbox: { width: 250, height: 250 } };
    
    html5QrcodeScanner.start(
        { facingMode: "environment" }, // Use back camera
        config,
        onScanSuccess,
        onScanFailure
    ).catch(err => {
        console.error("Camera error:", err);
        $("qr-reader").innerHTML = '<div class="muted" style="padding:20px; text-align:center;">Gagal mengakses kamera. Pastikan izin diberikan.</div>';
    });
}

function stopScanner() {
    if (html5QrcodeScanner) {
        html5QrcodeScanner.stop().then(() => {
            html5QrcodeScanner.clear();
            html5QrcodeScanner = null;
        }).catch(err => console.error("Stop error:", err));
    }
}

function onScanFailure(decodedText) {
    // Ignore continuous scan failures
}

async function onScanSuccess(decodedText) {
    stopScanner(); // Stop camera after successful scan
    const resultBox = $("scan-result");
    resultBox.hidden = false;
    resultBox.innerHTML = '<div class="muted" style="text-align:center; padding:20px;">Memuat data...</div>';

    try {
        // Fetch the scanned item
        const snap = await getDoc(doc(db, "items", decodedText));
        if (!snap.exists()) {
            resultBox.innerHTML = `<div class="muted" style="text-align:center; padding:20px;">Item <strong>${decodedText}</strong> tidak ditemukan di database.</div>`;
            return;
        }

        const item = snap.data();
        const specsHtml = Object.entries(item.fields || {})
            .map(([k, v]) => `<div><span class="k">${k}:</span> <span>${v}</span></div>`)
            .join("");

        // Fetch linked items
        let linkedHtml = '';
        if (item.linkedIds && item.linkedIds.length > 0) {
            const linkedSnaps = await Promise.all(item.linkedIds.map(id => getDoc(doc(db, "items", id))));
            const linkedItems = linkedSnaps.filter(s => s.exists()).map(s => ({ id: s.id, ...s.data() }));
            
            if (linkedItems.length > 0) {
                linkedHtml = `
                    <div class="scan-linked-title">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
                        Perangkat Terkait (${linkedItems.length})
                    </div>
                    <div class="scan-linked-list">
                        ${linkedItems.map(l => {
                            const name = l.fields?.merk || l.fields?.name || "Tanpa Nama";
                            return `<div class="scan-linked-item">
                                <div>
                                    <div style="font-family:monospace; font-size:11px; color:var(--gold)">${l.id}</div>
                                    <div style="font-weight:600">${name} <span class="muted">(${l.category})</span></div>
                                </div>
                            </div>`;
                        }).join("")}
                    </div>
                `;
            }
        } else {
            linkedHtml = '<div class="muted" style="font-size:12px; margin-top:8px;">Tidak ada perangkat yang terhubung.</div>';
        }

        resultBox.innerHTML = `
            <div class="scan-result-header">
                <div>
                    <div class="scan-result-id">${item.id}</div>
                    <div class="scan-result-category">${item.category} · ${item.lokasi}</div>
                </div>
            </div>
            <div class="scan-specs">${specsHtml}</div>
            ${linkedHtml}
            <button class="btn block" style="margin-top:16px;" onclick="startScanner()">Scan Lagi</button>
        `;

    } catch (e) {
        resultBox.innerHTML = `<div class="muted" style="text-align:center; padding:20px; color:var(--danger)">Error: ${e.message}</div>`;
    }
}

// Make startScanner available globally for the "Scan Lagi" button
window.startScanner = startScanner;
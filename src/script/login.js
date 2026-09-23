/* ════════════════════════════════════════════════════════════
login.js — Password login, daily operator session & role gating
Relies on: core.js (must be loaded first)

Data model (new collection):
  operators/{id}: { name, password, role: "admin"|"operator"|"pengawas", active? }

There's no real backend auth here — same security posture as the
rest of this app (exposed Firebase config, no server). This is a
UX gate, not a security boundary: it hides admin-only screens from
the operator role, it does not enforce it server-side. If that
matters later, it needs Firestore Auth + Security Rules.
════════════════════════════════════════════════════════════ */
import { collection, query, where, limit, getDocs } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const SESSION_KEY = "invlab_session";

/* ── Role-change hook ──────────────────────────────────────────
   Screens whose content depends on CURRENT_USER.role (e.g. problems.js'
   resolve button) register here. This fires on login, restoreSession,
   and logout — the three moments the role can change — so those
   screens can re-render even if they already rendered once before the
   role was known (a live listener may have fired before login). ──── */
window.ROLE_LISTENERS = window.ROLE_LISTENERS || [];
function notifyRoleChange() {
    (window.ROLE_LISTENERS || []).forEach((fn) => {
        try { fn(); } catch (e) { console.error(e); }
    });
}

/* ── Daily session (device-local) ─────────────────────────────
   Stored in localStorage so re-opening the app/tab doesn't force a
   fresh login every time — but it's only valid for "today". Once
   the date rolls over, it's treated as expired and the login screen
   comes back, since "which password → which name did today's
   inspection" is meant to reset daily. ───────────────────────── */
function readSession() {
    try {
        const raw = localStorage.getItem(SESSION_KEY);
        if (!raw) return null;
        const s = JSON.parse(raw);
        if (!s || s.date !== todayISO()) return null; // new day → re-login required
        return s;
    } catch {
        return null;
    }
}

function writeSession(operator) {
    const session = { id: operator.id, name: operator.name, role: operator.role, date: todayISO() };
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    return session;
}

function applyGreeting(user) {
    const el = document.getElementById("greeting-name");
    if (el) el.textContent = user.name;
    // pengawas lands on its own mini-home (screen-pengawas-home) instead
    // of the normal Beranda — same greeting, different element.
    const pengawasEl = document.getElementById("pengawas-greeting-name");
    if (pengawasEl) pengawasEl.textContent = user.name;
    const logoutName = document.getElementById("logout-name");
    if (logoutName) logoutName.textContent = `Keluar (${user.name})`;
}

/* ── Role-based nav/drawer visibility ─────────────────────────
   Every gateable element carries data-role="admin" | "operator" | "any".
   Admins see everything; operators see only "operator"/"any". ──── */
window.applyRoleVisibility = function(role) {
    document.querySelectorAll("[data-role]").forEach(el => {
        const want = el.dataset.role;
        el.hidden = !(want === "any" || want === role);
    });
};

window.logout = function() {
    localStorage.removeItem(SESSION_KEY);
    window.CURRENT_USER = null;
    window.applyRoleVisibility(null);
    notifyRoleChange();
    showScreen("login");
};

// pengawas has its own restricted mini-home (just Daftar Inventaris +
// Laporan — see core.js's PENGAWAS_ALLOWED_SCREENS) instead of the
// normal Beranda dashboard everyone else lands on.
function landingScreen(role) {
    return role === "pengawas" ? "pengawas-home" : "menu";
}

$("logout-btn")?.addEventListener("click", () => {
    if (confirm("Akhiri sesi hari ini?")) window.logout();
});

/* Called once at boot (after splash). Restores an existing same-day
   session and lands the user on their home screen; returns false if
   there's no valid session, so core.js's boot() falls back to the
   login screen. */
window.restoreSession = function() {
    const s = readSession();
    if (!s) return false;
    window.CURRENT_USER = s;
    applyGreeting(s);
    window.applyRoleVisibility(s.role);
    notifyRoleChange();
    showScreen(landingScreen(s.role));
    return true;
};

/* ── Login Form ────────────────────────────────────────────── */
const form = $("login-form");
const errorEl = $("login-error");
const submitBtn = $("login-submit");

form?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const password = $("login-password").value.trim();
    errorEl.textContent = "";
    if (!password) return;

    submitBtn.disabled = true;
    try {
        const q = query(collection(db, "operators"), where("password", "==", password), limit(1));
        const snap = await getDocs(q);

        if (snap.empty) {
            errorEl.textContent = "Kata sandi salah.";
            return;
        }

        const d = snap.docs[0];
        const operator = { id: d.id, ...d.data() };
        if (operator.active === false) {
            errorEl.textContent = "Akun ini tidak aktif.";
            return;
        }

        const session = writeSession(operator);
        window.CURRENT_USER = session;
        applyGreeting(session);
        window.applyRoleVisibility(session.role);
        notifyRoleChange();
        form.reset();
        toast(`Selamat datang, ${session.name}`);
        showScreen(landingScreen(session.role));
    } catch (err) {
        console.error(err);
        errorEl.textContent = "Gagal login: " + err.message;
    } finally {
        submitBtn.disabled = false;
    }
});
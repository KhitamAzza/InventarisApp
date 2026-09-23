/* ════════════════════════════════════════════════════════════
   nav.js — bottom nav / sidebar, overflow drawer, greeting text.
   Presentation only: no Firebase or business logic lives here.
   Navigation itself (showScreen) still comes from core.js — this
   file just reacts to whichever screen becomes active and keeps
   the chrome (nav highlight, drawer) in sync.

   (The floating description card that used to sit above the bottom
   nav — repeating each screen's title/blurb — was removed: on
   mobile it sat over content, and every screen already has its own
   topbar with a title, so it was redundant there too.)
   ════════════════════════════════════════════════════════════ */

const $ = (id) => document.getElementById(id);
const drawer         = $("drawer");
const drawerBackdrop = $("drawer-backdrop");

function updateChrome(name) {
  // pengawas gets no bottom nav at all — their access is just the two
  // tiles on pengawas-home plus the drawer's "Keluar" (logout), same as
  // splash/login never having chrome either.
  const hideChrome = name === "splash" || name === "login" || window.CURRENT_USER?.role === "pengawas";
  document.body.classList.toggle("chrome-hidden", hideChrome);

  document.querySelectorAll(".bottom-nav-item").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.nav === name);
  });
}

/* re-run whenever core.js swaps the active screen, whether that
   came from a click or the splash → menu timeout in boot() */
document.querySelectorAll(".screen").forEach((screen) => {
  new MutationObserver(() => {
    if (screen.classList.contains("active")) {
      updateChrome(screen.id.replace("screen-", ""));
    }
  }).observe(screen, { attributes: true, attributeFilter: ["class"] });
});

/* overflow drawer open/close */
function openDrawer()  { drawer.classList.add("open");    drawerBackdrop.classList.add("show"); }
function closeDrawer() { drawer.classList.remove("open"); drawerBackdrop.classList.remove("show"); }

document.body.addEventListener("click", (e) => {
  if (e.target.closest("[data-drawer-open]"))  openDrawer();
  if (e.target.closest("[data-drawer-close]")) closeDrawer();
  if (e.target === drawerBackdrop)             closeDrawer();
  if (e.target.closest(".drawer [data-nav]"))  closeDrawer(); /* close after picking an item */
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeDrawer();
});

/* time-based greeting on Beranda (presentational only, no user data) */
function greetingText() {
  const h = new Date().getHours();
  if (h < 11) return "Selamat pagi,";
  if (h < 15) return "Selamat siang,";
  if (h < 19) return "Selamat sore,";
  return "Selamat malam,";
}
const greetEl = $("greeting-eyebrow");
if (greetEl) greetEl.textContent = greetingText();

/* initial state before splash hands off to the menu screen */
updateChrome("splash");
// Transient toast messages in the top-right.

let container = null;

export function initNotify() {
  container = document.getElementById("notify");
}

export function notify(msg) {
  if (!container) return;
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

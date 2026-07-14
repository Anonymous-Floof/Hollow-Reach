// World list + per-world save blobs, stored as .json files in the project's
// `worlds/` folder via the server's /api/world endpoints.
//
// Previously this used localStorage, which is keyed per-origin — and the origin
// includes the PORT. If the server ever bound to a different port (e.g. the old
// one was still running), the browser saw a fresh, empty store and your worlds
// appeared to vanish. Files on disk are shared no matter the port, so that whole
// class of bug is gone.

const LEGACY_INDEX = "hollowreach.worlds";
const LEGACY_WORLD = (id) => "hollowreach.world." + id;
const MIGRATED_FLAG = "hollowreach.migrated";

export function newId() {
  return "w" + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
}

// One-time copy of any pre-existing localStorage worlds into the worlds/ folder,
// so nothing is lost in the switch. Runs at most once per origin (guard flag),
// so a world you later delete from disk isn't resurrected.
let _migration = null;
function ensureMigrated() {
  if (_migration) return _migration;
  _migration = (async () => {
    try {
      if (localStorage.getItem(MIGRATED_FLAG)) return;
      const raw = localStorage.getItem(LEGACY_INDEX);
      const idx = raw ? JSON.parse(raw) : [];
      for (const w of idx) {
        const blob = localStorage.getItem(LEGACY_WORLD(w.id));
        if (blob) {
          await fetch("/api/world/" + encodeURIComponent(w.id), {
            method: "POST", headers: { "Content-Type": "application/json" }, body: blob,
          }).catch(() => {});
        }
      }
      localStorage.setItem(MIGRATED_FLAG, "1");
    } catch { /* localStorage unavailable or blocked — ignore */ }
  })();
  return _migration;
}

export async function listWorlds() {
  await ensureMigrated();
  try {
    const r = await fetch("/api/worlds");
    if (!r.ok) return [];
    const list = await r.json();
    return (list || []).filter((w) => w && w.id).sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  } catch {
    return [];
  }
}

export async function saveWorld(save) {
  try {
    const r = await fetch("/api/world/" + encodeURIComponent(save.id), {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(save),
    });
    return r.ok;
  } catch {
    return false;
  }
}

export async function loadWorld(id) {
  await ensureMigrated();
  try {
    const r = await fetch("/api/world/" + encodeURIComponent(id));
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

export async function deleteWorld(id) {
  try {
    await fetch("/api/world/" + encodeURIComponent(id), { method: "DELETE" });
  } catch { /* ignore */ }
}

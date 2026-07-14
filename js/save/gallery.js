// Screenshot + panorama gallery, stored client-side in IndexedDB (images are far
// too big for localStorage). Two object stores keep listing fast:
//   items : light metadata { id, kind, thumb, w, h, world, createdAt }
//   blobs : the heavy payload { id, data }  (screenshot) or { id, faces:[6] } (panorama)
// Listing reads only `items` (thumbnails); the full image/faces are fetched on
// demand. The current menu-background panorama lives in blobs under "__menu__".

const DB_NAME = "hollowreach-gallery";
const DB_VER = 1;
const MENU_ID = "__menu__";

let _dbP = null;
function db() {
  if (_dbP) return _dbP;
  _dbP = new Promise((res, rej) => {
    let rq;
    try { rq = indexedDB.open(DB_NAME, DB_VER); }
    catch (e) { rej(e); return; }
    rq.onupgradeneeded = () => {
      const d = rq.result;
      if (!d.objectStoreNames.contains("items")) d.createObjectStore("items", { keyPath: "id" });
      if (!d.objectStoreNames.contains("blobs")) d.createObjectStore("blobs", { keyPath: "id" });
    };
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });
  return _dbP;
}

// Run `fn(tx)` in one transaction and resolve when it commits (so multi-store
// writes are atomic — no awaiting between the puts, which would close the tx).
async function run(stores, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(stores, mode);
    t.oncomplete = () => res(t._out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || new Error("tx aborted"));
    fn(t);
  });
}
const genId = () => "g" + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);

export async function addScreenshot(data, thumb, w, h, world) {
  const id = genId();
  await run(["items", "blobs"], "readwrite", (t) => {
    t.objectStore("items").put({ id, kind: "screenshot", thumb, w, h, world, createdAt: Date.now() });
    t.objectStore("blobs").put({ id, data });
  });
  return id;
}

export async function addPanorama(faces, thumb, world) {
  const id = genId();
  await run(["items", "blobs"], "readwrite", (t) => {
    t.objectStore("items").put({ id, kind: "panorama", thumb, world, createdAt: Date.now() });
    t.objectStore("blobs").put({ id, faces });
  });
  return id;
}

// Light metadata for every gallery entry, newest first (excludes the menu slot).
export async function listItems() {
  return run(["items"], "readonly", (t) => {
    const r = t.objectStore("items").getAll();
    r.onsuccess = () => { t._out = (r.result || []).filter((x) => x.id !== MENU_ID).sort((a, b) => b.createdAt - a.createdAt); };
  });
}

export async function getBlob(id) {
  return run(["blobs"], "readonly", (t) => {
    const r = t.objectStore("blobs").get(id);
    r.onsuccess = () => { t._out = r.result || null; };
  });
}

export async function deleteItem(id) {
  await run(["items", "blobs"], "readwrite", (t) => {
    t.objectStore("items").delete(id);
    t.objectStore("blobs").delete(id);
  });
}

// The current menu-background panorama (six faces). Written on Save & Quit and
// when the player picks a panorama in the gallery; read at boot.
export async function setMenuPanorama(faces, meta = {}) {
  await run(["blobs"], "readwrite", (t) => {
    t.objectStore("blobs").put({ id: MENU_ID, faces, ...meta, savedAt: Date.now() });
  });
}
export async function getMenuPanorama() {
  const b = await getBlob(MENU_ID);
  return b && b.faces ? b.faces : null;
}

// Downscale a data URL to a small JPEG thumbnail (async). Fits within `size`.
export function makeThumb(dataURL, size = 360) {
  return new Promise((res) => {
    const img = new Image();
    img.onload = () => {
      const s = Math.min(size / img.width, size / img.height, 1);
      const w = Math.max(1, Math.round(img.width * s)), h = Math.max(1, Math.round(img.height * s));
      const c = document.createElement("canvas"); c.width = w; c.height = h;
      c.getContext("2d").drawImage(img, 0, 0, w, h);
      res(c.toDataURL("image/jpeg", 0.72));
    };
    img.onerror = () => res(dataURL);
    img.src = dataURL;
  });
}

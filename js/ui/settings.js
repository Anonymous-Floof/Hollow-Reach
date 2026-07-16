// Schema-driven settings. To add a setting in the future, append one row to
// SCHEMA — the UI, persistence and Settings.get() all pick it up automatically.

const STORE_KEY = "hollowreach.settings";

// Graphics-quality presets drive the resource-heavy renderer knobs (internal
// render scale + effect sample counts + shadow-map resolution). Individual
// effect toggles below gate features on/off within whatever tier is selected.
export const QUALITY_PRESETS = {
  Low:    { scale: 0.75, ssaoSamples: 8,  godraySamples: 24, ssrSteps: 0,  shadowSize: 0,    cloudSteps: 10 },
  Medium: { scale: 1.0,  ssaoSamples: 12, godraySamples: 40, ssrSteps: 16, shadowSize: 1024, cloudSteps: 14 },
  High:   { scale: 1.0,  ssaoSamples: 16, godraySamples: 48, ssrSteps: 24, shadowSize: 2048, cloudSteps: 22 },
  Ultra:  { scale: 1.0,  ssaoSamples: 24, godraySamples: 64, ssrSteps: 40, shadowSize: 4096, cloudSteps: 34 },
};

export const SCHEMA = [
  { key: "renderDistance", label: "Render Distance", type: "slider", min: 3, max: 12, step: 1, def: 7, category: "Graphics" },
  { key: "fov", label: "Field of View", type: "slider", min: 50, max: 100, step: 1, def: 70, category: "Graphics" },
  { key: "graphicsQuality", label: "Graphics Quality", type: "select", options: ["Low", "Medium", "High", "Ultra"], def: "High", category: "Graphics" },
  { key: "ambientOcclusion", label: "Ambient Occlusion (SSAO)", type: "toggle", def: true, category: "Graphics" },
  { key: "godRays", label: "God Rays (sun shafts)", type: "toggle", def: true, category: "Graphics" },
  { key: "waterReflections", label: "Water Reflections (SSR)", type: "toggle", def: true, category: "Graphics" },
  { key: "castShadows", label: "Cast Shadows (sun)", type: "toggle", def: true, category: "Graphics" },
  { key: "clouds", label: "Volumetric Clouds", type: "toggle", def: true, category: "Graphics" },
  { key: "cloudShadows", label: "Cloud Shadows", type: "toggle", def: true, category: "Graphics" },
  { key: "menuPanorama", label: "Menu Panorama Background", type: "toggle", def: true, category: "Graphics" },
  { key: "sensitivity", label: "Mouse Sensitivity", type: "slider", min: 1, max: 30, step: 1, def: 12, category: "Controls" },
  { key: "invertY", label: "Invert Vertical Look", type: "toggle", def: false, category: "Controls" },
  { key: "fallDamage", label: "Take Fall Damage", type: "toggle", def: true, category: "Gameplay" },
  { key: "hunger", label: "Hunger", type: "toggle", def: true, category: "Gameplay" },
  { key: "monsters", label: "Spawn Monsters", type: "toggle", def: true, category: "Gameplay" },
  { key: "flight", label: "Allow Flight (double-tap Space)", type: "toggle", def: true, category: "Gameplay" },
  { key: "highStep", label: "High Step (walk up full blocks)", type: "toggle", def: false, category: "Gameplay" },
  { key: "minimap", label: "Minimap (needs the Atlas · N)", type: "toggle", def: true, category: "Gameplay" },
  { key: "deathWaypoints", label: "Death Waypoints on the Atlas", type: "toggle", def: true, category: "Gameplay" },
  { key: "masterVolume", label: "Master Volume", type: "slider", min: 0, max: 100, step: 1, def: 80, category: "Audio" },
  { key: "sfxVolume", label: "Effects Volume", type: "slider", min: 0, max: 100, step: 1, def: 80, category: "Audio" },
  { key: "ambientVolume", label: "Ambience Volume", type: "slider", min: 0, max: 100, step: 1, def: 40, category: "Audio" },
  { key: "uiVolume", label: "Interface Volume", type: "slider", min: 0, max: 100, step: 1, def: 50, category: "Audio" },
];

class SettingsStore {
  constructor() {
    this.values = {};
    for (const s of SCHEMA) this.values[s.key] = s.def;
    this.load();
  }
  load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) Object.assign(this.values, JSON.parse(raw));
    } catch { /* ignore */ }
  }
  persist() { localStorage.setItem(STORE_KEY, JSON.stringify(this.values)); }
  get(key) { return this.values[key]; }
  set(key, val) { this.values[key] = val; this.persist(); }
}

export const Settings = new SettingsStore();

// Remember which tab was open across settings-screen visits (module-scoped so it
// survives close/reopen but resets on reload).
let activeTab = null;

// Build the tabbed settings UI into `container`. onChange(key, value) fires live.
// One tab per category; the active tab's rows render into a scrollable panel so
// the card can't grow past the viewport no matter how many settings we add.
export function renderSettings(container, onChange) {
  container.innerHTML = "";
  const cats = [...new Set(SCHEMA.map((s) => s.category))];
  if (!cats.includes(activeTab)) activeTab = cats[0];

  const tabs = document.createElement("div");
  tabs.className = "settings-tabs";
  const panel = document.createElement("div");
  panel.className = "settings-panel";

  const renderPanel = () => {
    panel.innerHTML = "";
    const group = document.createElement("div");
    group.className = "settings-group";
    for (const s of SCHEMA.filter((x) => x.category === activeTab)) {
      group.appendChild(buildRow(s, onChange));
    }
    panel.appendChild(group);
  };

  for (const cat of cats) {
    const tab = document.createElement("button");
    tab.className = "settings-tab" + (cat === activeTab ? " active" : "");
    tab.textContent = cat;
    tab.onclick = () => {
      if (activeTab === cat) return;
      activeTab = cat;
      for (const t of tabs.children) t.classList.toggle("active", t === tab);
      renderPanel();
    };
    tabs.appendChild(tab);
  }

  container.appendChild(tabs);
  container.appendChild(panel);
  renderPanel();
}

function buildRow(s, onChange) {
  const row = document.createElement("div");
  row.className = "setting";
  const label = document.createElement("span");
  label.className = "label";
  label.textContent = s.label;
  row.appendChild(label);

  if (s.type === "slider") {
    const wrap = document.createElement("div");
    wrap.className = "row";
    const input = document.createElement("input");
    input.type = "range";
    input.min = s.min; input.max = s.max; input.step = s.step;
    input.value = Settings.get(s.key);
    const val = document.createElement("span");
    val.className = "val";
    val.textContent = input.value;
    input.oninput = () => {
      const v = Number(input.value);
      val.textContent = v;
      Settings.set(s.key, v);
      onChange && onChange(s.key, v);
    };
    wrap.appendChild(input);
    wrap.appendChild(val);
    row.appendChild(wrap);
  } else if (s.type === "select") {
    const sel = document.createElement("select");
    sel.className = "btn small";
    for (const opt of s.options) {
      const o = document.createElement("option");
      o.value = opt; o.textContent = opt;
      if (Settings.get(s.key) === opt) o.selected = true;
      sel.appendChild(o);
    }
    sel.onchange = () => {
      Settings.set(s.key, sel.value);
      onChange && onChange(s.key, sel.value);
    };
    row.appendChild(sel);
  } else if (s.type === "toggle") {
    const btn = document.createElement("button");
    btn.className = "btn small";
    const refresh = () => { btn.textContent = Settings.get(s.key) ? "On" : "Off"; };
    refresh();
    btn.onclick = () => {
      Settings.set(s.key, !Settings.get(s.key));
      refresh();
      onChange && onChange(s.key, Settings.get(s.key));
    };
    row.appendChild(btn);
  }
  return row;
}

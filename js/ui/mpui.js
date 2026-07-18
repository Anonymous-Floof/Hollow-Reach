// Multiplayer UI: the pause-menu Host panel, the main-menu Join flow, and the
// floating nameplates over remote players.
//
// The connection dance is copy-paste signaling (see net/signal.js):
//   host: Create Invite -> send the code to a friend (any chat app)
//   friend: paste it -> gets a reply code -> sends it back
//   host: paste the reply -> Accept -> the friend drops into the world.
//
// SECURITY: every string that came from (or via) the network — player names,
// world names, codes — only ever reaches the DOM through textContent / value.

import { notify } from "./notify.js";
import { getPlayerName, setPlayerName } from "../net/protocol.js";
import { getRelayConfig, setRelayConfig } from "../net/transport.js";

// ---------- host panel (rendered into the pause menu root) ----------
export function renderHostPanel(root, game, onBack) {
  const refresh = () => renderHostPanel(root, game, onBack);
  game._mpRefresh = refresh;

  root.innerHTML = "";
  const wrap = el("div", "mp-panel");

  if (game.meta && game.meta.remote) {
    wrap.appendChild(el("p", "mp-note", "You are a guest in this world — only the host can invite players."));
    wrap.appendChild(btn("Back", "btn", onBack));
    root.appendChild(wrap);
    return;
  }

  if (!game.net) {
    wrap.appendChild(el("p", "mp-note",
      "Host this world so friends can join you. They connect straight to your browser — nothing runs on a server. Everyone needs the same game version."));
    const nameRow = el("div", "mp-field");
    nameRow.appendChild(el("label", "field", "Your player name"));
    const nameIn = document.createElement("input");
    nameIn.type = "text"; nameIn.maxLength = 20; nameIn.value = getPlayerName();
    nameRow.appendChild(nameIn);
    wrap.appendChild(nameRow);
    wrap.appendChild(btn("Start Hosting", "btn primary", () => {
      setPlayerName(nameIn.value);
      game.startHosting();
      refresh();
    }));
    wrap.appendChild(relaySection());
    wrap.appendChild(btn("Back", "btn", onBack));
    root.appendChild(wrap);
    return;
  }

  // ---- hosting: roster + invite flow ----
  const net = game.net;
  wrap.appendChild(el("h3", "mp-head", "Hosting — players"));
  const list = el("div", "mp-roster");
  list.appendChild(rosterRow(getPlayerName() + " (you)", null));
  for (const p of net.roster()) {
    list.appendChild(rosterRow(p.name, () => { net.kick(p.pid); setTimeout(refresh, 400); }));
  }
  wrap.appendChild(list);

  const inviteBox = el("div", "mp-invite");
  wrap.appendChild(inviteBox);
  wrap.appendChild(btn("Create Invite Code", "btn primary", async (b) => {
    b.disabled = true; b.textContent = "Creating…";
    try {
      const { state, code } = await net.createInvite();
      inviteBox.innerHTML = "";
      inviteBox.appendChild(el("label", "field", "1 — Send this invite code to your friend"));
      inviteBox.appendChild(codeArea(code, true));
      inviteBox.appendChild(copyBtn(code));
      inviteBox.appendChild(el("label", "field", "2 — Paste their reply code here"));
      const replyIn = codeArea("", false);
      inviteBox.appendChild(replyIn);
      const accept = btn("Accept Reply", "btn primary", async (ab) => {
        ab.disabled = true; ab.textContent = "Connecting…";
        try {
          await net.acceptAnswer(state, replyIn.value);
          inviteBox.innerHTML = "";
          inviteBox.appendChild(el("p", "mp-note", "Connecting — they'll appear in the list in a moment."));
        } catch (err) {
          ab.disabled = false; ab.textContent = "Accept Reply";
          notify(err && err.message ? err.message : "That code didn't work");
        }
      });
      inviteBox.appendChild(accept);
      inviteBox.appendChild(btn("Cancel Invite", "btn small", () => { net.cancelInvite(state); inviteBox.innerHTML = ""; refresh(); }));
    } catch (err) {
      notify(err && err.message ? err.message : "Could not create an invite");
    }
    b.disabled = false; b.textContent = "Create Invite Code";
  }));

  wrap.appendChild(btn("Stop Hosting", "btn danger", () => {
    game.stopHosting();
    refresh();
  }));
  wrap.appendChild(relaySection());
  wrap.appendChild(btn("Back", "btn", onBack));
  root.appendChild(wrap);
}

// ---------- relay (TURN) settings ----------
// Strict/symmetric-NAT router pairs can't hole-punch a direct path; a TURN
// relay is the standard fix. There's no reliable free public relay to bake in,
// so players who need one paste credentials from a free provider account
// (metered.ca, expressturn.com, …) — a web sign-up, nothing to install. Only
// ONE side of a connection needs a relay configured. Applies to new
// invites/joins after saving.
function relaySection() {
  const details = document.createElement("details");
  details.className = "mp-relay";
  const summary = document.createElement("summary");
  const saved = getRelayConfig();
  summary.textContent = saved ? "Relay server (configured ✓)" : "Relay server (optional — for strict routers)";
  details.appendChild(summary);

  const note = el("p", "mp-note",
    "Can't connect to a friend even though both codes worked? One of your routers " +
    "is likely blocking direct paths (symmetric NAT). Fix: a TURN relay — make a free " +
    "account at a provider like expressturn.com or metered.ca (web sign-up, nothing to " +
    "install), then paste the address plus the username and credential it gives you. " +
    "All three are needed — a relay refuses connections without valid credentials. " +
    "Only one of you needs this, and the relay only ever carries the encrypted stream.");
  details.appendChild(note);

  const mk = (label, value, placeholder) => {
    details.appendChild(el("label", "field", label));
    const i = document.createElement("input");
    i.type = "text"; i.spellcheck = false; i.value = value || ""; i.placeholder = placeholder;
    details.appendChild(i);
    return i;
  };
  const urlsIn = mk("Relay address (server:port — several may be comma-separated)",
    saved ? saved.urls.join(", ") : "", "free.expressturn.com:3478");
  const userIn = mk("Username", saved ? saved.username : "", "from your provider account");
  const credIn = mk("Credential", saved ? saved.credential : "", "from your provider account");

  const status = el("p", "mp-note", "");
  const showStatus = (cfg) => {
    status.textContent = cfg
      ? `In use: ${cfg.urls.join(", ")}${cfg.username ? "" : " — no username set, most relays need one"}`
      : "";
  };
  showStatus(saved);

  details.appendChild(btn("Save Relay", "btn small", () => {
    const typed = urlsIn.value.trim();
    const cfg = setRelayConfig(urlsIn.value, userIn.value, credIn.value);
    if (typed && !cfg) {
      notify("That doesn't look like a relay address — use server:port, e.g. free.expressturn.com:3478");
      return;
    }
    summary.textContent = cfg ? "Relay server (configured ✓)" : "Relay server (optional — for strict routers)";
    showStatus(cfg);
    // reflect what was actually stored, so the normalised form is visible
    if (cfg) urlsIn.value = cfg.urls.join(", ");
    notify(cfg ? "Relay saved — used for new connections" : "Relay cleared");
  }));
  details.appendChild(status);
  return details;
}

function rosterRow(name, onKick) {
  const row = el("div", "mp-player");
  row.appendChild(el("span", "mp-pname", name));
  if (onKick) {
    const k = btn("Kick", "btn small danger", onKick);
    row.appendChild(k);
  }
  return row;
}

// ---------- join flow (rendered into the main menu root) ----------
export function renderJoinPanel(root, game, onBack) {
  root.innerHTML = "";
  const wrap = el("div", "mp-panel");
  wrap.appendChild(el("p", "mp-note",
    "Join a friend's world. Ask them to Pause → Multiplayer → Create Invite Code, paste it below, then send back the reply code it gives you."));

  wrap.appendChild(el("label", "field", "Your player name"));
  const nameIn = document.createElement("input");
  nameIn.type = "text"; nameIn.maxLength = 20; nameIn.value = getPlayerName();
  wrap.appendChild(nameIn);

  wrap.appendChild(el("label", "field", "Friend's invite code"));
  const inviteIn = codeArea("", false);
  wrap.appendChild(inviteIn);

  const replyBox = el("div", "mp-invite");
  let client = null;

  const goBtn = btn("Generate Reply Code", "btn primary", async (b) => {
    const code = inviteIn.value.trim();
    if (!code) { notify("Paste the invite code first"); return; }
    b.disabled = true; b.textContent = "Working…";
    try {
      const name = setPlayerName(nameIn.value);
      client = game.createJoinClient(name);
      const reply = await client.answerInvite(code);
      replyBox.innerHTML = "";
      replyBox.appendChild(el("label", "field", "Send this reply code back to the host"));
      replyBox.appendChild(codeArea(reply, true));
      replyBox.appendChild(copyBtn(reply));
      replyBox.appendChild(el("p", "mp-note", "Waiting for the host to accept… the world will open by itself."));
      b.remove();
    } catch (err) {
      if (client) { client.dispose(false); client = null; }
      b.disabled = false; b.textContent = "Generate Reply Code";
      notify(err && err.message ? err.message : "That invite code didn't work");
    }
  });
  wrap.appendChild(goBtn);
  wrap.appendChild(replyBox);
  wrap.appendChild(relaySection());
  wrap.appendChild(btn("Back", "btn", () => {
    if (client && !game.net) client.dispose(false);   // abandon a half-done join
    onBack();
  }));
  root.appendChild(wrap);
}

// ---------- nameplates ----------
// Small DOM labels projected over remote players' heads. All text lands via
// textContent; labels are pooled per player id.
export class Nameplates {
  constructor() {
    this.root = null;
    this.tags = new Map();   // pid -> div
  }
  _ensureRoot() {
    if (this.root) return;
    this.root = document.createElement("div");
    this.root.id = "nameplates";
    document.getElementById("ui").appendChild(this.root);
  }
  // players: GhostWorld.players (pid -> { e, name })
  update(viewProj, players, w, h) {
    if (!players || players.size === 0) { this.clear(); return; }
    this._ensureRoot();
    const seen = new Set();
    for (const [pid, g] of players) {
      const e = g.e;
      if (e.dead) continue;
      const x = e.pos[0], y = e.pos[1] + e.h + 0.35, z = e.pos[2];
      const cw = viewProj[3] * x + viewProj[7] * y + viewProj[11] * z + viewProj[15];
      if (cw <= 0.1) continue;   // behind the camera
      const cx = (viewProj[0] * x + viewProj[4] * y + viewProj[8] * z + viewProj[12]) / cw;
      const cy = (viewProj[1] * x + viewProj[5] * y + viewProj[9] * z + viewProj[13]) / cw;
      if (cx < -1.1 || cx > 1.1 || cy < -1.1 || cy > 1.1) continue;
      seen.add(pid);
      let tag = this.tags.get(pid);
      if (!tag) {
        tag = document.createElement("div");
        tag.className = "nameplate";
        this.root.appendChild(tag);
        this.tags.set(pid, tag);
      }
      if (tag.textContent !== g.name) tag.textContent = g.name;
      const dist = Math.max(1, cw);
      tag.style.opacity = dist > 48 ? "0" : dist > 36 ? "0.5" : "1";
      tag.style.transform = `translate(-50%, -100%) translate(${((cx + 1) / 2 * w) | 0}px, ${((1 - cy) / 2 * h) | 0}px)`;
    }
    for (const [pid, tag] of this.tags) {
      if (!seen.has(pid)) { tag.remove(); this.tags.delete(pid); }
    }
  }
  clear() {
    for (const tag of this.tags.values()) tag.remove();
    this.tags.clear();
  }
}

// ---------- tiny DOM helpers ----------
function el(tag, cls, text) {
  const d = document.createElement(tag);
  if (cls) d.className = cls;
  if (text !== undefined) d.textContent = text;
  return d;
}
function btn(label, cls, onClick) {
  const b = document.createElement("button");
  b.className = cls;
  b.textContent = label;
  b.onclick = () => onClick(b);
  return b;
}
function codeArea(value, readonly) {
  const t = document.createElement("textarea");
  t.className = "mp-code";
  t.value = value;
  t.spellcheck = false;
  if (readonly) { t.readOnly = true; t.onclick = () => t.select(); }
  else t.placeholder = "paste code here";
  return t;
}
function copyBtn(text) {
  return btn("Copy Code", "btn small", async (b) => {
    try {
      await navigator.clipboard.writeText(text);
      b.textContent = "Copied ✓";
    } catch {
      b.textContent = "Select the box and copy manually";
    }
    setTimeout(() => { b.textContent = "Copy Code"; }, 1600);
  });
}

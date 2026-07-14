# Hollowreach — a handcrafted voxel sandbox

A 3D first-person Minecraft-like, built from scratch in the browser: its **own
WebGL2 voxel engine, procedural world, procedural textures and item models**, with
**zero external libraries**. First iteration focuses on a complete core loop —
mine, smelt, craft, tier up tools/armour, build — and **persistent, shareable worlds**.

## Running it

**Double-click `run.bat`.** It starts a tiny local Python server (ES modules can't
load over `file://`) and opens your browser automatically. That's it — no terminal
navigation.

Requirements: Python 3 (any recent version) and a browser with WebGL2 (recent
Chrome, Edge, or Firefox). To stop the server, close its window or press Ctrl+C.

## Controls

| | |
|---|---|
| Move | WASD |
| Look | Mouse |
| Jump / swim up | Space |
| Sprint (1.3×) | Hold Left Ctrl while moving |
| Fly (toggle) | Double-tap Space |
| Sneak (slow) | Left Shift |
| Break block / attack | Left mouse (hold) |
| Place / use station / open door / sleep / **eat** | Right mouse |
| Drop item | Q (one) · Ctrl+Q (whole stack) |
| Climb ladder | Walk into it + W/Space (Shift = down) |
| Select hotbar | 1–9 / scroll |
| Inventory | E |
| Recipe book | R |
| Pause | Esc |
| Debug overlay | F3 |

**Bed** — craft from 3 planks + 3 loam, place it (it lays out two cells, pillow
always at the head whichever way you face), then right-click at night to
fast-forward to morning. Sleeping advances the actual game clock, so
time-of-day mechanics (like grass spreading) move forward while you sleep. **Boat** —
craft from 5 planks, right-click to set it on water (or ground); right-click it
to ride (look where you want to go, W/S throttle, A/D strafe), **Shift** to
dismount, and left-click an empty boat to pick it back up.

While you're in a world, browser shortcuts (reload, new/close/switch tab,
bookmark, find, print, save, history, downloads, back/forward, zoom — including
**Ctrl+scroll** page zoom) are swallowed so a stray key can't yank you out or
zoom the page while you sprint-scroll — and closing the tab asks first. Going
fullscreen (F11) lets the game capture even the reserved combos.

**Inventory (Mouse-Tweaks style):** Left-click picks up / places a stack,
right-click takes half / places one. **Shift-click** instantly moves a stack to
the other container (inventory ↔ chest/forge, hotbar ↔ storage). Hold **left**
and drag across slots to split a held stack evenly; hold **right** and drag to
drop one per slot. **Scroll** on a slot to nudge single items across. Hover any
item for its name and stats.

In water you swim: you sink slowly, hold **Space** to rise (and swim into a
shore to climb out), or **Left Shift** to dive. Soft blocks (grass, dirt, wood,
sand) drop when mined by hand — only stone, ores and other hard blocks require
the right tool tier — and a tool only mines faster for the block class it's
*meant* for. Chop all of a tree's logs and its leaves decay on their own.
**Grass creeps**: exposed dirt that's lit and next to grass slowly turns to
grass over in-game days (so a dug-out patch heals over, and beds let you watch it).

**Animals:** wild **sheep** and **pigs** wander the grass in daylight. Left-click
to attack (a sword hits hardest). A sheep drops a block of **white wool** (which,
with planks, crafts a **bed**); a pig drops a **Raw Porkchop** — eat it for a
little food, or smelt it into a **Cooked Porkchop** that fills more. Both animals
climb hills and steer clear of water, so they stay on dry land instead of drowning.

**Monsters:** **zombies** rise on solid ground after dark and shamble toward you
once they spot you, clawing for damage when they reach you (armour softens the
blow). They burn away in direct sunlight, so they're a night-time threat — hole
up or fight back. A slain zombie drops **rotten flesh** (edible, but a gamble —
it might feed you a point or sicken you for two). Like the animals they climb
1-block ledges and won't wade into the sea. (Turn them off in Settings.)

**Survival:** a **hunger** bar (next to your hearts) slowly drains as you live and
act — sprinting and swimming burn it faster. Eat to refill it; when it empties you
**starve** and lose health until you eat. You only regenerate health while
well-fed. Hold your breath underwater: a row of **bubbles** counts down once your
head is submerged, and when they run out you start to **drown**. (Hunger can be
toggled off in Settings; breath/drowning is always on.) Taking a hit now also
**wears your armour** — it soaks damage and loses durability for it.

**Atmosphere:** the world breathes a little. A real **sun** and **moon** arc across
the sky (the sun rises in the east), the night fills with a sparse, twinkling
**star field**, and **dawn rolls in thick fog** that burns off as the morning
brightens. **Leaves sway** and the **water surface ripples** with a gentle noisy
motion, and the camera does a soft **head-bob** as you walk (more when you sprint),
with your held item swaying along — all of it driven on the GPU so it costs almost
nothing.

**Building blocks:** **stairs**, **slabs** and **vertical slabs** can be cut
from *any* wood, sandstone or stone — including the polished and brick
sub-variants — so every material has a matching step and half-block. Stairs and
slabs read where you aim: click a block's top for a bottom slab / right-way-up
stair, its underside (or the upper half of a side) for a **top slab / upside-down
stair**. A slab crafts into a **vertical slab** (and back) for thin walls. Each
**wood type makes its own doors, trapdoors, stairs and slabs**, and any wood's
planks work for sticks, the workbench, chests, beds and boats (even mixed).
Ladders, trapdoors and doors place facing you; doors and trapdoors toggle on
right-click. Beyond Stone and Oak there are two more stone families
(**Umberstone**, **Slatestone**, each with polished + brick forms) and two more
woods (**Pine**, **Walnut**) that generate naturally — stone in underground
blobs, the woods as their own trees. **Torches** angle correctly when set on a
wall, and show as a flat sprite in hand and when dropped. **Chests** store 27
stacks; **forges keep smelting with the UI closed** and both keep their contents
until you mine them. Out of Coal? **Smelt logs into Charcoal** — it burns and
crafts torches just like Coal. **Anything wooden burns as forge fuel** — logs,
planks (any wood type), wooden tools, chests, boats, even torches — and the burn
time is read straight from the item's recipe, so it scales with how much wood
went in (no per-item bookkeeping).

**Recipe book (press R):** categorised tabs (Building / Tools / Armour /
Materials / Smelting), a fuzzy **search** box, and grouped cards — near-identical
recipes (every stairs material, every pickaxe tier, a torch's two fuels) collapse
into one card you cycle with the **‹ ›** arrows. Hover any ingredient or result
for the same detailed tooltip the inventory shows (tool tier, mining speed,
durability, armour defense, fuel time).

## The gameplay loop

1. Punch **Oak** trees → logs → **planks** → **sticks** → a **Workbench**.
2. Mine stone with a wood pick for **Cobblestone** → build a **Forge**.
3. Mine ores; smelt **Raw Copper / Iron / Gold** into ingots at the Forge
   (fuel: Coal, logs, planks).
4. Climb tool & armour tiers: Wooden → Stone → Copper → Iron → Gold (fast,
   fragile) → **Diamond**. Each tier unlocks the next ore (e.g. only an Iron+
   pick harvests Diamond).
5. Craft **Torches** to light caves; build with planks, bricks, polished stone,
   sandstone and glass.

Worlds are saved as plain `.json` files in the **`worlds/` folder** next to
`run.bat` (the server reads/writes them over a small `/api/world` endpoint).
This means they're shared no matter which port the server happens to use — unlike
browser storage, which is per-port and used to make worlds seem to vanish. Any
worlds you had in older (localStorage) builds are migrated into `worlds/`
automatically the first time you open the world list. You can still **export a
`.world` file** to share with friends (Pause → Export World; import from the
world-select screen).

## Architecture (built to be extended)

Everything is a small ES module under `js/`, grouped by concern:

- `core/` — WebGL context, shaders, matrix math, seeded RNG, input.
- `world/` — `blocks.js` (the master data table), `noise.js`, `worldgen.js`
  (terrain/caves/ores/trees), `chunk.js`, `mesher.js`, `lighting.js`, `world.js`
  (chunk streaming + GL buffers), `genpool.js` + `genworker.js` (threaded gen).
- `render/` — `texatlas.js` (procedural textures), `sky.js` (day/night), `renderer.js`.
- `game/` — `player.js`, `physics.js` (shared swept-AABB collision), `raycast.js`,
  `interact.js`, `items.js`, `inventory.js`, `recipes.js`, `crafting.js`,
  `entities/` (entity framework: `registry.js`, `manager.js`, and one def per
  kind — `drop.js`, `boat.js`).
- `render/` — `texatlas.js`, `sky.js`, `renderer.js`, `entityrenderer.js`.
- `ui/` — `menu.js`, `hud.js`, `inventoryui.js`, `recipebook.js`, `settings.js`, `notify.js`.

**Entities:** a small, data-driven framework (`game/entities/`) mirroring the
block/item/recipe tables. `world.entities` (an `EntityManager`) owns instances;
each dispatches lifecycle hooks (`update`, `onInteract`, `serialize`) to its type
definition, and shares the player's collision (`game/physics.js`). Player and
entities are both just a `body{pos,hw,h}`. The first entity is the **item drop**:
mined blocks and spilled container contents pop out as drops that are vacuumed
into your inventory the moment there's room (so mining feels instant) and only
linger physically when it's full. The **boat** (`boat.js`) is the first
*rideable*: it floats on water via a buoyancy spring, carries the player in its
seat, steers toward your look direction, and breaks back into an item. Entities
are saved with the world. The framework reserves the remaining hook slots (AI,
tether/anchor, health) for future mobs and fishing-rod bobbers / leashes — those
add a *definition*,
not engine plumbing.

**Threaded generation:** terrain generation runs on a pool of Web Workers
(`genpool.js` → `genworker.js`), so streaming new or loaded chunks never stalls
the render loop. `worldgen.js` was always a pure function of `(chunk, seed)` with
no DOM/GL — which is exactly what makes it safe to run off-thread. The spawn area
is still generated synchronously so you never fall through on load. Lighting and
meshing remain main-thread but are count-budgeted per frame; the same pool
pattern is the intended home for future threaded lighting / AI.
- `save/` — `serialize.js`, `storage.js`, `migrate.js`, `transfer.js`.

### Common extension points

- **New block:** add one entry to `js/world/blocks.js` and a matching painter in
  `js/render/texatlas.js`. Saves stay valid because blocks are stored by stable
  string key, not numeric id.
- **New recipe:** add a row to `js/game/recipes.js`. It appears in the in-game
  Recipe Book (press **R**) automatically — the browser is generated from the data.
- **New entity** (mob, boat, projectile…): add a definition to
  `js/game/entities/` and register it in `registry.js` — give it a `size`, set
  `physics`, and implement the hooks you need (`update`, `onInteract`, …).
- **New setting:** add a row to `SCHEMA` in `js/ui/settings.js` — the UI and
  persistence pick it up automatically.
- **Save format change:** bump `SAVE_VERSION` in `js/save/serialize.js` and add a
  migration function in `js/save/migrate.js` (`vN → vN+1`).

## Deliberately deferred (foundation already in place)

More mobs & deeper combat (sheep, pigs and zombies are in — passive animals and
the first monster), more foods & farming (hunger, eating and cooking are in),
multiple biomes, Web-Worker *meshing* (generation is already threaded), greedy
meshing, fully smooth global lighting, dropped-item entities, audio, Sparkstone
tech, multiplayer.

The health + fall-damage system is wired in (toggle in Settings) as the seed for a
future full survival mode — armour defense already feeds it.

# Changelog

All notable changes to Hollowreach are recorded here, newest first.

The format follows [Keep a Changelog](https://keepachangelog.com/) and the
version numbers follow [Semantic Versioning](https://semver.org/):
**MAJOR** for big milestones or compatibility breaks, **MINOR** for content and
feature updates, **PATCH** for fixes and tuning.

`tools/release.py` reads this file: whatever sits under a version's heading
becomes the GitHub release notes for that version, so write entries for
players, not for the git log. Day-to-day changes go under **[Unreleased]**;
`python tools/release.py bump <major|minor|patch>` moves them under a new
version heading when it's time to ship.

## [Unreleased]

## [1.0.0] - 2026-07-19

First public release. Hollowreach is a voxel sandbox that runs entirely in the
browser — no engine, no libraries, no build step — served by a tiny local
Python script. Highlights of everything on board at 1.0:

### World
- Procedural infinite terrain with biomes, caves, ravines, ores (including
  Gloamite and Verdanite), trees, and 12 kinds of foliage and flowers.
- Terrain generation is versioned: old worlds keep their exact shape when the
  generator improves.
- Flowing water with source/spread/recede mechanics, currents that push you,
  and swimming/drowning.
- Day/night cycle with ray-traced sky, sun, moon, and stars; volumetric clouds
  with moving cloud shadows.

### Gameplay
- Mining, building, crafting (workbench + forge with fuel and smelting), chests,
  doors, ladders, beds with sleep-to-morning, and a recipe book (R).
- Survival systems: health, hunger, eating, armour, fall damage, drowning.
- Mobs: sheep (wool), pigs (pork), cows (milk), and zombies with real
  line-of-sight, memory, and A* pathfinding.
- Boats, the Atlas world map with fog-of-war and waypoints (M / minimap N),
  and the Wayshard warp item.
- File-backed world saves with versioned migrations — old saves keep working.

### Multiplayer
- Peer-to-peer co-op straight between browsers: copy-paste invite codes, no
  account, no game server. Optional TURN relay support for strict routers.
- Host-authoritative with client-side prediction: movement, building, combat,
  containers, sleeping, and mobs all sync.

### Graphics
- Deferred renderer (WebGL2): smooth lighting, coloured point lights, cast
  shadows, SSAO, god rays, and screen-space water reflections.
- Leaf sway, water ripple, walking camera bob, and quality presets from Low to
  Ultra in a tabbed settings menu.

### Audio
- Fully synthesised sound — every effect is generated in the browser with the
  Web Audio API: footsteps by surface, mob voices, breaking/placing by
  material, wind, birds, crickets, cave ambience, and underwater muffling.

### Platforms
- Windows (`run.bat`) and Linux/macOS (`run.sh`) launchers; the only
  requirements are Python 3 and a WebGL2 browser.

[Unreleased]: https://github.com/Anonymous-Floof/Hollow-Reach/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/Anonymous-Floof/Hollow-Reach/releases/tag/v1.0.0

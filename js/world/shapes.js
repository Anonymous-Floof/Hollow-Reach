// Geometry for non-cube blocks, expressed as axis-aligned boxes in block-local
// [0,1] space. The same boxes drive both meshing (render) and collision. Shapes
// are keyed by a block's render type; orientation/state comes from its metadata.
//
// Metadata layout per render type:
//   stair    : bits 0-1 = facing (0:+x 1:-x 2:+z 3:-z), bit2 = upside-down (top half)
//   slab     : bit0 = top half
//   vslab    : bits 0-1 = which half (0:-x 1:+x 2:-z 3:+z)
//   ladder   : bits 0-1 = wall it hugs (0:+x 1:-x 2:+z 3:-z)
//   trapdoor : bit0 = open, bit1 = top half, bits 2-3 = facing (open swing wall)
//   door     : bit0 = open, bit1 = upper half, bits 2-3 = facing (front)

export const SHAPED = new Set(["stair", "slab", "vslab", "ladder", "trapdoor", "door", "bed"]);

const SLAB_BOTTOM = [0, 0, 0, 1, 0.5, 1];
const SLAB_TOP = [0, 0.5, 0, 1, 1, 1];   // upper-half slab (meta bit0 = 1)
const BED_BOX = [0, 0, 0, 1, 0.56, 1];   // a low slab you can lie/stand on

// Stairs: the slab half + the raised step opposite it. bit2 flips it upside-down.
function stairBoxes(meta) {
  const f = meta & 3, top = (meta >> 2) & 1;
  const slab = top ? SLAB_TOP : SLAB_BOTTOM;
  const sy0 = top ? 0 : 0.5, sy1 = top ? 0.5 : 1;   // step sits opposite the slab
  const step =
    f === 0 ? [0.5, sy0, 0, 1, sy1, 1] :
    f === 1 ? [0, sy0, 0, 0.5, sy1, 1] :
    f === 2 ? [0, sy0, 0.5, 1, sy1, 1] :
              [0, sy0, 0, 1, sy1, 0.5];
  return [slab, step];
}

// Vertical slab: half a block along one horizontal axis, full height.
function vslabBoxes(meta) {
  switch (meta & 3) {
    case 0: return [[0, 0, 0, 0.5, 1, 1]];   // -x half
    case 1: return [[0.5, 0, 0, 1, 1, 1]];   // +x half
    case 2: return [[0, 0, 0, 1, 1, 0.5]];   // -z half
    default: return [[0, 0, 0.5, 1, 1, 1]];  // +z half
  }
}

function ladderBoxes(meta) {
  const f = meta & 3;
  const T = 0.1;
  return [
    f === 0 ? [1 - T, 0, 0, 1, 1, 1] :
    f === 1 ? [0, 0, 0, T, 1, 1] :
    f === 2 ? [0, 0, 1 - T, 1, 1, 1] :
              [0, 0, 0, 1, 1, T],
  ];
}

function trapdoorBoxes(meta) {
  const open = meta & 1;
  if (!open) {
    return [meta & 2 ? [0, 0.82, 0, 1, 1, 1] : [0, 0, 0, 1, 0.18, 1]];
  }
  const g = (meta >> 2) & 3;
  return [
    g === 0 ? [0.82, 0, 0, 1, 1, 1] :
    g === 1 ? [0, 0, 0, 0.18, 1, 1] :
    g === 2 ? [0, 0, 0.82, 1, 1, 1] :
              [0, 0, 0, 1, 1, 0.18],
  ];
}

function doorBoxes(meta) {
  const open = meta & 1;
  const f = (meta >> 2) & 3;
  if (!open) {
    return [
      f === 0 ? [0, 0, 0, 0.18, 1, 1] :
      f === 1 ? [0.82, 0, 0, 1, 1, 1] :
      f === 2 ? [0, 0, 0, 1, 1, 0.18] :
                [0, 0, 0.82, 1, 1, 1],
    ];
  }
  // open: swing 90° to the adjacent wall (hinge at the low corner)
  return [
    f === 0 ? [0, 0, 0, 1, 1, 0.18] :
    f === 1 ? [0, 0, 0.82, 1, 1, 1] :
    f === 2 ? [0.82, 0, 0, 1, 1, 1] :
              [0, 0, 0, 0.18, 1, 1],
  ];
}

// Render boxes for the mesher.
export function renderBoxes(render, meta) {
  switch (render) {
    case "stair": return stairBoxes(meta);
    case "slab": return [meta & 1 ? SLAB_TOP : SLAB_BOTTOM];
    case "vslab": return vslabBoxes(meta);
    case "ladder": return ladderBoxes(meta);
    case "trapdoor": return trapdoorBoxes(meta);
    case "door": return doorBoxes(meta);
    case "bed": return [BED_BOX];
    default: return null;
  }
}

// Collision boxes for physics. Ladders are pass-through (you climb inside them).
export function collisionBoxes(render, meta) {
  if (render === "ladder") return [];
  return renderBoxes(render, meta) || [];
}

// The metadata a shaped block is *shown* with when it isn't placed in the world
// (inventory icons, dropped items, the held viewmodel) — one canonical pose per
// render type so all three read the same. Chosen so the shape's identity is
// obvious from the standard iso/three-quarter view: stairs step up to the
// right, slabs sit in the bottom half, doors stand closed and tall.
const DISPLAY_META = { stair: 0, slab: 0, vslab: 0, ladder: 3, trapdoor: 0, door: 0, bed: 0 };

// Boxes for an item-display rendition of a block: its shaped boxes in the
// canonical pose, or the full cube when the block isn't shaped.
export function displayBoxes(render) {
  return renderBoxes(render, DISPLAY_META[render] || 0) || [[0, 0, 0, 1, 1, 1]];
}

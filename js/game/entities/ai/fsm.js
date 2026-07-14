// Hierarchical state machines for mob brains. (AI backend — built for future
// advanced mobs; the current sheep/pig/zombie brains keep their ad-hoc logic
// until they're migrated.)
//
// One StateMachine is defined per mob TYPE (shared, stateless); each entity
// carries only plain data in e.data.fsm = { state, timeIn, bb } — so it flows
// through the manager's default {...e.data} save/load untouched, and a mob
// resumes in the state it was saved in. `bb` is the blackboard: put anything
// JSON-safe in it (target ids, home positions, counters). Live objects like a
// PathFollower must live directly on e.data (rebuilt after load), not in bb.
//
// A state is { enter?, update?, exit?, sub? }:
//   enter(e, ctx, bb)            — on transition into the state
//   update(e, dt, ctx, bb) -> ?  — return a state name to transition, or null
//   exit(e, ctx, bb)             — on transition away
//   sub: StateMachine            — optional nested machine, ticked while in the
//                                  state, reset each time the state is entered.
//                                  Its per-entity data nests under bb["@<state>"].
//
// Example:
//   const brain = new StateMachine("wander", {
//     wander: { update(e, dt, ctx, bb) { if (seen(e)) return "hunt"; wander(e); } },
//     hunt: {
//       sub: new StateMachine("chase", {
//         chase:  { update(...) { ... return "search"; } },
//         search: { update(...) { ... } },
//       }),
//       update(e, dt, ctx, bb) { if (lost(e)) return "wander"; },
//     },
//   });
//   ...in the mob's update hook:  brain.update(e, dt, ctx);

export class StateMachine {
  constructor(initial, states) {
    this.initial = initial;
    this.states = states;
    for (const name of Object.keys(states)) {
      if (!states[name]) throw new Error(`fsm: state "${name}" is undefined`);
    }
    if (!states[initial]) throw new Error(`fsm: initial state "${initial}" missing`);
  }

  // Per-entity storage slot; `slot` lets nested machines keep separate records.
  _rec(e, slot) {
    const root = e.data.fsm || (e.data.fsm = {});
    return root[slot] || (root[slot] = { state: this.initial, timeIn: 0, bb: {} });
  }

  // Current state name for an entity (handy for debug overlays / drop tables).
  stateOf(e, slot = "root") {
    return e.data.fsm && e.data.fsm[slot] ? e.data.fsm[slot].state : this.initial;
  }

  // Force a transition (also used internally). Runs exit/enter hooks.
  transition(e, ctx, to, slot = "root") {
    const rec = this._rec(e, slot);
    const from = this.states[rec.state];
    if (!this.states[to]) throw new Error(`fsm: unknown state "${to}"`);
    if (from && from.exit) from.exit(e, ctx, rec.bb);
    // a nested machine restarts fresh each time its parent state is re-entered
    if (from && from.sub) delete e.data.fsm[slot + "/" + rec.state];
    rec.state = to;
    rec.timeIn = 0;
    const st = this.states[to];
    if (st.enter) st.enter(e, ctx, rec.bb);
  }

  // Tick the machine for one entity. Returns the state name after the tick.
  update(e, dt, ctx, slot = "root") {
    const rec = this._rec(e, slot);
    // a state saved under an old name (or a renamed state) falls back to initial
    if (!this.states[rec.state]) { rec.state = this.initial; rec.timeIn = 0; }
    rec.timeIn += dt;
    const st = this.states[rec.state];
    rec.bb.timeIn = rec.timeIn;               // states read how long they've run
    const next = st.update ? st.update(e, dt, ctx, rec.bb) : null;
    if (next && next !== rec.state) {
      this.transition(e, ctx, next, slot);
    } else if (st.sub) {
      st.sub.update(e, dt, ctx, slot + "/" + rec.state);
    }
    return rec.state;
  }
}

// Small per-entity cooldown helper for use inside states:
//   if (cooldown(bb, "attack", 1.0, dt)) { strike(); }
// Returns true when the named timer is ready and immediately re-arms it.
export function cooldown(bb, name, period, dt) {
  const key = "_cd_" + name;
  bb[key] = (bb[key] ?? 0) - dt;
  if (bb[key] <= 0) { bb[key] = period; return true; }
  return false;
}

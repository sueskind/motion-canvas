import type {Scene} from '../scenes';
import {ThreadGenerator} from '../threading';
import {useScene} from '../utils';
import {waitFor, waitUntil} from './scheduling';

interface GroupEntry {
  label: string | null;
  name: string;
  /** Whether the group consists of a single `waitFor` or `waitUntil` call. */
  wait: boolean;
}

interface GroupState {
  /** Number of segments handed out so far in the current scene run. */
  sequence: number;
  /** Groups currently entered, innermost last. */
  stack: GroupEntry[];
  /** Name of the current stretch of frames outside any group. */
  gap: string | null;
}

/**
 * Group state is kept per scene instance rather than globally: the editor's
 * player and the renderer each own their scene instances, and during a scene
 * transition two scenes progress in the same frame. A single module-level
 * value would let either of those overwrite the other's group.
 */
const states = new WeakMap<Scene, GroupState>();

function stateOf(scene: Scene): GroupState {
  let state = states.get(scene);
  if (!state) {
    state = {sequence: 0, stack: [], gap: null};
    states.set(scene, state);
  }
  return state;
}

function nextName(state: GroupState, label: string | null): string {
  state.sequence++;
  const index = state.sequence.toString().padStart(4, '0');
  return label === null ? index : `${index}-${label}`;
}

/**
 * Read the name of the animation group the given scene is currently in.
 *
 * @remarks
 * Intended for exporters that want to partition output by group. Names are
 * zero-padded indices handed out in the order the segments start at runtime,
 * so sorting them by name always yields chronological order — also for groups
 * inside loops and for frames that fall outside any group.
 *
 * @param scene - The scene whose current frame is being exported.
 */
export function getActiveAnimationGroup(scene: Scene): string | null {
  const state = states.get(scene);
  if (!state) return null;
  const entry = state.stack.at(-1);
  if (entry) return entry.name;
  state.gap ??= nextName(state, null);
  return state.gap;
}

/**
 * Check if the animation group the given scene is currently in is a wait.
 *
 * @remarks
 * A group is a wait if its generator is a direct {@link waitFor} or
 * {@link waitUntil} call, as in a top-level `yield* waitFor(1);` statement.
 * Waits nested inside other generators don't count.
 *
 * @param scene - The scene whose current frame is being exported.
 */
export function isActiveAnimationGroupWait(scene: Scene): boolean {
  return states.get(scene)?.stack.at(-1)?.wait ?? false;
}

/**
 * Forget the group state of the given scene. Called at the start of each
 * fresh scene generator run so that indices restart at `0001`.
 *
 * @remarks
 * Also discards entries left behind by an abandoned run, whose generators
 * never reached their `finally` blocks.
 */
export function resetAnimationGroups(scene: Scene): void {
  states.delete(scene);
}

/**
 * Run the given generator inside an animation group.
 *
 * @remarks
 * This is the runtime counterpart to the Vite plugin's build-time transform
 * that wraps each top-level `yield*` in a scene generator. Calling it manually
 * is supported too.
 *
 * Every contiguous run of frames gets its own name, taken from a per-scene
 * counter in the order the runs start: `0001`, `0002`, … A labelled group
 * appends its label (`0007-intro`). The same source-level `yield*` executed
 * repeatedly (e.g. inside a loop) gets a new index each time, so the
 * iterations sort in the order they played. When a nested group ends, the
 * rest of the enclosing group continues under a fresh index instead of
 * reopening the name it had before the nested group started.
 *
 * @param label - Optional label appended to the group's index, or `null`.
 * @param factory - A generator factory invoked once.
 */
export function* animationGroup(
  label: string | null,
  factory: () => ThreadGenerator,
): ThreadGenerator {
  const state = stateOf(useScene());
  const entry: GroupEntry = {label, name: nextName(state, label), wait: false};
  state.stack.push(entry);
  state.gap = null;
  try {
    const generator = factory();
    // Generators are instances of the generator function that created them.
    entry.wait = generator instanceof waitFor || generator instanceof waitUntil;
    yield* generator;
  } finally {
    const index = state.stack.lastIndexOf(entry);
    if (index !== -1) {
      state.stack.splice(index, 1);
      const parent = state.stack.at(-1);
      if (parent) parent.name = nextName(state, parent.label);
    }
  }
}

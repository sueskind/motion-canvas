import {ThreadGenerator} from '../threading';

let activeGroup: string | null = null;

/**
 * Read the currently active animation group name, or `null` if no group is
 * active. Intended for exporters that want to partition output by group.
 */
export function getActiveAnimationGroup(): string | null {
  return activeGroup;
}

/**
 * Run the given generator inside a named animation group.
 *
 * @remarks
 * Sets the module-level active group to `name` for the duration of the
 * delegated generator, then restores the previous value. This is the runtime
 * counterpart to the Vite plugin's build-time transform that wraps each
 * top-level `yield*` in a scene generator. Calling it manually is supported
 * too — nesting works (inner group restores outer on exit).
 *
 * @param name - Group name used by exporters for output paths.
 * @param factory - A generator factory invoked once.
 */
export function* animationGroup(
  name: string,
  factory: () => ThreadGenerator,
): ThreadGenerator {
  const previous = activeGroup;
  activeGroup = name;
  try {
    yield* factory();
  } finally {
    activeGroup = previous;
  }
}

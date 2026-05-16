import {ThreadGenerator} from '../threading';

let activeGroup: string | null = null;
const invocationCounts = new Map<string, number>();

/**
 * Read the currently active animation group name, or `null` if no group is
 * active. Intended for exporters that want to partition output by group.
 */
export function getActiveAnimationGroup(): string | null {
  return activeGroup;
}

/**
 * Reset the per-name invocation counters used to disambiguate repeated
 * `animationGroup` calls (e.g. the same `yield*` inside a loop). Intended to be
 * called at the start of each fresh scene generator run so that names restart
 * at their unsuffixed form.
 */
export function resetAnimationGroups(): void {
  invocationCounts.clear();
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
 * Because the wrapping happens at build time, a single source-level `yield*`
 * inside a loop or re-entered conditional reuses the same name across runtime
 * invocations. To keep exporter output unambiguous, the second and subsequent
 * invocations of a name within the same scene are disambiguated with a
 * `-N` suffix (`anim0040`, `anim0040-2`, `anim0040-3`, …). Counters reset per
 * scene via {@link resetAnimationGroups}.
 *
 * @param name - Group name used by exporters for output paths.
 * @param factory - A generator factory invoked once.
 */
export function* animationGroup(
  name: string,
  factory: () => ThreadGenerator,
): ThreadGenerator {
  const previous = activeGroup;
  const count = (invocationCounts.get(name) ?? 0) + 1;
  invocationCounts.set(name, count);
  activeGroup = count === 1 ? name : `${name}-${count}`;
  try {
    yield* factory();
  } finally {
    activeGroup = previous;
  }
}

import {afterAll, beforeAll, describe, expect, test} from 'vitest';
import {PlaybackManager, PlaybackStatus} from '../app';
import {all, delay, waitFor} from '../flow';
import {tween} from '../tweening';
import {endPlayback, startPlayback} from '../utils';
import {Thread} from './Thread';
import {join} from './join';
import {ThreadGenerator} from './ThreadGenerator';
import {threads} from './threads';

describe('Thread.idle', () => {
  const playback = new PlaybackManager();
  const status = new PlaybackStatus(playback);
  beforeAll(() => {
    playback.fps = 10;
    startPlayback(status);
  });
  afterAll(() => endPlayback(status));

  /**
   * Run the given generator and describe each of its frames as either idle
   * (`.`) or busy (`#`).
   */
  function frames(factory: () => ThreadGenerator): string {
    let root: Thread | null = null;
    const task = threads(factory, thread => {
      root = thread;
    });
    let result = '';
    for (const _ of task) {
      result += root!.idle ? '.' : '#';
    }
    return result;
  }

  test('A wait is idle after its first frame', () => {
    const result = frames(function* () {
      yield* waitFor(0.5);
    });
    expect(result).toBe('#...');
  });

  test('Every wait starts with a busy frame', () => {
    const result = frames(function* () {
      yield* waitFor(0.3);
      yield* waitFor(0.3);
    });
    expect(result).toBe('#.#..');
  });

  test('A tween is never idle', () => {
    const result = frames(function* () {
      yield* tween(0.3, () => {});
      yield* waitFor(0.3);
    });
    // The tween applies its final value on the first frame of the wait.
    expect(result).toBe('####.');
  });

  test('Waiting for waiting threads is idle', () => {
    const result = frames(function* () {
      yield* all(waitFor(0.4), waitFor(0.4));
    });
    expect(result).toBe('#..');
  });

  test('A background animation keeps a wait busy', () => {
    const result = frames(function* () {
      yield tween(0.3, () => {});
      yield* waitFor(0.6);
    });
    // The tween applies its final value on the frame after its last yield.
    expect(result).toBe('####.');
  });

  test('A delayed background animation interrupts a wait', () => {
    const result = frames(function* () {
      yield delay(0.3, tween(0.2, () => {}));
      yield* waitFor(0.8);
    });
    expect(result).toBe('#.####..');
  });

  test('Joining a finished animation is busy for one frame', () => {
    const result = frames(function* () {
      const task = yield tween(0.2, () => {});
      yield* join(task as ThreadGenerator);
      yield* waitFor(0.3);
    });
    expect(result).toBe('###.');
  });

  test('A plain yield is busy', () => {
    const result = frames(function* () {
      yield;
      yield;
      yield* waitFor(0.3);
    });
    expect(result).toBe('###.');
  });
});

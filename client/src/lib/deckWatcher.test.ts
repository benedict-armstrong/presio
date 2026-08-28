import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// pdf.js is the watcher's "is this a complete document?" gate. Stub it so a
// test can decide, per call, whether the current bytes parse.
const parseOk = { value: true };
const destroy = vi.fn();
vi.mock("pdfjs-dist", () => ({
  getDocument: () => ({
    promise: parseOk.value
      ? Promise.resolve({ destroy })
      : Promise.reject(new Error("Invalid PDF structure")),
  }),
}));
vi.mock("@/lib/pdf", () => ({}));

const { DeckWatcher } = await import("@/lib/deckWatcher");

const POLL_MS = 2000;

/** A stand-in for a FileSystemFileHandle backed by a mutable "file on disk". */
function fakeHandle(initial = { lastModified: 1000, size: 10 }) {
  const state = {
    ...initial,
    permission: "granted" as PermissionState,
    /** Set to a DOMException name to make getFile() fail. */
    failWith: null as string | null,
    requested: 0,
  };
  const handle = {
    queryPermission: async () => state.permission,
    requestPermission: async () => {
      state.requested++;
      return state.permission;
    },
    getFile: async () => {
      if (state.failWith) throw new DOMException("nope", state.failWith);
      return {
        lastModified: state.lastModified,
        size: state.size,
        arrayBuffer: async () => new ArrayBuffer(state.size),
      } as unknown as File;
    },
  } as unknown as FileSystemFileHandle;
  return { handle, state };
}

/** Advance fake timers and let every awaited microtask inside a poll settle. */
async function tick(times = 1) {
  for (let i = 0; i < times; i++) {
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await Promise.resolve();
    await Promise.resolve();
  }
}

function watcherFor(handle: FileSystemFileHandle) {
  const statuses: string[] = [];
  const onUpdate = vi.fn();
  const watcher = new DeckWatcher(handle, {
    onStatus: (s) => statuses.push(s),
    onUpdate,
  });
  return { watcher, statuses, onUpdate };
}

beforeEach(() => {
  vi.useFakeTimers();
  parseOk.value = true;
  destroy.mockClear();
});
afterEach(() => vi.useRealTimers());

describe("DeckWatcher.begin", () => {
  it("asks for an explicit resume when the grant didn't survive the reload", async () => {
    const { handle, state } = fakeHandle();
    state.permission = "prompt";
    const { watcher, statuses, onUpdate } = watcherFor(handle);
    await watcher.begin();
    expect(statuses).toEqual(["needs-permission"]);
    await tick(3);
    expect(onUpdate).not.toHaveBeenCalled(); // never polls without access
    watcher.stop();
  });

  it("starts watching when access is already granted", async () => {
    const { handle } = fakeHandle();
    const { watcher, statuses } = watcherFor(handle);
    await watcher.begin();
    expect(statuses).toEqual(["watching"]);
    watcher.stop();
  });
});

describe("DeckWatcher polling", () => {
  it("never reports the file it started on", async () => {
    const { handle } = fakeHandle();
    const { watcher, onUpdate } = watcherFor(handle);
    await watcher.begin();
    await tick(3);
    expect(onUpdate).not.toHaveBeenCalled();
    watcher.stop();
  });

  it("reports a change only once it has held steady across two polls", async () => {
    const { handle, state } = fakeHandle();
    const { watcher, onUpdate } = watcherFor(handle);
    await watcher.begin();
    await tick();

    state.lastModified = 2000;
    state.size = 20;
    await tick();
    expect(onUpdate).not.toHaveBeenCalled(); // first sighting only

    await tick();
    expect(onUpdate).toHaveBeenCalledTimes(1);
    watcher.stop();
  });

  it("discards a mid-write blip that never settles", async () => {
    const { handle, state } = fakeHandle();
    const { watcher, onUpdate } = watcherFor(handle);
    await watcher.begin();
    await tick();

    // Size climbing on every poll: the file is still being written.
    for (let i = 1; i <= 4; i++) {
      state.lastModified = 1000 + i;
      state.size = 10 + i * 5;
      await tick();
    }
    expect(onUpdate).not.toHaveBeenCalled();

    // It stops moving — now two steady polls confirm it.
    await tick(2);
    expect(onUpdate).toHaveBeenCalledTimes(1);
    watcher.stop();
  });

  it("keeps waiting silently while the new bytes don't parse", async () => {
    const { handle, state } = fakeHandle();
    const { watcher, onUpdate, statuses } = watcherFor(handle);
    await watcher.begin();
    await tick();

    parseOk.value = false;
    state.lastModified = 2000;
    await tick(3);
    expect(onUpdate).not.toHaveBeenCalled();
    expect(statuses).toEqual(["watching"]); // nothing surfaced to the presenter

    parseOk.value = true;
    await tick();
    expect(onUpdate).toHaveBeenCalledTimes(1);
    watcher.stop();
  });

  it("writes off a version that never parses instead of re-reading it forever", async () => {
    const { handle, state } = fakeHandle();
    const { watcher, onUpdate } = watcherFor(handle);
    await watcher.begin();
    await tick();

    parseOk.value = false;
    state.lastModified = 2000;
    await tick(20);
    expect(onUpdate).not.toHaveBeenCalled();
    destroy.mockClear();

    // Given up on: even once it would parse, this version is the reference
    // point now and isn't offered. A later edit still is.
    parseOk.value = true;
    await tick(3);
    expect(onUpdate).not.toHaveBeenCalled();

    state.lastModified = 3000;
    await tick(3);
    expect(onUpdate).toHaveBeenCalledTimes(1);
    watcher.stop();
  });

  it("asks for a resume when the grant lapses mid-session", async () => {
    const { handle, state } = fakeHandle();
    const { watcher, statuses } = watcherFor(handle);
    await watcher.begin();
    state.permission = "prompt";
    await tick();
    expect(statuses).toEqual(["watching", "needs-permission"]);

    // Polling really stopped: a change while un-granted is not reported.
    state.lastModified = 2000;
    await tick(3);
    expect(statuses).toEqual(["watching", "needs-permission"]);
    watcher.stop();
  });

  it("stops for good when the file is moved or deleted", async () => {
    const { handle, state } = fakeHandle();
    const { watcher, statuses } = watcherFor(handle);
    await watcher.begin();
    state.failWith = "NotFoundError";
    await tick();
    expect(statuses).toEqual(["watching", "stopped"]);

    // Dead is dead — resume() must not revive it.
    await watcher.resume();
    expect(state.requested).toBe(0);
  });

  it("retries after transient read trouble rather than stopping", async () => {
    const { handle, state } = fakeHandle();
    const { watcher, statuses, onUpdate } = watcherFor(handle);
    await watcher.begin();
    await tick(); // let the opening poll take its baseline
    state.failWith = "NotReadableError";
    await tick(2);
    expect(statuses).toEqual(["watching"]);

    state.failWith = null;
    state.lastModified = 2000;
    await tick(3);
    expect(onUpdate).toHaveBeenCalledTimes(1);
    watcher.stop();
  });
});

describe("DeckWatcher.resume", () => {
  it("starts watching once the re-grant is given", async () => {
    const { handle, state } = fakeHandle();
    state.permission = "prompt";
    const { watcher, statuses, onUpdate } = watcherFor(handle);
    await watcher.begin();
    expect(statuses).toEqual(["needs-permission"]);

    state.permission = "granted";
    await watcher.resume();
    expect(state.requested).toBe(1);
    expect(statuses).toEqual(["needs-permission", "watching"]);

    await tick();
    state.lastModified = 2000;
    await tick(2);
    expect(onUpdate).toHaveBeenCalledTimes(1);
    watcher.stop();
  });

  it("stays in needs-permission when the prompt is declined", async () => {
    const { handle, state } = fakeHandle();
    state.permission = "prompt";
    const { watcher, statuses } = watcherFor(handle);
    await watcher.begin();
    state.permission = "denied";
    await watcher.resume();
    expect(statuses).toEqual(["needs-permission"]);
    watcher.stop();
  });
});

describe("DeckWatcher.takeUpdate / adopt", () => {
  it("hands over the file as it is now, not as it was at detection", async () => {
    const { handle, state } = fakeHandle();
    const { watcher, onUpdate } = watcherFor(handle);
    await watcher.begin();
    await tick();

    state.lastModified = 2000;
    state.size = 20;
    await tick(2);
    expect(onUpdate).toHaveBeenCalledTimes(1);

    // The build ran again between the pill appearing and the click.
    state.lastModified = 3000;
    state.size = 30;
    const update = await watcher.takeUpdate();
    expect(update?.meta).toEqual({ lastModified: 3000, size: 30 });
    watcher.stop();
  });

  it("returns null while the file is mid-write, leaving the update pending", async () => {
    const { handle } = fakeHandle();
    const { watcher } = watcherFor(handle);
    await watcher.begin();
    parseOk.value = false;
    expect(await watcher.takeUpdate()).toBeNull();
    watcher.stop();
  });

  it("stops re-offering a version once it has been adopted", async () => {
    const { handle, state } = fakeHandle();
    const { watcher, onUpdate } = watcherFor(handle);
    await watcher.begin();
    await tick();

    state.lastModified = 2000;
    await tick(2);
    expect(onUpdate).toHaveBeenCalledTimes(1);

    const update = await watcher.takeUpdate();
    watcher.adopt(update!.meta);
    await tick(3);
    expect(onUpdate).toHaveBeenCalledTimes(1); // not re-detected
    watcher.stop();
  });

  it("re-offers the update when the replace failed and nothing was adopted", async () => {
    const { handle, state } = fakeHandle();
    const { watcher, onUpdate } = watcherFor(handle);
    await watcher.begin();
    await tick();

    state.lastModified = 2000;
    await tick(2);
    expect(onUpdate).toHaveBeenCalledTimes(1);

    // takeUpdate() without adopt(): the baseline still predates this version,
    // so a further change is still detected rather than silently swallowed.
    await watcher.takeUpdate();
    state.lastModified = 4000;
    await tick(3);
    expect(onUpdate).toHaveBeenCalledTimes(2);
    watcher.stop();
  });
});

describe("watch modes", () => {
  it("cycles off -> prompt -> auto -> off", async () => {
    const { nextDeckWatchMode } = await import("@/lib/deckWatcher");
    expect(nextDeckWatchMode("off")).toBe("prompt");
    expect(nextDeckWatchMode("prompt")).toBe("auto");
    expect(nextDeckWatchMode("auto")).toBe("off");
  });

  it("recognises only the three real modes, so junk in storage falls back", async () => {
    const { isDeckWatchMode } = await import("@/lib/deckWatcher");
    expect(isDeckWatchMode("off")).toBe(true);
    expect(isDeckWatchMode("prompt")).toBe(true);
    expect(isDeckWatchMode("auto")).toBe(true);
    for (const junk of ["", "on", "PROMPT", null, undefined, 1, {}]) {
      expect(isDeckWatchMode(junk), String(junk)).toBe(false);
    }
  });
});

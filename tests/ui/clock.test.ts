import { describe, expect, it } from 'vitest';

import { rational, secondsToTicks, sourceToTimelineSeconds, timelineToSourceSeconds } from '../../src/engine/core/time.ts';
import { PreviewClock, type AudioReading } from '../../src/ui/clock.ts';

/** A clock over a 10 s timeline: 2 s of lead-in silence, then 6 s of audio, then lead-out. */
function makeClock(overrides: { now?: () => number; snapToFrameGrid?: boolean } = {}) {
  let wall = 0;
  const clock = new PreviewClock({
    fps: rational(60),
    durationTicks: secondsToTicks(10),
    placement: { leadInTicks: secondsToTicks(2), clipInTicks: secondsToTicks(5) },
    audioDurationTicks: secondsToTicks(6),
    now: overrides.now ?? (() => wall),
    ...overrides,
  });
  return { clock, advance: (ms: number) => (wall += ms), setWall: (ms: number) => (wall = ms) };
}

const silent: AudioReading = { positionSeconds: 0, playing: false };
/**
 * The element reports SOURCE time. The clip runs 5 s → 11 s of the source and sits 2 s into the
 * timeline, so timeline = source − 3 throughout the audible stretch.
 */
const sounding = (sourcePosition: number): AudioReading => ({ positionSeconds: sourcePosition, playing: true });

describe('time mapping', () => {
  it('round-trips timeline ↔ source', () => {
    const placement = { leadInTicks: secondsToTicks(2), clipInTicks: secondsToTicks(5) };
    for (const timeline of [0, 1.5, 2, 7.25, 10]) {
      const source = timelineToSourceSeconds(timeline, placement);
      expect(sourceToTimelineSeconds(source, placement)).toBeCloseTo(timeline, 12);
    }
    // 3 s into the timeline is 1 s past the audio start, which is 6 s into the source file.
    expect(timelineToSourceSeconds(3, placement)).toBeCloseTo(6, 12);
  });
});

describe('PreviewClock', () => {
  it('follows the audio, not its own counter', () => {
    const { clock } = makeClock();
    clock.play();
    // Source 6.0 → 3.0 s on the timeline → frame 180.
    const tick = clock.tick(sounding(6));
    expect(tick.frame).not.toBeNull();
    expect(tick.frame!.frameIndex).toBe(180);
    expect(tick.frame!.timelineSeconds).toBeCloseTo(3, 12);
    expect(tick.frame!.source).toBe('audio');
  });

  it('drops frames instead of drifting when a frame takes too long', () => {
    const { clock, advance } = makeClock();
    clock.play();
    clock.tick(sounding(6)); // frame 180

    // A 100 ms stall: the audio has moved on by six frames. The clock must jump to where the
    // audio is, not advance by one — that is the whole determinism-of-sync argument.
    advance(100);
    const tick = clock.tick(sounding(6.1));
    expect(tick.frame!.frameIndex).toBe(186);
    expect(tick.frame!.dropped).toBe(5);
    expect(clock.stats.droppedTotal).toBe(5);
  });

  it('never re-renders the same frame twice', () => {
    const { clock, advance } = makeClock();
    clock.play();
    expect(clock.tick(sounding(6)).frame).not.toBeNull();
    advance(2);
    // Same frame on the grid → nothing new to draw.
    expect(clock.tick(sounding(6.002)).frame).toBeNull();
  });

  it('snaps to the frame grid so preview times are export times', () => {
    const { clock } = makeClock();
    clock.play();
    // Mid-frame audio position still renders the frame's own exact time.
    const snapped = clock.tick(sounding(6.007)).frame!;
    expect(snapped.timelineSeconds).toBeCloseTo(180 / 60, 12);

    const { clock: unsnapped } = makeClock({ snapToFrameGrid: false });
    unsnapped.play();
    expect(unsnapped.tick(sounding(6.007)).frame!.timelineSeconds).toBeCloseTo(3.007, 12);
  });

  it('carries the playhead on the wall clock through lead-in silence', () => {
    const { clock, advance } = makeClock();
    clock.play(); // from 0, inside the 2 s lead-in — there is no audio to follow yet
    advance(500);
    const frame = clock.tick(silent).frame!;
    expect(frame.source).toBe('silence');
    expect(frame.timelineSeconds).toBeCloseTo(0.5, 2);
    expect(clock.audioAudibleAt(0.5)).toBe(false);
  });

  it('hands over from audio to silence continuously at the end of the clip', () => {
    const { clock, advance } = makeClock();
    clock.play();
    // Last audible moment: source 11 → timeline 8.
    clock.tick(sounding(11));
    expect(clock.timelineSeconds).toBeCloseTo(8, 12);

    // Audio stops; the wall anchor was kept in sync, so the lead-out continues from 8 s.
    advance(250);
    const frame = clock.tick(silent).frame!;
    expect(frame.source).toBe('silence');
    expect(frame.timelineSeconds).toBeCloseTo(8.25, 2);
  });

  it('stops on the last frame at the end of the timeline', () => {
    const { clock } = makeClock();
    clock.play();
    const tick = clock.tick(sounding(30)); // far past the end
    expect(tick.frame!.frameIndex).toBe(599); // 10 s × 60 fps − 1
    expect(tick.pauseAudio).toBe(true);
    expect(clock.transport).toBe('stopped');
  });

  it('seeks render exactly one frame, even paused', () => {
    const { clock } = makeClock();
    const request = clock.seek(4);
    expect(request.seekAudioTo).toBeCloseTo(7, 12); // 4 s timeline = 7 s into the source
    expect(clock.tick(silent).frame!.frameIndex).toBe(240);
    // Nothing further until the next seek or play: the frame on screen stands.
    expect(clock.tick(silent).frame).toBeNull();
  });

  it('a seek to the frame already shown still redraws', () => {
    const { clock } = makeClock();
    clock.seek(4);
    expect(clock.tick(silent).frame).not.toBeNull();
    clock.seek(4);
    expect(clock.tick(silent).frame).not.toBeNull();
  });

  it('steps whole frames', () => {
    const { clock } = makeClock();
    clock.seek(1);
    clock.tick(silent);
    clock.stepFrames(1);
    expect(clock.tick(silent).frame!.frameIndex).toBe(61);
    clock.stepFrames(-10);
    expect(clock.tick(silent).frame!.frameIndex).toBe(51);
  });

  it('clamps seeks to the timeline', () => {
    const { clock } = makeClock();
    clock.seek(-5);
    expect(clock.timelineSeconds).toBe(0);
    clock.seek(99);
    expect(clock.timelineSeconds).toBeCloseTo(10, 12);
  });

  it('wraps at the end of a loop region and asks the caller to move the audio', () => {
    const { clock } = makeClock();
    clock.setLoop({ startSeconds: 3, endSeconds: 5 });
    clock.play();
    const tick = clock.tick(sounding(8.5)); // timeline 5.5, past the loop end
    expect(tick.frame!.frameIndex).toBe(180); // back to 3 s
    expect(tick.seekAudioTo).toBeCloseTo(6, 12); // 3 s timeline = 6 s into the source
  });

  it('pausing holds the frame and playing again resumes from there', () => {
    const { clock, advance } = makeClock();
    clock.play();
    clock.tick(sounding(6));
    expect(clock.pause().pauseAudio).toBe(true);
    advance(1000);
    expect(clock.tick(sounding(7)).frame).toBeNull(); // paused: the audio is ignored
    expect(clock.timelineSeconds).toBeCloseTo(3, 12);

    const resumed = clock.play();
    expect(resumed.seekAudioTo).toBeCloseTo(6, 12);
  });

  it('play from the end restarts rather than sitting on the last frame', () => {
    const { clock } = makeClock();
    clock.seek(10);
    clock.play();
    expect(clock.timelineSeconds).toBe(0);
  });

  it('reports rendered fps and recent drops over the rolling window', () => {
    const { clock, advance } = makeClock();
    clock.play();
    for (let i = 0; i < 30; i += 1) {
      clock.tick(sounding(6 + i / 60));
      advance(1000 / 60);
    }
    const stats = clock.stats;
    expect(stats.renderedFps).toBeGreaterThan(25);
    expect(stats.droppedRecent).toBe(0);
    expect(stats.transport).toBe('playing');

    // Drops age out of the window.
    clock.tick(sounding(7));
    expect(clock.stats.droppedRecent).toBeGreaterThan(0);
    advance(2000);
    expect(clock.stats.droppedRecent).toBe(0);
    expect(clock.stats.droppedTotal).toBeGreaterThan(0);
  });

  it('knows where the audio element belongs for any timeline position', () => {
    const { clock } = makeClock();
    expect(clock.audioPositionFor(2)).toBeCloseTo(5, 12); // audio starts here, 5 s into the source
    expect(clock.audioAudibleAt(1.99)).toBe(false);
    expect(clock.audioAudibleAt(2)).toBe(true);
    expect(clock.audioAudibleAt(8)).toBe(false); // one past the clip end
  });
});

describe('loop wrap (audit regression)', () => {
  it('redraws even when the wrap lands on the frame already shown', () => {
    const { clock, advance } = makeClock();
    clock.setLoop({ startSeconds: 3, endSeconds: 4 });
    clock.play();
    clock.tick(sounding(6)); // timeline 3 → frame 180
    advance(16);
    // Past the loop end: wraps back to 3 s, which is the frame on screen. A wrap is a jump
    // backwards and must redraw, or the first frame of every loop pass is skipped.
    const wrapped = clock.tick(sounding(7.5));
    expect(wrapped.frame).not.toBeNull();
    expect(wrapped.frame!.frameIndex).toBe(180);
    expect(wrapped.seekAudioTo).toBeCloseTo(6, 6);
  });
});

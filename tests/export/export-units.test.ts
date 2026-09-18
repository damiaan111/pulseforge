import { describe, expect, it } from 'vitest';
import { encodeWavFloat32, placeAudio, samplesForFrames } from '../../src/export/audio.ts';
import { diagnoseEncoderFailure } from '../../src/export/encoder.ts';
import { buildFfmpegArgs, defaultEncodeSettings, gopLength, resolveConversion, settingsProblems, type EncodeJob } from '../../src/export/ffmpeg-args.ts';
import { PumpCancelled, pumpFrames, type PumpSink, type PumpSource } from '../../src/export/pump.ts';
import { checkOutput, type ProbeResult } from '../../src/export/verify.ts';
import { rational } from '../../src/engine/core/time.ts';

const FPS = rational(60);

function job(overrides: Partial<EncodeJob> = {}): EncodeJob {
  return {
    width: 1920,
    height: 1080,
    fps: FPS,
    settings: defaultEncodeSettings('h264'),
    audioPath: 'D:\\scratch\\audio.wav',
    outputPath: 'D:\\out\\video.mp4',
    bitexact: true,
    ...overrides,
  };
}

const argAfter = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

describe('buildFfmpegArgs', () => {
  it('defaults H.264 to GPU-converted NV12 input (D39), tagged limited range', () => {
    const args = buildFfmpegArgs(job());
    expect(argAfter(args, '-pix_fmt')).toBe('nv12');
    expect(argAfter(args, '-vf')).toBe('setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv');
    expect(args.join(' ')).not.toContain('scale=');
  });

  it('builds the swscale H.264 command from RGBA', () => {
    const args = buildFfmpegArgs(job({ settings: { ...defaultEncodeSettings('h264'), conversion: 'swscale' } }));
    expect(argAfter(args, '-pix_fmt')).toBe('rgba');
    expect(argAfter(args, '-video_size')).toBe('1920x1080');
    expect(argAfter(args, '-framerate')).toBe('60/1');
    expect(argAfter(args, '-c:v')).toBe('h264_nvenc');
    expect(argAfter(args, '-cq')).toBe('17');
    expect(argAfter(args, '-profile:v')).toBe('high');
    expect(argAfter(args, '-g')).toBe('120');
    expect(argAfter(args, '-vf')).toBe(
      'scale=out_color_matrix=bt709:out_range=tv:flags=accurate_rnd+full_chroma_int,format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv',
    );
    expect(argAfter(args, '-c:a')).toBe('aac');
    expect(args).toContain('+bitexact');
    expect(args).not.toContain('-shortest');
    expect(args.at(-1)).toBe('D:\\out\\video.mp4');
  });

  it('writes all four colour tags', () => {
    const args = buildFfmpegArgs(job());
    expect(argAfter(args, '-colorspace')).toBe('bt709');
    expect(argAfter(args, '-color_primaries')).toBe('bt709');
    expect(argAfter(args, '-color_trc')).toBe('bt709');
    expect(argAfter(args, '-color_range')).toBe('tv');
  });

  it('builds the 10-bit HEVC master from x2bgr10le input', () => {
    const args = buildFfmpegArgs(job({ settings: defaultEncodeSettings('hevc') }));
    expect(argAfter(args, '-pix_fmt')).toBe('x2bgr10le');
    expect(argAfter(args, '-c:v')).toBe('hevc_nvenc');
    expect(argAfter(args, '-profile:v')).toBe('main10');
    expect(argAfter(args, '-cq')).toBe('19');
    expect(argAfter(args, '-vf')).toContain('format=p010le');
    expect(argAfter(args, '-tag:v')).toBe('hvc1');
  });

  it('omits audio mapping for a silent export and bit-exact flags when not requested', () => {
    const args = buildFfmpegArgs(job({ audioPath: undefined, bitexact: false }));
    expect(args).not.toContain('1:a:0');
    expect(args).not.toContain('-c:a');
    expect(args).not.toContain('+bitexact');
  });

  it('uses NTSC-rational frame rates and GOPs', () => {
    const ntsc = rational(60000, 1001);
    expect(argAfter(buildFfmpegArgs(job({ fps: ntsc })), '-framerate')).toBe('60000/1001');
    expect(gopLength(ntsc)).toBe(120);
  });

  it('rejects impossible combinations before spawning anything', () => {
    const swscale = { ...defaultEncodeSettings('h264'), conversion: 'swscale' } as const;
    expect(settingsProblems({ ...swscale, bitDepth: 10 }, 1920, 1080)).toHaveLength(1);
    expect(settingsProblems(swscale, 1921, 1080)).toHaveLength(1);
    expect(settingsProblems(defaultEncodeSettings('h264'), 1918, 1080)).toHaveLength(1); // NV12 packing needs width % 4
    expect(() => buildFfmpegArgs(job({ settings: { ...defaultEncodeSettings('hevc'), conversion: 'gpu-nv12' } }))).toThrow(RangeError);
  });

  it('falls back to swscale when GPU NV12 is not possible', () => {
    expect(resolveConversion(defaultEncodeSettings('h264'), 1920, 1080).conversion).toBe('gpu-nv12');
    expect(resolveConversion(defaultEncodeSettings('h264'), 1918, 1080).conversion).toBe('swscale');
    expect(resolveConversion({ ...defaultEncodeSettings('h264'), chroma: '444' }, 1920, 1080).conversion).toBe('swscale');
  });
});

describe('audio placement', () => {
  it('computes exact sample counts for integer and NTSC rates', () => {
    expect(samplesForFrames(600, FPS)).toBe(480_000);
    expect(samplesForFrames(1, rational(60000, 1001))).toBe(801); // 800.8 → 801
    expect(samplesForFrames(5, rational(60000, 1001))).toBe(4004);
  });

  it('places the clip after the lead-in and pads to the video length', () => {
    const source = [Float32Array.from([1, 2, 3, 4, 5, 6])];
    const placed = placeAudio(source, { leadInSamples: 2, clipInSamples: 1, clipOutSamples: 4 }, 8);
    expect(Array.from(placed.channels[0]!)).toEqual([0, 0, 2, 3, 4, 0, 0, 0]);
    expect(placed.sourceSamples).toBe(3);
    expect(placed.adjustmentSamples).toBe(3);
  });

  it('cuts audio that runs past the video and reports it', () => {
    const placed = placeAudio([new Float32Array(10).fill(1)], { leadInSamples: 0, clipInSamples: 0, clipOutSamples: undefined }, 6);
    expect(placed.channels[0]!.length).toBe(6);
    expect(placed.adjustmentSamples).toBe(-4);
  });

  it('applies gain and linear fades over the trimmed clip, after the lead-in', () => {
    const source = [new Float32Array(10).fill(1)];
    const level = { gain: 0.5, fadeInTicks: 4, fadeOutTicks: 2, fadeInCurve: 'linear', fadeOutCurve: 'linear' } as const;
    const placed = placeAudio(source, { leadInSamples: 1, clipInSamples: 0, clipOutSamples: 8, level }, 10);
    // Clip samples 0..7 at 0.5 gain: fade-in over 4 (0, ¼, ½, ¾), then full, fade-out over the last 2.
    expect(Array.from(placed.channels[0]!)).toEqual([0, 0, 0.125, 0.25, 0.375, 0.5, 0.5, 0.5, 0.25, 0]);
  });

  it('ends the fade-out where the clip ends, even when the video cuts the clip short', () => {
    const level = { gain: 1, fadeInTicks: 0, fadeOutTicks: 4, fadeInCurve: 'linear', fadeOutCurve: 'linear' } as const;
    const placed = placeAudio([new Float32Array(8).fill(1)], { leadInSamples: 0, clipInSamples: 0, clipOutSamples: undefined, level }, 5);
    // 8-sample clip, 4-sample fade-out over samples 4..7; the video keeps only 0..4.
    expect(Array.from(placed.channels[0]!)).toEqual([1, 1, 1, 1, 1]);
  });

  it('writes a valid 32-bit float WAV header', () => {
    const wav = encodeWavFloat32([Float32Array.from([0.5, -0.5]), Float32Array.from([0.25, 0])], 48_000);
    const view = new DataView(wav.buffer);
    expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe('RIFF');
    expect(view.getUint16(20, true)).toBe(3);
    expect(view.getUint16(22, true)).toBe(2);
    expect(view.getUint32(40, true)).toBe(16);
    expect(view.getFloat32(44, true)).toBe(0.5);
    expect(view.getFloat32(48, true)).toBe(0.25);
    expect(view.getFloat32(52, true)).toBe(-0.5);
  });
});

/** A fake GPU: frames become ready `latency` polls after submission. */
function fakeSource(bytes: number, depth: number, latency: number) {
  const pending: Array<{ frame: number; polls: number }> = [];
  let lastRendered = -1;
  const source: PumpSource = {
    renderFrame(frameIndex) {
      lastRendered = frameIndex;
    },
    readback: {
      depth,
      bytesPerFrame: bytes,
      hasFreeSlot: () => pending.length < depth,
      pendingCount: () => pending.length,
      submit: () => void pending.push({ frame: lastRendered, polls: 0 }),
      oldestReady: () => {
        const head = pending[0];
        if (head === undefined) return false;
        head.polls++;
        return head.polls > latency;
      },
      collectOldest: (into) => {
        const head = pending.shift();
        into.fill((head?.frame ?? 0) % 256);
      },
    },
  };
  return source;
}

function yieldImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('pumpFrames', () => {
  it('delivers every frame once, in order, with bounded buffering', async () => {
    const written: number[] = [];
    let queued = 0;
    let maxQueued = 0;
    const sink: PumpSink = {
      async write(frame) {
        queued++;
        maxQueued = Math.max(maxQueued, queued);
        written.push(frame[0]!);
        await new Promise((r) => setTimeout(r, 1)); // a slow encoder
        queued--;
      },
    };
    const stats = await pumpFrames({
      frameCount: 50,
      source: fakeSource(16, 3, 2),
      sink,
      maxQueuedWrites: 4,
      now: () => performance.now(),
      yieldToEventLoop: yieldImmediate,
    });
    expect(written).toEqual(Array.from({ length: 50 }, (_, i) => i));
    expect(stats.maxPendingReadbacks).toBeLessThanOrEqual(3);
    expect(maxQueued).toBeLessThanOrEqual(3 + 4);
  });

  it('hands frames to onFrame in order before writing', async () => {
    const seen: number[] = [];
    await pumpFrames({
      frameCount: 10,
      source: fakeSource(4, 2, 0),
      sink: { write: async () => {} },
      maxQueuedWrites: 2,
      now: () => 0,
      yieldToEventLoop: yieldImmediate,
      onFrame: (index, bytes) => {
        expect(bytes[0]).toBe(index);
        seen.push(index);
      },
    });
    expect(seen).toEqual(Array.from({ length: 10 }, (_, i) => i));
  });

  it('stops and surfaces the error when the encoder fails', async () => {
    let writes = 0;
    const run = pumpFrames({
      frameCount: 100,
      source: fakeSource(4, 2, 0),
      sink: {
        write: async () => {
          if (++writes === 5) throw new Error('FFmpeg exited');
        },
      },
      maxQueuedWrites: 2,
      now: () => 0,
      yieldToEventLoop: yieldImmediate,
    });
    await expect(run).rejects.toThrow('FFmpeg exited');
    expect(writes).toBeLessThan(100);
  });

  it('cancels between frames', async () => {
    let rendered = 0;
    const source = fakeSource(4, 2, 0);
    const original = source.renderFrame;
    source.renderFrame = (n) => {
      rendered++;
      original(n);
    };
    await expect(
      pumpFrames({
        frameCount: 100,
        source,
        sink: { write: async () => {} },
        maxQueuedWrites: 2,
        now: () => 0,
        yieldToEventLoop: yieldImmediate,
        isCancelled: () => rendered >= 10,
      }),
    ).rejects.toBeInstanceOf(PumpCancelled);
    expect(rendered).toBe(10);
  });
});

describe('checkOutput', () => {
  const good: ProbeResult = {
    streams: [
      { codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p', width: 1920, height: 1080, r_frame_rate: '60/1', nb_read_packets: '600', duration: '10.000000', color_range: 'tv', color_space: 'bt709', color_transfer: 'bt709', color_primaries: 'bt709' },
      { codec_type: 'audio', codec_name: 'aac', duration: '10.005000' },
    ],
    format: {},
  };
  const expectation = { frameCount: 600, width: 1920, height: 1080, fps: FPS, settings: defaultEncodeSettings('h264'), hasAudio: true };

  it('accepts a correct file', () => {
    expect(checkOutput(good, expectation)).toMatchObject({ ok: true, issues: [] });
  });

  it('flags a wrong frame count, missing tags and audio drift', () => {
    const untagged = { ...good.streams[0]! };
    delete untagged.color_range;
    const bad: ProbeResult = {
      streams: [
        { ...untagged, nb_read_packets: '599' },
        { codec_type: 'audio', duration: '10.5' },
      ],
      format: {},
    };
    const result = checkOutput(bad, expectation);
    expect(result.ok).toBe(false);
    expect(result.issues.join('\n')).toMatch(/frame count 599/);
    expect(result.issues.join('\n')).toMatch(/color_range is untagged/);
    expect(result.issues.join('\n')).toMatch(/differs by more than one frame/);
  });
});

describe('diagnoseEncoderFailure', () => {
  it('turns NVENC failures into actionable causes', () => {
    expect(diagnoseEncoderFailure('[h264_nvenc @ 0x1] OpenEncodeSessionEx failed: out of memory (10)')).toMatch(/NVENC could not start/);
    expect(diagnoseEncoderFailure('av1_nvenc: Unknown encoder')).toMatch(/does not include/);
    expect(diagnoseEncoderFailure('all good')).toBeUndefined();
  });
});

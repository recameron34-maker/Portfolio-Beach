/* eslint-disable @typescript-eslint/explicit-module-boundary-types -- plain JavaScript shared by the media scripts */
// The narration of the demo recordings: each caption is spoken by an open-source voice that runs
// on this machine (scripts/narrate.py; the voice, the pace and the pinned model files are in
// narration.config.json), and the clips are laid under the recording at the times their captions
// appear. Nothing is sent to a service. The clips and the model files are kept in .cache (not
// committed); the recordings that carry the sound are.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CACHE = process.env.PB_NARRATION_CACHE ?? join(SITE, '.cache', 'narration');
const MODELS = process.env.PB_VOICE_MODELS ?? join(SITE, '.cache', 'voice-models');

/** @returns {{ engine: string, voice: string, speed: number, lang: string, files: Record<string, { name: string, url: string, sha256: string }>, spoken: Record<string, string>, gapMs: number, wordsPerSecond: number, audio: { codec: string, bitrate: string, gainDb: number } }} */
export function narrationConfig() {
  return JSON.parse(readFileSync(join(SITE, 'narration.config.json'), 'utf8'));
}

const escapeForPattern = (word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * What the voice is given for a caption: the caption itself, with the few terms a reader would
 * say differently from how they are written replaced by their spoken form (whole words only).
 * @param {string} text
 * @param {Record<string, string>} spoken
 */
export function spokenText(text, spoken) {
  let out = text.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
  for (const [written, said] of Object.entries(spoken))
    out = out.replace(
      new RegExp(`(?<![A-Za-z0-9])${escapeForPattern(written)}(?![A-Za-z0-9])`, 'g'),
      said,
    );
  return out;
}

/** The name of a clip: what was said, by which voice, at what pace, with which model. */
export function clipKey(config, text) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        config.engine,
        config.files.model.sha256,
        config.files.voices.sha256,
        config.voice,
        config.speed,
        config.lang,
        spokenText(text, config.spoken),
      ]),
    )
    .digest('hex')
    .slice(0, 20);
}

/** How long a caption is expected to take to say when its clip is not made yet. */
export function estimatedSeconds(config, text) {
  return text.trim().split(/\s+/).length / config.wordsPerSecond;
}

/** The length of a 16-bit mono WAV the narration script wrote, in seconds, from its header. */
function wavSeconds(file) {
  const bytes = readFileSync(file);
  const rate = bytes.readUInt32LE(24);
  const blockAlign = bytes.readUInt16LE(32);
  const data = bytes.indexOf(Buffer.from('data'), 12);
  if (data === -1) throw new Error(`${file}: not a WAV file`);
  return bytes.readUInt32LE(data + 4) / blockAlign / rate;
}

/** An ffmpeg that can write the audio codec: the system one, since the browser's has no audio. */
export function audioFfmpeg(codec) {
  const candidates = [process.env.PB_FFMPEG_AUDIO, 'ffmpeg'].filter(
    (c) => c !== undefined && c !== '',
  );
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['-hide_banner', '-encoders'], { encoding: 'utf8' });
    if (probe.status === 0 && probe.stdout.includes(` ${codec} `)) return candidate;
  }
  return null;
}

/**
 * Opens the narration for a run of the recorder. `seconds(text)` answers the length of a
 * caption's clip when it is already made (null otherwise), `ensure(texts)` makes the missing
 * clips, and `mix(video, steps)` lays them under a recording.
 */
export function openNarration(log = () => undefined) {
  const config = narrationConfig();
  mkdirSync(CACHE, { recursive: true });
  const clipFile = (text) => join(CACHE, `${clipKey(config, text)}.wav`);

  function seconds(text) {
    const file = clipFile(text);
    return existsSync(file) ? wavSeconds(file) : null;
  }

  function ensure(texts) {
    const missing = [...new Set(texts)].filter((text) => !existsSync(clipFile(text)));
    if (missing.length === 0) return;
    const work = mkdtempSync(join(tmpdir(), 'pb-narration-'));
    try {
      const job = join(work, 'job.json');
      writeFileSync(
        job,
        JSON.stringify({
          voice: config.voice,
          speed: config.speed,
          lang: config.lang,
          files: config.files,
          clips: missing.map((text) => ({
            key: clipKey(config, text),
            text: spokenText(text, config.spoken),
          })),
        }),
      );
      log(`narration: speaking ${missing.length} captions (${config.engine}, ${config.voice})`);
      // PB_NARRATE_PYTHON names an interpreter that already has the engine; otherwise uv reads
      // the script's own dependency list.
      const python = process.env.PB_NARRATE_PYTHON;
      const script = join(SITE, 'scripts', 'narrate.py');
      const args = ['--job', job, '--out', join(work, 'clips'), '--models', MODELS];
      const run =
        python !== undefined && python !== ''
          ? spawnSync(python, [script, ...args], { encoding: 'utf8', maxBuffer: 1 << 26 })
          : spawnSync('uv', ['run', '--quiet', '--script', script, ...args], {
              encoding: 'utf8',
              maxBuffer: 1 << 26,
            });
      if (run.error !== undefined || run.status !== 0)
        throw new Error(
          `narration: the voice could not be run (${run.error?.message ?? run.stderr.trim().split('\n').slice(-3).join(' | ')}). It needs uv (or PB_NARRATE_PYTHON) and, the first time, a download of the model files; --no-narration records without sound.`,
        );
      for (const clip of JSON.parse(run.stdout).clips)
        renameSync(join(work, 'clips', `${clip.key}.wav`), join(CACHE, `${clip.key}.wav`));
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  /**
   * The captions whose clip would still be playing when the next caption appears (or the
   * recording ends): a recording with any of these is made again with the clips known.
   * @param {{ at: number, text: string }[]} steps
   * @param {number} endsAt the length of the recording in seconds
   */
  function overruns(steps, endsAt) {
    return steps.filter((step, i) => {
      const length = seconds(step.text);
      if (length === null) return true;
      const next = i + 1 < steps.length ? steps[i + 1].at : endsAt;
      return step.at + length > next - 0.05;
    });
  }

  /**
   * Writes the recording again with the narration as its audio track: the picture is copied as
   * it is, each clip starts when its caption appears, and the track is as long as the picture.
   * @param {string} video
   * @param {{ at: number, text: string }[]} steps
   */
  function mix(video, steps) {
    const ffmpeg = audioFfmpeg(config.audio.codec);
    if (ffmpeg === null)
      throw new Error(
        `narration: no ffmpeg with ${config.audio.codec} was found (PB_FFMPEG_AUDIO names one); --no-narration records without sound.`,
      );
    const inputs = steps.flatMap((step) => ['-i', clipFile(step.text)]);
    const delayed = steps
      .map((step, i) => `[${i + 1}:a]adelay=${Math.round(step.at * 1000)}:all=1[c${i}]`)
      .join(';');
    const mixed = `${steps.map((_s, i) => `[c${i}]`).join('')}amix=inputs=${steps.length}:normalize=0:dropout_transition=0,volume=${config.audio.gainDb}dB,apad[a]`;
    const out = `${video}.narrated.webm`;
    const run = spawnSync(
      ffmpeg,
      [
        '-y',
        '-loglevel',
        'error',
        '-i',
        video,
        ...inputs,
        '-filter_complex',
        `${delayed};${mixed}`,
        '-map',
        '0:v:0',
        '-map',
        '[a]',
        '-c:v',
        'copy',
        '-c:a',
        config.audio.codec,
        '-b:a',
        config.audio.bitrate,
        '-ac',
        '1',
        '-shortest',
        out,
      ],
      { encoding: 'utf8' },
    );
    if (run.status !== 0) {
      rmSync(out, { force: true });
      throw new Error(`narration: ffmpeg could not lay the sound under ${video}: ${run.stderr}`);
    }
    renameSync(out, video);
  }

  return { config, seconds, ensure, overruns, mix };
}

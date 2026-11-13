"""Writes a quiet piano score for the film and mixes it under the voices.

    python mix.py        reads timeline.json, writes ~/.baton/video/mix.wav

The music is generated here note by note, so there is nothing to license.
Adapted from the author's own earlier tooling.
"""

import json
import os
import subprocess
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf
from scipy.ndimage import uniform_filter1d
from scipy.signal import butter, fftconvolve, sosfilt

HOME = Path.home() / ".baton" / "video"
HERE = Path(__file__).parent
SR = 48000
BEAT = 60.0 / 80.0
BAR = 4 * BEAT
rng = np.random.default_rng(11)
NAMES = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}


def hz(note):
    pitch = NAMES[note[0]]
    rest = note[1:]
    if rest.startswith("b"):
        pitch -= 1
        rest = rest[1:]
    elif rest.startswith("#"):
        pitch += 1
        rest = rest[1:]
    return 440.0 * 2 ** ((pitch + (int(rest) + 1) * 12 - 69) / 12)


def piano(freq, seconds, velocity):
    """A soft felt piano: a few decaying partials, a slow attack and no bright overtones."""
    n = int(seconds * SR)
    t = np.arange(n) / SR
    out = np.zeros(n)
    top = 7 if freq < 400 else 5
    for k in range(1, top + 1):
        partial = k * freq * np.sqrt(1 + 0.00035 * k * k)
        if partial > 4200:
            break
        decay = (1.5 + 0.55 * k) * (freq / 262.0) ** 0.35
        for detune in (0.9994, 1.0006):
            out += (k ** -1.75) * np.sin(2 * np.pi * partial * detune * t) * np.exp(-t * decay)
    attack = 1 - np.exp(-t / (0.016 - 0.008 * min(1.0, velocity)))
    release = np.minimum(1.0, (seconds - t) / 0.12)
    return out * attack * release * velocity


WORRY = [("A2", ["E3", "A3", "C4"]), ("F2", ["C3", "F3", "A3"]), ("D3", ["A3", "D4", "F4"]), ("E2", ["B2", "E3", "G#3"])]
IDEA = [("C3", ["G3", "C4", "E4", "G4"]), ("G2", ["D3", "G3", "B3", "D4"]), ("A2", ["E3", "A3", "C4", "E4"]), ("F2", ["C3", "F3", "A3", "C4"])]
BRIGHT = [("F2", ["C3", "A3", "C4", "F4"]), ("C3", ["G3", "E4", "G4", "C5"]), ("G2", ["D3", "B3", "D4", "G4"]), ("A2", ["E3", "C4", "E4", "A4"])]
RESOLVE = [("F2", ["C3", "F3", "A3", "C4"]), ("G2", ["D3", "G3", "B3", "D4"]), ("C3", ["G3", "C4", "E4", "G4", "C5"])]


def score(duration, cues):
    """Returns (start seconds, note, velocity, length) for every note in the film."""
    notes = []
    sections = [
        (0.0, cues["idea"], WORRY, 0.36, 1),
        (cues["idea"], cues["sold"], IDEA, 0.42, 2),
        (cues["sold"], cues["safe"], BRIGHT, 0.5, 3),
        (cues["safe"], cues["matters"], IDEA, 0.4, 2),
        (cues["matters"], cues["end"] - BAR, BRIGHT, 0.46, 2),
        (cues["end"] - BAR, duration, RESOLVE, 0.5, 3),
    ]
    for start, end, chords, level, density in sections:
        bar = 0
        t = start
        while t < end - 0.2:
            bass, walk = chords[bar % len(chords)]
            human = lambda: float(rng.normal(0, 0.012))  # noqa: E731
            notes.append((t + human(), bass, level * 0.85, BAR * 1.6))
            steps = {1: [2], 2: [1, 2.5], 3: [1, 2, 3]}[density]
            for i, beat in enumerate(steps):
                note = walk[min(i + (len(walk) - len(steps)), len(walk) - 1)]
                when = t + beat * BEAT + human()
                if when < end:
                    notes.append((when, note, level * (0.62 + 0.08 * i), BAR * 1.2))
            t += BAR
            bar += 1
    return notes


def render_music(duration, cues):
    track = np.zeros(int((duration + 8) * SR))
    for start, note, velocity, length in score(duration, cues):
        tone = piano(hz(note), length, velocity)
        at = max(0, int(start * SR))
        end = min(len(track), at + len(tone))
        track[at:end] += tone[: end - at]
    tail = int(2.2 * SR)
    ir = rng.standard_normal(tail) * np.exp(-np.arange(tail) / (0.5 * SR))
    ir = sosfilt(butter(2, 2600, "low", fs=SR, output="sos"), ir)
    ir /= np.sqrt(np.sum(ir**2))
    wet = fftconvolve(track, ir)[: len(track)]
    mixed = 0.75 * track + 0.45 * wet
    mixed = sosfilt(butter(2, 70, "high", fs=SR, output="sos"), mixed)
    mixed = sosfilt(butter(2, 5200, "low", fs=SR, output="sos"), mixed)
    return mixed[: int(duration * SR)] / (np.max(np.abs(mixed)) or 1.0)


def master():
    """Two-pass loudness matching, so the whole film moves by one fixed gain and stays natural."""
    ffmpeg = os.environ["FFMPEG"]
    target = "I=-16:TP=-1.5:LRA=11"
    raw = str(HOME / "mix.raw.wav")
    first = subprocess.run([ffmpeg, "-hide_banner", "-nostats", "-i", raw, "-af", f"loudnorm={target}:print_format=json", "-f", "null", "-"], capture_output=True, text=True).stderr
    m = json.loads(first[first.rindex("{"): first.rindex("}") + 1])
    settings = f"{target}:measured_I={m['input_i']}:measured_TP={m['input_tp']}:measured_LRA={m['input_lra']}:measured_thresh={m['input_thresh']}:offset={m['target_offset']}:linear=true"
    subprocess.run([ffmpeg, "-y", "-hide_banner", "-loglevel", "error", "-i", raw, "-af", f"loudnorm={settings},aresample=48000", "-c:a", "pcm_s24le", str(HOME / "mix.wav")], check=True)
    print(f"measured {m['input_i']} LUFS, true peak {m['input_tp']}")


def main():
    timeline = json.loads((HERE / "timeline.json").read_text(encoding="utf-8"))
    duration = timeline["duration"]
    length = int(duration * SR)
    voices = np.zeros(length)
    speaker_rms = {}
    for line in timeline["lines"]:
        audio, _ = sf.read(HOME / "voices" / f"{line['id']}.{line['take']}.wav")
        speaker_rms.setdefault(line["voice"], []).append(float(np.sqrt(np.mean(audio[np.abs(audio) > 0.02] ** 2))))
    speaker_gain = {name: min(0.135 / float(np.mean(values)), 4.0) for name, values in speaker_rms.items()}
    for line in timeline["lines"]:
        audio, sr = sf.read(HOME / "voices" / f"{line['id']}.{line['take']}.wav")
        audio = librosa.resample(audio.astype(np.float32), orig_sr=sr, target_sr=SR) * speaker_gain[line["voice"]]
        at = int(line["at"] * SR)
        end = min(length, at + len(audio))
        voices[at:end] += audio[: end - at]

    # A little of a small room around the voices, so they sound spoken rather than pasted in.
    tail = int(0.42 * SR)
    room = rng.standard_normal(tail) * np.exp(-np.arange(tail) / (0.085 * SR))
    room = sosfilt(butter(2, [280, 5200], "band", fs=SR, output="sos"), room)
    room /= np.sqrt(np.sum(room**2))
    voices = voices + 0.1 * fftconvolve(voices, room)[:length]

    # The music steps back under speech and comes forward in the gaps.
    active = np.abs(voices) > 0.012
    window = int(0.35 * SR)
    held = uniform_filter1d(active.astype(float), size=window, mode="nearest")
    speaking = uniform_filter1d(np.clip(held * 6.0, 0.0, 1.0), size=window, mode="nearest")
    music = render_music(duration, timeline["cues"])
    gain = 0.24 + (0.05 - 0.24) * speaking
    ramp = int(1.4 * SR)
    gain[:ramp] *= np.linspace(0.0, 1.0, ramp)
    gain[-int(1.4 * SR):] *= np.linspace(1.0, 0.0, int(1.4 * SR))
    mixed = voices + music * gain
    peak = float(np.max(np.abs(mixed)))
    mixed = mixed * (0.89 / peak)
    sf.write(HOME / "mix.raw.wav", np.column_stack([mixed, mixed]), SR, subtype="PCM_24")
    master()
    print(f"duration {duration:.1f}s, peak was {peak:.2f}")


if __name__ == "__main__":
    main()

import argparse
import hashlib
import json
import math
import pathlib

import numpy as np

try:
    import torch
except ImportError as error:
    raise SystemExit(f"torch is required to build the golden fixture: {error}")


def parse_arguments():
    parser = argparse.ArgumentParser(description="Dump a whisper log-mel golden fixture with torch.")
    parser.add_argument("--filters", required=True, help="path to the mel_filters.npz of the whisper assets")
    parser.add_argument("--output-dir", default=None, help="directory receiving the fixtures (default: this directory)")
    parser.add_argument("--mel-bins", type=int, default=80)
    parser.add_argument("--sample-rate", type=int, default=16000)
    parser.add_argument("--n-fft", type=int, default=400)
    parser.add_argument("--hop-length", type=int, default=160)
    parser.add_argument("--window-seconds", type=float, default=1.0)
    parser.add_argument("--signal-seconds", type=float, default=0.6)
    parser.add_argument("--seed", type=int, default=12345)
    return parser.parse_args()


def build_waveform(sample_rate, count, seed):
    generator = np.random.default_rng(seed)
    time = np.arange(count, dtype=np.float64) / sample_rate
    tone = 0.6 * np.sin(2 * math.pi * 220 * time) + 0.35 * np.sin(2 * math.pi * 3100 * time)
    noise = generator.standard_normal(count) * 0.05
    return (tone + noise).astype(np.float32)


def build_expected(waveform, filters, window_samples, n_fft, hop_length):
    window = np.zeros(window_samples, dtype=np.float32)
    window[: waveform.size] = waveform
    spectrum = torch.stft(
        torch.from_numpy(window),
        n_fft,
        hop_length,
        window=torch.hann_window(n_fft),
        return_complex=True,
    )
    power = spectrum[..., :-1].abs() ** 2
    mel = torch.from_numpy(filters) @ power
    log = torch.clamp(mel, min=1e-10).log10()
    log = torch.maximum(log, log.max() - 8.0)
    return (log + 4.0).div(4.0).numpy().astype(np.float32), spectrum.shape[-1] - 1


def write_binary(path, values):
    values = np.ascontiguousarray(values, dtype="<f4")
    path.write_bytes(values.tobytes())
    return hashlib.sha256(path.read_bytes()).hexdigest(), values.shape


def main():
    arguments = parse_arguments()
    output_dir = pathlib.Path(arguments.output_dir) if arguments.output_dir else pathlib.Path(__file__).resolve().parent
    output_dir.mkdir(parents=True, exist_ok=True)

    with np.load(pathlib.Path(arguments.filters)) as assets:
        filters = assets[f"mel_{arguments.mel_bins}"]
    if filters.shape[0] != arguments.mel_bins:
        raise SystemExit(f"mel_{arguments.mel_bins} has {filters.shape[0]} rows, expected {arguments.mel_bins}")
    if filters.shape[1] != arguments.n_fft // 2 + 1:
        raise SystemExit(f"mel_{arguments.mel_bins} has {filters.shape[1]} columns, expected {arguments.n_fft // 2 + 1}")

    window_samples = int(round(arguments.window_seconds * arguments.sample_rate))
    signal_samples = int(round(arguments.signal_seconds * arguments.sample_rate))
    frames = window_samples // arguments.hop_length

    waveform = build_waveform(arguments.sample_rate, signal_samples, arguments.seed)
    expected, computed_frames = build_expected(waveform, filters, window_samples, arguments.n_fft, arguments.hop_length)
    if computed_frames != frames:
        raise SystemExit(f"torch produced {computed_frames} frames, expected {frames}")

    input_path = output_dir / "mel-golden-input.bin"
    output_path = output_dir / "mel-golden-output.bin"
    input_sha256, input_shape = write_binary(input_path, waveform)
    output_sha256, output_shape = write_binary(output_path, expected)

    manifest = {
        "sampleRate": arguments.sample_rate,
        "melBins": arguments.mel_bins,
        "nFft": arguments.n_fft,
        "hopLength": arguments.hop_length,
        "nSamples": window_samples,
        "nbMaxFrames": frames,
        "inputFile": input_path.name,
        "inputSamples": int(input_shape[0]),
        "inputSha256": input_sha256,
        "outputFile": output_path.name,
        "outputMelBins": int(output_shape[0]),
        "outputFrames": int(output_shape[1]),
        "outputSha256": output_sha256,
        "torchVersion": torch.__version__,
        "numpyVersion": np.__version__,
        "seed": arguments.seed,
    }
    manifest_path = output_dir / "mel-golden.json"
    manifest_path.write_text(json.dumps(manifest, indent=4) + "\n", encoding="utf-8")
    print(json.dumps(manifest, indent=4))
    print(f"wrote {input_path}, {output_path} and {manifest_path}")


if __name__ == "__main__":
    main()

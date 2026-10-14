import argparse
import json
import pathlib

import numpy as np

try:
    from stable_whisper.result import WhisperResult
except ImportError as error:
    raise SystemExit(f"stable-whisper is required to build the golden fixtures: {error}")


def parse_arguments():
    parser = argparse.ArgumentParser(description="Dump the regroup and suppression golden fixtures with stable-whisper.")
    parser.add_argument("--words", required=True, help="JSON file holding the language, the silences and the segments")
    parser.add_argument("--output-dir", default=None, help="directory receiving the fixtures (default: this directory)")
    parser.add_argument("--regroup-algo", default="da", help="regroup algorithm string (default: da)")
    parser.add_argument("--min-word-dur", type=float, default=0.1, help="min_word_dur passed to suppress_silence")
    parser.add_argument("--nonspeech-error", type=float, default=0.1, help="nonspeech_error passed to suppress_silence")
    parser.add_argument("--no-word-position", action="store_true", help="pass use_word_position=False")
    return parser.parse_args()


def read_version():
    from importlib.metadata import PackageNotFoundError, version

    for name in ("stable-ts", "stable-whisper"):
        try:
            return version(name)
        except PackageNotFoundError:
            continue
    return "unknown"


def write_fixture(path, payload):
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=4) + "\n", encoding="utf-8")
    print(f"wrote {path} ({path.stat().st_size} bytes)")


def main():
    arguments = parse_arguments()
    output_dir = pathlib.Path(arguments.output_dir) if arguments.output_dir else pathlib.Path(__file__).resolve().parent
    output_dir.mkdir(parents=True, exist_ok=True)

    words_path = pathlib.Path(arguments.words).resolve()
    data = json.loads(words_path.read_text(encoding="utf-8"))
    document = {"language": data.get("language"), "segments": data["segments"]}
    silences = data.get("silences") or []

    producer = {
        "stableWhisperVersion": read_version(),
        "numpyVersion": np.__version__,
        "regroupAlgo": arguments.regroup_algo,
        "minWordDur": arguments.min_word_dur,
        "nonspeechError": arguments.nonspeech_error,
        "wordLevel": True,
        "useWordPosition": not arguments.no_word_position,
        "wordsFile": words_path.name,
    }

    regrouped = WhisperResult(json.loads(json.dumps(document)))
    regrouped.regroup(arguments.regroup_algo)
    write_fixture(
        output_dir / "regroup-golden.json",
        {"producer": producer, "input": data, "regroup": regrouped.to_dict()},
    )

    suppressed = None
    if silences:
        starts = np.asarray([span[0] for span in silences], dtype=np.float64)
        ends = np.asarray([span[1] for span in silences], dtype=np.float64)
        fresh = WhisperResult(json.loads(json.dumps(document)))
        for segment in fresh.segments:
            segment.suppress_silence(
                starts,
                ends,
                arguments.min_word_dur,
                True,
                arguments.nonspeech_error,
                not arguments.no_word_position,
            )
        suppressed = fresh.segments_to_dicts()
    write_fixture(
        output_dir / "suppress-golden.json",
        {"producer": producer, "input": data, "suppress": suppressed},
    )
    print(json.dumps(producer, indent=4))


if __name__ == "__main__":
    main()

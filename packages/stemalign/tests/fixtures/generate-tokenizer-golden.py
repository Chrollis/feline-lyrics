# Writes the encoder golden fixture with the whisper package.
#
# Run it with an interpreter that has whisper installed; nothing about that
# environment lives in this file. Pass --output to write somewhere else.

import argparse
import json
import sys
from pathlib import Path

import whisper

CASES = (
    'Hello, world!',
    ' the quick brown fox',
    "don't stop",
    '你好，世界',
    'music 音乐 123',
    '😀 emoji 🎵',
    'line\nbreak\ttab',
    '  double  spaces  ',
    'ellipsis...and, punctuation!',
    '',
    '中文abc日本語',
    'Café naïve résumé',
    'ALL CAPS and MiXeD',
    'tectonic plates drift 一分钱 3.14159 #hashtag @mention https://example.com',
)


def main() -> None:
    parser = argparse.ArgumentParser(description='write the encoder golden fixture')
    parser.add_argument(
        '--output',
        type=Path,
        default=Path(__file__).resolve().parent / 'tokenizer-golden.json',
        help='path of the fixture to write',
    )
    args = parser.parse_args()

    tokenizer = whisper.tokenizer.get_tokenizer(multilingual=True)
    document = {
        'whisperVersion': whisper.__version__,
        'pythonVersion': sys.version.split()[0],
        'cases': [{'text': text, 'ids': tokenizer.encode(text)} for text in CASES],
    }
    args.output.write_text(
        json.dumps(document, ensure_ascii=False, indent=4) + '\n',
        encoding='utf-8',
    )

    sys.stdout.reconfigure(encoding='utf-8')
    print(
        f'wrote {len(CASES)} cases with whisper {whisper.__version__} to {args.output}'
    )
    print(json.dumps(document, ensure_ascii=False, indent=4))


if __name__ == '__main__':
    main()

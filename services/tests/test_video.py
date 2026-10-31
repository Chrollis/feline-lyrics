"""Checks for ``services/felyrics/video.py`` window reads.

The stream is built here, so the suite needs no video fixture: an mp4 whose
first timestamp is 12.5 s is the case where the window used to compare media
targets against absolute container pts and hold the first frame too long.

Run:
  python\\python.exe -m pytest services\\tests -q -p no:cacheprovider
"""

from __future__ import annotations

from pathlib import Path

import av
import numpy as np
import pytest

from felyrics.video import VideoFile

OFFSET_SEC = 12.5
FPS = 10
TEMP = Path("cache") / "temp"


def build(path: Path, offset: float | None = OFFSET_SEC, frames: int = 30) -> None:
    options = {"output_ts_offset": str(offset)} if offset is not None else {}
    container = av.open(str(path), "w", options=options)
    stream = container.add_stream("mpeg4", rate=FPS)
    stream.width = 64
    stream.height = 48
    stream.pix_fmt = "yuv420p"
    for index in range(frames):
        image = np.zeros((48, 64, 3), np.uint8)
        image[:, :, 1] = (index * 8) % 256
        frame = av.VideoFrame.from_ndarray(image, format="rgb24")
        frame.pts = index
        for packet in stream.encode(frame):
            container.mux(packet)
    for packet in stream.encode(None):
        container.mux(packet)
    container.close()


@pytest.fixture()
def offset_video():
    TEMP.mkdir(parents=True, exist_ok=True)
    path = TEMP / "video-offset-window.mp4"
    build(path)
    video = VideoFile.open(str(path))
    assert video is not None
    yield video
    video.close()
    path.unlink(missing_ok=True)


def test_window_times_ignore_the_container_start_time(offset_video) -> None:
    frames = offset_video.read_window(0.0, 0.3, FPS, 1.0, 10_000_000)
    assert [frame["pts_us"] for frame in frames] == [0, 100_000, 200_000]
    assert [frame["frame_index"] for frame in frames] == [0, 1, 2]


def test_middle_of_the_file_keeps_media_time(offset_video) -> None:
    frames = offset_video.read_window(1.0, 0.2, FPS, 1.0, 10_000_000)
    assert [frame["pts_us"] for frame in frames] == [1_000_000, 1_100_000]

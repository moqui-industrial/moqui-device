"""Replay a mock detector observation after a GenICam VisualServoFrame.

An optional frame metadata JSON must use the actual service's camelCase outputs.
No camera SDK, image recognition, database, broker or PLC is required.
"""
import argparse
from datetime import datetime, timezone
import json
import math
from pathlib import Path
from urllib.request import Request, urlopen


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:18092/plan")
    parser.add_argument("--frame", type=Path, help="VisualServoFrame output metadata JSON")
    parser.add_argument("--max-age-ms", type=float, default=500)
    args = parser.parse_args()
    frame = json.loads(args.frame.read_text()) if args.frame else {
        "source": "mock-genicam", "capturedAt": datetime.now(timezone.utc).isoformat(),
        "width": 640, "height": 480, "contentType": "image/jpeg",
    }
    captured_at = frame["capturedAt"]
    # GenICam's Python bridge uses Unix seconds; accept RFC3339 adapters too.
    try:
        epoch = float(captured_at)
    except (TypeError, ValueError):
        epoch = None
    if epoch is not None and math.isfinite(epoch):
        timestamp = datetime.fromtimestamp(epoch, timezone.utc)
    else:
        timestamp = datetime.fromisoformat(str(captured_at).replace("Z", "+00:00"))
    if timestamp.tzinfo is None:
        raise ValueError("capturedAt must include timezone")
    age_ms = (datetime.now(timezone.utc) - timestamp).total_seconds() * 1000
    if not 0 <= age_ms <= args.max_age_ms:
        raise ValueError(f"stale/future frame ({age_ms:.1f} ms)")
    request = {"mathModelId": "DemoObstacleCorridorV1", "startPose": [0]*6,
               "goalPose": [1, 0, 0, 0, 0, 0]}

    def plan():
        with urlopen(Request(args.url, data=json.dumps(request).encode(),
                             headers={"Content-Type": "application/json"}), timeout=10) as response:
            return json.load(response)

    before = plan()
    # This fixture represents detector + calibration output, not a GenICam output.
    request["obstacle"] = json.loads(Path(__file__).with_name("fixtures").joinpath("obstacle.json").read_text())
    after = plan()
    assert abs(before["waypoints"][5][1]) < 1e-5
    assert abs(after["waypoints"][5][1] - 0.2) < 1e-5
    print(json.dumps({"frame": frame, "detector": "simulated-calibrated-sphere",
                      "before": before, "after": after}, indent=2))


if __name__ == "__main__":
    main()

# Isolated Rust ONNX obstacle replanning example

This example loads a real ONNX neural network with Rust `ort` and ONNX Runtime
on the CPU. It is an independent Cargo workspace: no Moqui installation,
Mantle, database, MQTT broker, camera SDK or PLC is needed to run its tests.
The same inference source is also used by the optional native Moqui service.
Its HTTP endpoint remains available for an explicitly remote deployment.

The network uses 13 inputs (start TCP pose, goal TCP pose, detour clearance),
a fixed 26-unit ReLU feature layer and a fitted 66-output layer. `train.py`
fits the output weights against synthetic waypoint targets using least squares,
checks the fit, validates the ONNX graph and exports `model.onnx`. Rust loads
that file with `Session::builder().commit_from_file(...)`; every trajectory
comes from `session.run(...)`. Python is needed for export, not inference.

## Build and run on Linux

From this directory, with Rust/Cargo and Python 3.10–3.13:

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python train.py   # optional: model.onnx and tcp12.onnx are committed; this regenerates them
# The wheel supplies the shared library; ort dynamically loads it.
export ORT_DYLIB_PATH="$(.venv/bin/python -c 'import pathlib, onnxruntime; print(next((pathlib.Path(onnxruntime.__file__).parent / "capi").glob("libonnxruntime.so.*")))')"
cargo test --locked
cargo run --locked > report.json
```

`ort` is pinned to `2.0.0-rc.10` (ONNX Runtime API 1.22), tested here with the
1.23.2 runtime from the pinned wheel. An independently installed compatible
ONNX Runtime shared library can also be selected through `ORT_DYLIB_PATH`.
See the [ort loading documentation](https://docs.rs/ort/2.0.0-rc.10/ort/session/builder/struct.SessionBuilder.html).
No runtime binary downloads occur during Cargo build. To load another artifact
with this exact tensor contract, set `TRAJECTORY_ONNX_MODEL=/absolute/model.onnx`.

The report contains two eleven-point TCP trajectories. The first goes from
`[0,0,0,0,0,0]` to `[1,0,0,0,0,0]`. A simulated sphere at `[0.5,0,0]`, radius
`0.12 m` and margin `0.08 m`, triggers replanning: the middle pose becomes
`[0.5,0.2,0,0,0,0]`. Endpoints remain fixed. Rust checks finite coordinates,
output shape and distance to **every complete segment**, including the margin.
Tests execute actual ONNX inference and reject invalid model IDs, frames and
obstacles. Missing models/runtime libraries cause a failure, never a skipped test.

## GenICam boundary and HTTP provider

In one terminal:

```bash
cargo run --locked -- serve
```

In another:

```bash
python3 genicam_demo.py > report.json
# Or supply fresh metadata from acquire#VisualServoFrame:
python3 genicam_demo.py --frame /tmp/genicam-frame.json
```

[moqui-genicam](https://github.com/moqui-industrial/moqui-genicam/tree/mr-moqui)
provides `moqui.genicam.GenicamServices.acquire#VisualServoFrame`, whose outputs
include `frameBytes`, `jpegBytes`, `capturedAt`, `source`, `width` and `height`.
It does **not** currently provide an obstacle detector. `genicam_demo.py` uses
the real metadata field names and Unix-second `capturedAt` values (or RFC3339
with timezone), rejects stale/future frames, then simulates the
separate detector/calibration stage using `fixtures/obstacle.json` and calls
the Rust endpoint twice. It does not inspect image content. For real hardware:

1. acquire the latest frame, with a latency budget;
2. detect the obstacle in the image and calibrate it into the robot's coordinate system;
3. replan from the **current** TCP pose, replacing the remaining trajectory;
4. validate kinematics, swept volume, timing and controller acceptance before dispatch.

The demo accepts one centered spherical obstacle in a fixed unit-X corridor,
in `demo-tcp-metres`, with `radius + margin <= 0.25 m`. The adapter supplies
the positive-Y clearance feature; the learned ONNX output layer produces the
poses. Unsupported cases return HTTP 422. This is a point-path demonstration;
it does not model robot links, tool volume, joint limits or acceleration limits.
Do not send its outputs to a physical controller as a commissioned motion plan.
The loopback-only HTTP server has no production authentication layer.

## Calling from MR-Moqui natively (optional, no Mantle required)

Install only `moqui-math` and `moqui-device`, load their ordinary seeds, then
explicitly register this example from the MR-Moqui framework root:

```bash
./moq load --debug types=test location=runtime/component/moqui-device/examples/onnx-obstacle/ModelData.xml
```

Build the framework with the optional component feature (the component must be
installed under `runtime/component/moqui-device`) and set the runtime library:

```bash
./moq build --debug -- --features moqui-device/onnx
export ORT_DYLIB_PATH=/absolute/path/to/libonnxruntime.so
```

Call the existing service from a server-side JavaScript action. No provider
process or HTTP URL is needed:

```javascript
const result = ec.service.sync()
    .name("moqui.device.TrajectoryPlannerServices.run#RobotArmTrajectoryPlanner")
    .parameters({
        mathModelId: "DemoObstacleCorridorV1",
        onnxProfile: "corridor13",
        startPose: [0,0,0,0,0,0], goalPose: [1,0,0,0,0,0],
        obstacle: {center:[0.5,0,0], radius:0.12, margin:0.08,
                   coordinateFrame:"demo-tcp-metres"}
    }).call();
```

The default `plannerMode=native` invokes
`moqui.device.OnnxServices.infer#TrajectoryWaypoints` in the framework process.
The helper is also directly invocable to obtain waypoints without persistence.
It resolves `MathModelDefContent.contentLocation` with the Moqui resource facade
and uses the process-wide `Onnx` ToolFactory to load and reuse its local/component
file, including external tensors. See [session lifecycle and invalidation](../../README.md#trajectory-planning-on-mr-moqui)
for cache limits, revision tracking and `ec.factory.getTool("Onnx").invalidate(id)`.
The native service loads a model only on a cache miss or artifact revision.
The main planner records the obstacle in `MathModelRun.parameters` and persists
the returned poses in the normal trajectory entities.

The `onnx` Cargo feature is disabled by default; ordinary device use needs neither
ONNX Runtime nor Mantle. A build without it returns a clear error if native
inference is requested. `ort` dynamically loads the shared library on first use.
Java/DJL classes are not used.

For the separate HTTP provider shown above, explicitly set `plannerMode:"remote"`
and `inferenceUrl:"http://127.0.0.1:18092/plan"` in the Moqui call. That provider
owns its model path; a component URI is not automatically mounted on another host.

## Existing Java/DJL trajectory models

Both native mode (`onnxProfile=tcp12`, the default) and the optional Rust
provider can load an existing float32 ONNX trajectory model with
the Java service's `[1,12]` input (`startPose` followed by `goalPose`). It uses
the model's first input/output names and flattens the output into six-coordinate
TCP poses, matching the Java `TrajectoryGenerator` contract:

```bash
export TRAJECTORY_ONNX_PROFILE=tcp12
export TRAJECTORY_MODEL_ID=TrjPlannerMlp6DofV1
export TRAJECTORY_ONNX_MODEL=/absolute/path/to/trajectory_planner.onnx
cargo run --locked -- serve
```

The provider rejects obstacle observations for this profile: the existing
12-input model has no obstacle input. The ONNX operator set must be supported by
the installed runtime. `train.py` also exports `tcp12.onnx`, an independent test
fixture for this tensor contract; it is not the original Java-trained artifact.
The tests exercise both 12-input and 13-input inference. For the obstacle demo,
unset these three variables before starting the server again.

To execute only the native integration features in a loaded disposable database:

```bash
trajectory_native_test=true ./moq test --debug moqui-device --db existing --feature 'native Rust ONNX'
```

Keep `ORT_DYLIB_PATH` set. No HTTP fixture is used by these features.

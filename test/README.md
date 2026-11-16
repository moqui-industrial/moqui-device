Run from the MR-Moqui framework root with this component and moqui-math installed.
Mantle is not required for the base regression suite. `data/DeviceTestData.xml`
is `type="test"` and is loaded by the scratch test runner, not ordinary seed loading.

For the model-only migration gate (no device services or external infrastructure):

```bash
./moq test --nobuild moqui-math moqui-device --spec MathModel,MathViews,DeviceModel --db fresh
```

Build the framework first if no binary is available. These specs create their
own fixtures; they do not exercise the service implementations below.

The component suite, from MR-Moqui after `./moq build --debug -j 4`:

```bash
./moq test --debug moqui-device
```

It needs no driver component. `DeviceRequests.spec.js` covers the recipe export,
the file transfer, the sample store and the gateway scope; its SFTP feature runs
only with `gateway_sftp_test` and a runner that installs the framework's SFTP
client (`moqui test` does not). The requests on the drivers are tested by
moqui-device-gateway, whose `scripts/run-driver-tests.py` also runs this suite.

The Devices app (`/qapps/Devices`) has its regression specs in `Devices/`
(`DevicesAccess`, `DevicesRules`, `DevicesScreens`), its golden-path walk in
`client/Devices/DevicesWalk` and its terminal sweep in `acceptance/Devices/DevicesTui`:

```bash
./moq test --debug moqui-device --spec DevicesAccess
./moq test-client moqui-device --debug --serve
./moq accept moqui-device --spec DevicesTui --debug
```

Optional Mantle WorkEffort/Measurement records are in `test/mantle/MantleTestData.xml`,
outside automatic data discovery. Tests needing that telemetry require installing
mr-mantle and temporarily adding `<depends-on name="mr-mantle"/>` to the test
runtime's moqui-device/component.xml. After normal seeds and base test data, load
that file explicitly:

```bash
./moq load --debug types=test location=runtime/components/addon/moqui-device/test/mantle/MantleTestData.xml
```

Restore the ordinary manifest after testing. Mantle remains optional for users
who do not run these telemetry scenarios.

The normal tests use the test runner's scratch database. Three OpenVLA contract
features require a loopback fixture server, started from the component root:

```bash
python3 test/http_fixture.py --port 18091
```

In another terminal, from MR-Moqui:

```bash
inference_test_url=http://127.0.0.1:18091 ./moq test --debug moqui-device
```

`--db existing` is only for a disposable, already loaded test database; the tests
must not target a production runtime. HTTP checks are explicitly ignored unless
the fixture URL is configured. They check the URL, the JSON bodies and error handling.
Gateway protocol/container tests live in moqui-device-gateway.

For a disposable already loaded database, load the test fixture explicitly:

```bash
./moq load --debug types=test components=moqui-device
inference_test_url=http://127.0.0.1:18091 ./moq test --debug moqui-device --db existing
```

The ONNX planner feature runs `run#RobotArmTrajectoryPlanner` with the bundled
model `data/ml/trajectory_planner.onnx` in the Moqui process, and checks the rows
it writes and that the model is loaded once for two calls. It needs a binary built
with the `onnx` feature and the ONNX Runtime library; it is ignored unless
`trajectory_native_test` is set:

```bash
./moq build --debug -- --features moqui-device/onnx
ORT_DYLIB_PATH=/absolute/path/to/libonnxruntime.so trajectory_native_test=true \
  ./moq test --debug moqui-device
```

With the HTTP fixture running as above, `inference_test_url` also enables the
three OpenVLA features (`run#OpenVla` with the image bytes and the key in the
query, `run#OpenVlaGrounding` with its saved vectors, and an HTTP error). The
unit tests of the `TrajectoryGenerator` tool are `cargo test` in this component.

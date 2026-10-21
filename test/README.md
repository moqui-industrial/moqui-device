Run from the MR-Moqui framework root with this component and moqui-math installed.
Mantle is not required for the base regression suite. `data/DeviceTestData.xml`
is `type="test"` and is loaded by the scratch test runner, not ordinary seed loading.

```bash
./moq test --debug moqui-device
```

Optional Mantle WorkEffort/Measurement records are in `test/mantle/MantleTestData.xml`,
outside automatic data discovery. Tests needing that telemetry require installing
mantle-udm and temporarily adding `<depends-on name="mantle-udm"/>` to the test
runtime's moqui-device/component.xml. After normal seeds and base test data, load
that file explicitly:

```bash
./moq load --debug types=test location=runtime/component/moqui-device/test/mantle/MantleTestData.xml
```

Restore the ordinary manifest after testing. Mantle remains optional for users
who do not run these telemetry scenarios.

The normal tests use the test runner's scratch database. Two HTTP contract
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
the fixture URL is configured. They check headers, JSON bodies and error handling.
Gateway protocol/container tests live in moqui-device-gateway.

For a disposable already loaded database, load the test fixture explicitly:

```bash
./moq load --debug types=test components=moqui-device
inference_test_url=http://127.0.0.1:18091 ./moq test --debug moqui-device --db existing
```

The optional actual ONNX/provider integration feature uses
`trajectory_onnx_test_url=http://127.0.0.1:18092`. First generate/start the
[isolated Rust provider](../examples/onnx-obstacle/README.md) and explicitly load
its `ModelData.xml` into the test database. The feature is ignored unless that
URL is supplied. Standalone Rust inference tests need no Moqui or Mantle.

To run **only** the actual ONNX integration in a disposable runtime containing
just moqui-math and moqui-device (no Mantle), load ordinary seeds and the example's
`ModelData.xml`, start its provider, and select that feature:

```bash
trajectory_onnx_test_url=http://127.0.0.1:18092 \
  ./moq test --debug moqui-device --db existing --feature 'actual Rust ONNX'
```

The native ONNX features require the optional `moqui-device/onnx` build feature,
`ORT_DYLIB_PATH`, and the example's `ModelData.xml`. Run them without any HTTP
provider or Mantle in a disposable runtime containing only moqui-math/moqui-device:

```bash
trajectory_native_test=true ./moq test --debug moqui-device --db existing --feature 'native Rust ONNX'
```

The full suite enables both native and optional remote checks when both sets
of environment variables are configured.

The native factory feature additionally verifies session reuse, explicit
invalidation and reload after a `MathModelDefContent.contentDate` revision. It
uses real ONNX Runtime sessions, with no remote provider.

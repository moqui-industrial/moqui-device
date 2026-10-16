Run from the MR-Moqui framework root with this component, moqui-math and
mantle-udm installed **for this suite only**. Normal use of moqui-device requires
only moqui-math. The canonical `data/DeviceTestData.xml` is `type="test"` and
contains Mantle WorkEffort/Measurement records. In the test runtime, temporarily
add this dependency to `moqui-device/component.xml` to establish load order:

```xml
<depends-on name="mantle-udm"/>
```

Restore the production manifest after testing. The default scratch database loads
all data types, including `test`:

```bash
./moq test --debug moqui-device
```

The normal tests use the test runner's scratch database. Two HTTP contract
features require a loopback fixture server, started from the component root:

```bash
python3 test/http_fixture.py --port 18091
```

In another terminal, from MR-Moqui:

```bash
gateway_test_url=http://127.0.0.1:18091 ./moq test --debug moqui-device
```

`--db existing` is only for a disposable, already loaded test database; the tests
must not target a production runtime. HTTP checks are explicitly ignored unless
the fixture URL is configured. They check headers, JSON bodies and error handling.
Gateway protocol/container tests live in moqui-device-gateway.

For a disposable already loaded database, load the test fixture explicitly:

```bash
./moq load --debug types=test components=moqui-device
gateway_test_url=http://127.0.0.1:18091 ./moq test --debug moqui-device --db existing
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

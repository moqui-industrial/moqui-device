Run from the MR-Moqui framework root with this component, moqui-math and
mantle-udm installed:

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

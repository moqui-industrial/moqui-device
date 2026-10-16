# Validation — 2026-10-16

Environment: Linux x86_64, Rust 1.99.1, MR-Moqui master `ab88f80`, PostgreSQL
18.1 in the disposable gateway test container, Artemis MQTT broker. Inference
uses `ort 2.0.0-rc.10`, ONNX Runtime 1.23.2 CPU, ONNX 1.19.0 and NumPy 2.2.6.

| Check | Result |
| --- | --- |
| Default data load with framework + moqui-math + moqui-device, without Mantle | 4,075 records loaded; no Mantle WorkEffort table and no canonical test gateway record |
| Explicit registration of ModelData.xml without Mantle | 3 model records loaded |
| Rust example tests with actual ONNX Runtime | 4 passed: obstacle detour, complete segment distance, invalid observations/model IDs, Java-compatible 12-input contract |
| Rust example formatting and Clippy with warnings denied | Passed |
| Full moqui-device component specs, with optional Mantle fixtures and both loopback providers enabled | 10 passed, no ignored/skipped features |
| ONNX feature alone in the runtime without Mantle | 1 passed; database values verify middle Y changes from 0 to 0.20 m and obstacle metadata is recorded |
| GenICam metadata replay | Fresh numeric Unix timestamp accepted; stale timestamp rejected; HTTP ONNX detour verified |
| Gateway regression suite | 8 passed; 10 live tests explicitly ignored in the default command |
| Gateway PostgreSQL/Artemis tests explicitly enabled | 7 passed, including MQTT inbound/outbound and scoped trajectory publication |
| XML service/component schemas and artifact/data checks | Passed; artifact checker retains 15 existing advisory direct-create warnings |

Commands and setup are in [README.md](README.md) and
[the component test instructions](../../test/README.md). The original Java
trained model binary was not available: the 12-input check uses the independently
exported `tcp12.onnx` fixture. No camera image recognition, physical PLC execution,
robot kinematics or production OPC UA security commissioning was performed.
The example does not claim full Java/Rust parity; remaining gateway differences
are documented in the branch READMEs.


Native-service follow-up: the default planner now calls the optional Rust
`infer#TrajectoryWaypoints` service in the framework process. It resolves the
registered component/local ONNX path; no HTTP provider is involved in the two
native integration features. Both the 12-input and obstacle profiles passed.
The optional example registration now loads six records (two models).
The 21 Mantle telemetry records have moved outside automatic data discovery to
`test/mantle/MantleTestData.xml`; the base fixture loads 176 records without Mantle.
The combined moqui-device/GenICam suite passed all 18 features without Mantle
with every optional provider/native feature enabled. Native-feature-disabled compilation and native
feature compilation/Clippy were checked separately. See the GenICam validation
record for its worker, binary, persistence and retention checks.

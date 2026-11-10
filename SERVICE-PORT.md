# Common Device Services

## Ownership

`moqui-device` owns the model and protocol-neutral application services, declared
in `service/moqui/device/DeviceServices.xml` and `TrajectoryPlannerServices.xml`.
The layout is the one of mr-mantle:

- Each service declares its parameters in XML. A Groovy service written as XML Actions
  stays XML Actions, with JavaScript expressions (`run#DeviceRequest`,
  `run#DeviceRequestGroup`, `receive#GatewayRequestCallback`, the DeviceContent
  services, `export#DeviceConfig`, `transfer#DeviceContent`).
- The logic of a Groovy script is in the JavaScript library
  `service/moqui/device/Devices.js`, which the service calls with
  `ec.resource.script(...).execute(operation, context)`, as the Mantle libraries
  (`Payables.js`, `Quality.js`) are called: `notify` (`send#DeviceNotification`),
  `applyConfig` (`apply#DeviceConfig`) and `configExportFiles`
  (`get#DeviceConfigExportFiles`).
- The Groovy class `org.moqui.device.TrajectoryGenerator` of the trajectory planner,
  and the work of the planner's scripts on bytes and numbers, is the Rust tool
  `TrajectoryGenerator` (`src/trajectory.rs`); ONNX Runtime takes the place of DJL.
- Rust also handles sample persistence and the bytes of a DeviceContent.

No JDBC, raw SQL, HTTP gateway client or protocol library is required here.

`moqui-device-gateway` supplies local native implementations of
`run#DeviceRequestInternal`. Its optional Moqui binding translates the resolved
context into the reusable Rust `DeviceFacade` API. That trait and the transport
implementations must remain usable without Moqui, including by a future RuSTy
host in moqui-plc. A RuSTy caller supplies its own configuration and sample sink;
it must not need an ExecutionContext, an Entity Engine or Moqui service calls.
This reuse does not establish hard-real-time or safety guarantees.

## Migration Map

Reference sources: moqui-device Java/Groovy `0b03e51` (branch `main`), moqui-device-gateway
Java/Camel `8b6d90d`, and the original PLC4J FieldbusClient/Plc4jUtil.

The port restarts from the Groovy version. The services of the Groovy
`DeviceServices.xml` keep their names, parameters and behaviour, written as XML
Actions and JavaScript in the mr-moqui and mr-mantle style:

| Groovy service | Port |
| --- | --- |
| `send#DeviceNotification` | Same name; Mantle notification pattern (see below) |
| `receive#GatewayRequestCallback` | Same name and parameters; called locally, so no longer `allow-remote` |
| `apply#DeviceConfig` | Same contract |
| `run#DeviceRequestGroup` | Same contract; `distribute=true` is an error (no distributed dispatch on MR-Moqui) |
| `run#DeviceRequest` | Same contract: a dispatcher to `DeviceRequest.runServiceName` |
| `run#DeviceRequestInternal` | Same interface: device, request, connection, requestItemList, bulkRequestItemList |
| DeviceContent services | Same contracts, on MR resources and FileItem |

The export and transfer routes of the Camel gateway (`DeviceGatewayServices.xml`
of the Groovy version) are local services in `DeviceServices.xml`:

| Groovy/Camel | Port |
| --- | --- |
| `export#DeviceConfig` (route `run-device-config-export`) | `get#DeviceConfigExportFiles` renders the recipe, `export#DeviceConfig` sends it with `transfer#DeviceContent` |
| `transfer#DeviceContent` (Camel file/SFTP route) | `transfer#DeviceContent` hands the files to the implementation of the DeviceRequest (`runServiceName`) |

`TrajectoryPlannerServices.xml` keeps the services of the Groovy version with their
names and parameters:

| Groovy | Port |
| --- | --- |
| `TrajectoryGenerator.normalizePoseVector` | `TrajectoryGenerator.normalizePoseVector` (Rust tool), the same checks and messages |
| `TrajectoryGenerator.runInference` (DJL) | `TrajectoryGenerator.runInference` (ONNX Runtime, the `onnx` feature); a local model stays loaded while its file is unchanged |
| image read and Base64 in `run#OpenVla` and `run#OpenVlaGrounding` | `TrajectoryGenerator.imageBase64` |
| `normalizeNumberList` in `run#OpenVlaGrounding` | `TrajectoryGenerator.normalizeNumberList` |
| `createVector` in `run#OpenVlaGrounding` | The same closure in JavaScript |
| `call#OpenVla`, `call#OpenVlaGrounding` (`remote-rest`, `location="${openVlaLocation}"`) | Same names and parameters, a JSON POST with `ec.service.rest()`: MR-Moqui percent-encodes a parameter in a `remote-rest` location, so a whole URL cannot be one |
| `run#RobotArmTrajectoryPlanner` | Same contract and the same rows (vectors, function, path, trajectory, samples, points, run, perf, model data) |

The services the Rust port had added to the planner (planner modes `native`,
`remote` and `linear-demo`, the obstacle profile, `OnnxServices.infer#TrajectoryWaypoints`
and the `Onnx` tool, `call#InferenceEndpoint`, `get#DeviceImage`, `check#Pose`,
`check#NumberList`, `create#PoseVector`, `infer#PlannerWaypoints`, and the names
`TrajectoryPlannerServices.get#TrajectoryAxes` and `export#Trajectory`) are removed.
The crate `examples/onnx-obstacle` is a separate experiment and is unchanged.

The other services of `DeviceGatewayServices.xml` (`run#GatewayDeviceRequest`,
`export#Trajectory`, `receive#GatewayNotification`) and the services the Rust
gateway added (gateway scope, startup subscriptions, sample persistence and its
notices) are reviewed in the next step. Until then they stay in their sections
of `DeviceServices.xml`. `DeviceConfigServices.xml`, which only repeated
`get#DeviceConfigExportFiles` and `export#DeviceConfig` under other names, is removed.

## Preserved Contracts And Corrections

- `run#DeviceRequest` loads the request, its device, connection and items, filters
  an onlyChanged write by `EntityAuditLog` since `DeviceRequest.lastUpdatedStamp`,
  and calls `runServiceName`. It does not read files, render recipes, retry, store
  read samples, notify or check a gateway scope: those belong to the implementation
  or to the caller. Retrying an uncertain write is the caller's decision.
- One correction to the Groovy version: when every item of an onlyChanged write is
  unchanged and there is no bulk item, the request stops, even when it has a query.
  The Groovy version went on in that case, so an unchanged write still reached the
  device through the gateway.
- `send#DeviceNotification` follows Mantle (`notify#TaskAssigned`): the message holds
  deviceId, deviceName, requestName, eventType, title and text; the Device is the
  record; the reason is `NrSystem`; the sender is the actor. The recipients are the
  members of the user groups with the permission `DEVICE_NOTIFY` (ADMIN in the seed
  data), besides the sender, plus the userIds given and the topic's subscribers. The
  topics of `DeviceData.xml` give the type, the alert, the inbox and the title. A
  notice that fails is logged; the caller's work stands.
- `receive#GatewayRequestCallback` chooses the topic from the event:
  `DeviceGatewayRequestCompleted`, `DeviceGatewayRequestFailed` or `DeviceGatewayRequest`.
- `transfer#DeviceContent` checks that the content belongs to the request's device
  before reading its bytes.
- `save#DeviceContentFile` accepts a file name, not a path, and a DeviceContent of
  the device given; the Groovy version and Mantle's `save#PartyContentFile` do not
  check either.
- Samples commit independently of the caller, in chunks of 1000 per
  transaction with the caller's transaction suspended: reads first, then the
  writes pipelined, as a data load does. A sample that fails validation is
  reported and skipped without affecting the others; when a chunk's
  transaction fails while the database answers, its samples are stored one by
  one, so a bad row cannot roll back valid ones. When the database does not
  answer, `retryable` and `retryFromIndex` tell the caller what to send again.
  A logging sample with the device time or the sequenceNum of a stored row is
  a `duplicate`, so a broker redelivery adds no row.
- Recipe export preserves selectors, value precedence, names, priority files,
  trajectory/blending rows and ordering from the original SQL. Deduplication
  includes the target, so one shared DeviceConfig can supply multiple devices.
- FileItem's historical type name is the MR framework's native upload contract,
  not a dependency on the Java upload library. Upload/update are regression-tested.

Removed with the restart, as they are not in the Groovy version: the retries of
uncertain writes (`invoke#DeviceImplementation`, `maxAttempts`, `operationId`), the
redundant destinations (`parentRequestName` mirrors), the JSON `payload` of a write,
the pre-resolved parameterList/parameterDefList for drivers, the read-sample storage
and acquisition notices inside `run#DeviceRequest`, and `notify#DeviceRequestResult`.

## Verification And Remaining Boundary

Build from mr-moqui with `./moq build --debug -j 4` and run the component specs
with `./moq test moqui-device`. Inference and provider cases are opt-in (see
`test/README.md`). No gateway component, broker, PLC, GPU or Node.js is needed.

The review of Java/PLC4J request configurations for the gateway services, and the
runners for the gateway service policies, are not part of this pass; they return
with the gateway services.

**Known framework gap:** distributed service dispatch is not implemented by this
MR host. `distribute=true` fails explicitly before any I/O; it is not equivalent
to Java's distributed mode and must not be silently mapped to local async work.

The gateway services are the next step: the services of `DeviceGatewayServices.xml`
become local services, implemented here or in the mr-moqui branch of
moqui-device-gateway. Until then the gateway's own tests that rely on the removed
`run#DeviceRequest` features (status outputs, retries, payload, read storage) fail.

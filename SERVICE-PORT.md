# Port from the Groovy Version

## Ownership

`moqui-device` owns the model and the protocol-independent services, declared in
`service/moqui/device/`: `DeviceServices.xml` (the Groovy services, the recipe
export, the file transfer, the trajectory export), `DeviceAcquisitionServices.xml`
(gateway scope, restart of subscriptions, storage of the values read or received)
and `TrajectoryPlannerServices.xml`. The layout is the one of mr-mantle:

- Each service declares its parameters in XML. A Groovy service written as XML Actions
  stays XML Actions, with JavaScript expressions (`run#DeviceRequest`,
  `run#DeviceRequestGroup`, the DeviceContent
  services, `export#DeviceConfig`, `transfer#DeviceContent`).
- The logic of a Groovy script is in the JavaScript library
  `service/moqui/device/Devices.js`, which the service calls with
  `ec.resource.script(...).execute(operation, context)`, as the Mantle libraries
  (`Payables.js`, `Quality.js`) are called: `notify` (`send#DeviceNotification`),
  `applyConfig` (`apply#DeviceConfig`), `configExportFiles`
  (`get#DeviceConfigExportFiles`) and `transferFiles` (the `file:` and `sftp://`
  destinations of `export#DeviceConfig` and `transfer#DeviceContent`).
- The Groovy class `org.moqui.device.TrajectoryGenerator` of the trajectory planner,
  and the work of the planner's scripts on bytes and numbers, is the Rust tool
  `TrajectoryGenerator` (`src/trajectory.rs`); ONNX Runtime takes the place of DJL.
- Rust also handles sample persistence (`src/inbound.rs`, the role of
  `Plc4jUtil.createOrUpdateBulk`), the restart of subscriptions
  (`src/restoration.rs`, tool `DeviceSubscriptions`) and the bytes of a
  DeviceContent (`src/content.rs`).

No JDBC, raw SQL, HTTP gateway client or protocol library is required here, and
no driver service is named, in the services or the data.

The drivers are a separate component, as moqui-plc4j was: on MR-Moqui
`moqui-device-gateway` (branch `mr-moqui`), which depends on this one. Its
`moqui.device.gateway.DeviceGatewayServices.run#DeviceGatewayRequest` implements
`run#DeviceRequestInternal`, as `moqui.plc4j.Plc4jServices.run#Plc4jRequest` did,
and dispatches through Rust objects to the FieldbusClient of the protocol, on the
conventions of PLC4X; its data set the `runServiceName` of the fieldbus requests,
and it hands what it reads to `DeviceAcquisitionServices.store#Samples`. Its Rust
facade stays usable without Moqui, for example by a future RuSTy host in
moqui-plc. This reuse does not establish hard-real-time or safety guarantees.

## Model

The entities, view-entities and data restart from the Groovy version (`main`,
`0b03e51`): the same entity and field names and the same seed, demo and test
rows; no table, field or primary key is removed. Entity definitions and data stay
XML; defaults and notification templates use JavaScript expressions. What differs:

- `PhysicalDevice.groups` joins `deviceId` to `DeviceGroupMember.memberDeviceId`.
- The `Parameter` and trajectory-run extensions leave out the attributes the
  MR-Moqui schema does not take (`use`, `short-alias`); an extension is documented
  with an XML comment where the schema permits no description.
- `TrajectoryPlannerData.xml`: the key of `MathModelDefContent` is
  `mathModelDefContentId`, as moqui-math defines it.
- `DeviceTestData.xml` is `type="test"`; its Mantle rows (WorkEffort,
  MeasurementType, Measurement) are in `test/mantle/MantleTestData.xml`, since
  moqui-device does not depend on Mantle. `TrajectoryRecipeTestData.xml` holds the
  trajectory recipe of the Camel gateway's export tests.
- The notification topics have fixed names (the Groovy keys had expressions) and
  the permission `DEVICE_NOTIFY`.
- The driver enumeration adds `DcdMqtt`, `DcdFile`, `DcdSftp` and `DcdEtherCAT`.
- Not on this branch: the IEC 62443 data and `HVACDemoGatewayData.xml`.

## Migration Map

Reference sources: moqui-device Java/Groovy `0b03e51` (branch `main`), moqui-device-gateway
Java/Camel `8b6d90d`, and the original PLC4J FieldbusClient/Plc4jUtil.

The port restarts from the Groovy version. The services of the Groovy
`DeviceServices.xml` keep their names, parameters and behaviour, written as XML
Actions and JavaScript in the mr-moqui and mr-mantle style:

| Groovy service | Port |
| --- | --- |
| `send#DeviceNotification` | Same name; Mantle notification pattern (see below) |
| `receive#GatewayRequestCallback` | Removed: it was the REST endpoint the Camel gateway called after a write or an export. A service called from a screen or a job returns its error; work no caller sees (subscriptions) is notified by `DeviceAcquisitionServices` |
| `apply#DeviceConfig` | Same contract |
| `run#DeviceRequestGroup` | Same contract; `distribute=true` is an error (no distributed dispatch on MR-Moqui) |
| `run#DeviceRequest` | Same contract: a dispatcher to `DeviceRequest.runServiceName`, which is required. It also returns the outputs of the request (`status`, `errorMessage`, ...), passes an MQTT `payload`, and records subscriptions for their restart (`record#SubscriptionState`) |
| `run#DeviceRequestInternal` | Same interface: device, request, connection, requestItemList, bulkRequestItemList |
| DeviceContent services | Same contracts, on MR resources and FileItem |

The Groovy `DeviceGatewayServices.xml` called the Camel gateway over REST, through
routing requests (`routerEnumId="DrrMoquiDeviceGateway"`) that named the real
request in their `query`. It is not kept: no compatibility is maintained. The
Camel routes became these services:

| Groovy service / Camel route | Now |
| --- | --- |
| `run#GatewayDeviceRequest` / `dispatch-device-request` | The request itself names `run#DeviceGatewayRequest` (moqui-device-gateway) in `runServiceName` |
| `export#DeviceConfig` / `run-device-config-export`, `transfer-file` (and `file.transfer.uri.2`) | `DeviceServices.export#DeviceConfig`: `get#DeviceConfigExportFiles` (the export SQL on the Entity Engine) renders the files; they are written to the `DeviceConnection` of the request, else to `device_config_export_location` (and `_2`) |
| `transfer#DeviceContent` / `transfer-device-content` | `DeviceServices.transfer#DeviceContent`: the file goes to the `file:` or `sftp://` destination of the request (resource facade, `SftpClient`); no Base64 REST hop |
| `export#Trajectory` / `/api/trajectory/export` (advertised, never exposed by the gateway) | `DeviceServices.export#Trajectory`: `get#TrajectoryAxes`, then one MQTT payload message through `run#DeviceRequest` |
| `receive#GatewayNotification` / `InboundErrorNotifier` | The sample worker of moqui-device-gateway calls `DeviceAcquisitionServices.notify#InboundState` |
| `mqtt-read-*`, `opcua-read-*` consumers | `run#DeviceGatewayRequest` subscriptions in moqui-device-gateway |
| `store-device-request-inbound`, `store-parameter-batch`, `store-log-batch` | `DeviceAcquisitionServices.store#Samples` (current values or `ParameterLog`, by purpose) |
| `plc-log-consumer`, `plc-log-ingest-*` | `run#PlcLogRequest` of moqui-device-gateway, then `DeviceAcquisitionServices.store#LogSamples` (`ParameterLog` with a source, `DeviceLog` without) |
| `after-store-callback` | SECAs on `DeviceAcquisitionServices.after#Samples` |
| startup subscription discovery, gateway scope | `DeviceAcquisitionServices.get#GatewayScope`, `get#StartupSubscriptions`, `start#Subscriptions` (service job `start_DeviceGatewaySubscriptions`) |

Data changes: the routing requests are removed, and the requests that did the
work take the names the device screens look for (`{deviceId}_SyncParameters`,
`{deviceId}_TransferContent`); the export requests (`{deviceId}_ExportProcess`)
belong to the device; `ROBOT_ARM_TRAJECTORY_EXPORT` has the broker as `brokerUri`
and a timeout in milliseconds; the driver enumeration has `DcdMqtt`, `DcdFile`,
`DcdSftp` and `DcdEtherCAT`. Polling is a `DrtRead` with a `pollingInterval`;
`DrtCyclic` is a subscription sampled by the device, which MQTT does not have, so
the MQTT test requests that were `DrtCyclic` are `DrtSubscribe`.

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

`DeviceConfigServices.xml`, which only repeated `get#DeviceConfigExportFiles` and
`export#DeviceConfig` under other names, is removed.

## Preserved Contracts And Corrections

- `run#DeviceRequest` loads the request, its device, connection and items, filters
  an onlyChanged write by `EntityAuditLog` since `DeviceRequest.lastUpdatedStamp`,
  and calls `runServiceName`. It does not read files, render recipes, retry, store
  read samples, notify or check a gateway scope: those belong to the implementation
  or to the caller. Retrying an uncertain write is the caller's decision. For a
  subscription, a polling `DrtRead` or an unsubscribe it calls
  `record#SubscriptionState`, so that `start#Subscriptions` restores what should run.
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
- The notification topics are `DeviceInboundFailed` and `DeviceInboundRecovered`
  (`DeviceGatewayInbound*` in the Groovy version); the `DeviceGatewayRequest*`
  topics of the gateway callback are removed with it.
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
  a `duplicate`, so a broker redelivery adds no row. A current value is compared
  with the `Parameter` of the entity cache, so an unchanged value of a polling
  cycle costs no database read; only the Parameters that change are read again,
  locked, and written. This holds on one node, since the Entity Engine clears
  the cache on every write.
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
with `./moq test moqui-device`; it needs no driver component. Check the model and
data with `moqui check runtime/component/moqui-device/entity runtime/component/moqui-device/data`. Inference, provider
and SFTP cases are opt-in (see `test/README.md`). The requests on the drivers,
with local Modbus, OPC UA and MQTT peers, and the acceptance runs (broker loss,
database outage, restart) are those of moqui-device-gateway.

**Known framework gap:** distributed service dispatch is not implemented by this
MR host. `distribute=true` fails explicitly before any I/O; it is not equivalent
to Java's distributed mode and must not be silently mapped to local async work.

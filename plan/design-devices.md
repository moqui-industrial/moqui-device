# IronStone Devices — Design

Nov 16, 2026

The Devices app: the plant's devices, their groups, configurations and processes, for the engineers who model them and
the operators who run requests on them. It replaces the device screens of the Java SimpleScreens fork
(`moqui-industrial/SimpleScreens`, branch `device`: `screen/SimpleScreens/Device*`), rebuilt on MR Moqui as an IronStone
app: the archetypes and widget rules of mr-boss's [style guide](../../mr-boss/plan/style-guide.md), the practices of
[Practices-App-Dev](../../../../../docs/dev/Practices-App-Dev.md), and access checked in services from permissions.

The app lives in moqui-device, not in mr-boss: it reads only moqui-device's and moqui-math's entities, and mr-boss
depends on mr-mantle alone, so a suite without devices installs no device screens. moqui-device's `MoquiConf.xml`
mounts it beside the BOSS apps (`/qapps/Devices`). It uses no mr-boss or mr-mantle artifact.

Sections: [1 the app](#1-the-app) · [2 access](#2-access) · [3 screens](#3-screens) · [4 services](#4-services) ·
[5 from the Java screens](#5-from-the-java-screens) · [6 tests](#6-tests)

## 1. The app

### 1.1 Users

| User | Does | Permissions |
| --- | --- | --- |
| Reader (maintenance, quality, a supervisor) | Reads devices, groups, members, parameters, configurations and processes | `DEVICE_VIEW` |
| Engineer | Models the plant: edits configurations, processes and their tasks, parameter values, device content | `DEVICE_VIEW`, `DEVICE_EDIT` |
| Operator | Runs the requests that reach the plant: applies a process task, exports a process recipe, synchronizes parameters, transfers content | `DEVICE_VIEW`, `DEVICE_OPERATE` |
| Administrator (`ADMIN`) | All of the above | all three |

`DEVICE_EDIT` and `DEVICE_OPERATE` read nothing on their own (Practices-App-Dev §3, "Reads come from view
permissions").

### 1.2 Menu

| Menu | Screen | Archetype |
| --- | --- | --- |
| Home | `Devices/Home` | Landing (§3.1) |
| Devices | `Devices/Devices/Find`, `DeviceDetail` (hidden) | List, Detail |
| Groups | `Devices/Groups/Find`, `GroupDetail` (hidden) | List, Detail |
| Configurations | `Devices/Configs/Find`, `ConfigDetail` (hidden) | List, Detail |
| Processes | `Devices/Processes/Find`, `ProcessDetail` (hidden) | List, Detail |

Words: the Java screens' "Device Process" is a `DeviceRuleSet` and its "Task" a `DeviceRule`; the app keeps those words
(Process, Task), and Configuration for a `DeviceConfig`.

## 2. Access

- Permissions `DEVICE_VIEW`, `DEVICE_EDIT`, `DEVICE_OPERATE` (seed, `DeviceData.xml`); user groups `DEVICES` (the launcher
  and `DEVICE_VIEW`), `DEVICES_ENGINEER` (`DEVICE_EDIT`) and `DEVICES_OPERATOR` (`DEVICE_OPERATE`); `ADMIN` holds all three.
- The artifact group `DEVICES`: the root screen `component://moqui-device/screen/Devices.xml` and the services
  `moqui.device.DeviceAppServices.*`, inheritable; `AUTHZT_ALWAYS` for `ADMIN`, `AUTHZT_ALLOW` for `DEVICES`. The grant
  opens navigation only: every app service checks the permission of what it reads or writes
  (`DevicesApp.js` `require`), and refuses with the reason code `DEVICE_PERMISSION` (Practices-App-Dev §3).
- The root's `always-actions` call `get#SharedContext`, which gives the capabilities (`read`, `edit`, `operate`) and
  the links of the app (`sharedLinks`); a menu entry, a dialog or an action shows by capability, and the service it
  calls checks again.
- No raw `update#moqui.device.*` or `moqui.device.DeviceServices.*` is granted by the app: the operator's requests go
  through `DeviceAppServices`, which check `DEVICE_OPERATE` and then call `DeviceServices` as the system.

## 3. Screens

### 3.1 Home (Landing)

Counters (`number-card`s in a `dashboard`), each a link into its list: devices, groups, group members that are not
alive (Down, Fault, Error) into the Groups list, processes, configurations. Nav cards for the four areas. A box
"Members not alive", ten rows, each linking its group. Empty state: no devices yet, with a pointer to the data load
(devices come from the engineering model, not from a form).

### 3.2 Devices › Find (List)

The physical devices (a `PhysicalDevice` row): id and name, type, purpose, status (chip), current process and task,
vendor and model, serial. Finds in Find Options: text (id, name, serial, vendor, model; case-insensitive), type,
purpose, status. Paged by the service. Phone columns: name with id; status with type.

### 3.3 Devices › DeviceDetail (Detail)

Record header: the id chip and name, a caption (type · vendor model · location), the status chip; actions by
capability: **Apply task** (primary, operator), and More: Export process recipe (operator, when
`{deviceId}_ExportProcess` exists and a process is set), Synchronize parameters (operator, when
`{deviceId}_SyncParameters` exists), All devices. Tabs:

| Tab | Content |
| --- | --- |
| Overview | Identity (vendor, model, versions, OS, application, serial, UUID, location, cycle time), the current process and task with links, the parent device, the groups it is a member of |
| Parameters | The device's parameters (`ParameterDetail` by `deviceId`): code, name, type, value, unit, range; the engineer edits a value in the row (`update#ParameterValue`) |
| Content | The device's files (`DeviceContent`): type, file, description, who and when; Add, Edit, Delete (engineer), Download (reader), Transfer (operator, when `{deviceId}_TransferContent` exists) |
| Observability | A logged parameter over time and the device log (§3.8), in place of the Java screens' Grafana panels |

Not available: a device that does not exist says so and links back to the list.

### 3.4 Groups › Find (List) and GroupDetail (Detail)

The list: groups (a `DeviceGroup` row) with name, type, purpose, status, member count, the controller. GroupDetail shares
the device detail's template (one template, the record kind set by each route, Practices-App-Dev §5): the header with
the controller (the first alive member with a controller purpose, `DgmpController` or a child, that is a physical device),
the same primary action and More; the export and synchronization go to the controller's requests
(`{controller}_ExportProcess`, `{controller}_SyncParameters`), the transfer to `{groupId}_TransferContent`. A task that
targets another device is refused for the group. Tabs: Overview, Members (purpose, sequence, status chip, each
member linking its detail), Parameters (the group's and its members', with their device), Content.

### 3.5 Configurations › Find and ConfigDetail

The list: name, type, purpose, device type, control method, trajectory, dates. The detail: header (id, name, type ·
purpose caption); tabs Overview (an Edit dialog for the engineer: control method, trajectory, name, description, dates)
and Parameters (the configuration's own parameters: `deviceConfigId` with no `deviceId`, values edited in the row).

### 3.6 Processes › Find and ProcessDetail

The list: name, purpose, parent, sequence, dates; New process (engineer, a dialog). The detail: header (id, name,
purpose caption), Edit in More; tabs Overview (fields, the devices running it) and Tasks (the `DeviceRule`s by
priority: device, type, configuration with its link, name, priority, dates; New task, Edit and Delete in the row for
the engineer, Delete confirmed with the task's name).

### 3.7 Choices

One `choices` transition (`template/DevicesParts.xml`) over `get#Choices`, a table of named sources, each searched in
the query and reading a selected value outside the page: `devices`, `processes` (of a device: its own and the
unassigned ones), `tasks` (of a process, for a device: those with no device or this device), `configs`, `trajectories`,
and the enumerations `deviceTypes`, `devicePurposes`, `controlMethods`, `processPurposes`, `taskTypes`, `contentTypes`.

### 3.8 Observability (a tab of DeviceDetail and GroupDetail)

In the style of System › Monitor › Metrics: a picker of a logged parameter (the device's, or a group's and its
members', through nested groups) and a range (last hour, day, week, month, year, all), the parameter's `ParameterLog` drawn over time by a
`report-panel` (a time series of numbers; texts listed in a table), and the `DeviceLog` rows of the same devices in the
range, newest first, paged. `get#Observability` builds the frame and the page. In the browser the tab is a `.qvue` (Practices-App-Dev §6: XML
widgets cannot redraw a part of a page in place): it reads its data from the screen's `observabilityData` transition and,
with auto refresh on (off, 10 s, 30 s, 1 min, 5 min), reads it again while the page is in view, redrawing the chart and the
log only. The terminal and print render the XML widgets. Observability is the first tab of a device and a group, and the one a link to the record opens.

## 4. Services

`service/moqui/device/DeviceAppServices.xml`, the logic in `DevicesApp.js` (one module, an operations table):

| Service | Permission | Does |
| --- | --- | --- |
| `get#SharedContext` | — | Capabilities and links; never refuses (a user without `DEVICE_VIEW` gets no capability) |
| `get#Home` | view | Counters and the members not alive |
| `find#Devices` | view | Devices or groups (`kind`), filtered and paged, with display texts |
| `get#Device` | view | One device or group: header, identity, process and task, groups or members, controller, the requests available |
| `find#Parameters` | view | A device's or a configuration's parameters, paged |
| `update#ParameterValue` | edit | A parameter's numeric, symbolic or enumeration value (only those of a device or a configuration) |
| `find#Configs`, `get#Config`, `update#Config` | view, view, edit | Configurations |
| `find#Processes`, `get#Process`, `store#Process` | view, view, edit | Processes |
| `store#Task`, `delete#Task` | edit | A task of a process |
| `store#Content`, `delete#Content` | edit | A device's content (`DeviceServices.create#`/`update#DeviceContent`) |
| `get#ContentFile` | view | The location of a content's file for its download, after the device check |
| `apply#Task` | operate | Checks the task belongs to the process and may run on the device, applies its configuration (`apply#DeviceConfig`) and sets the device's process and task |
| `export#Process` | operate | The process recipe to the device's (a group's controller's) export request (`export#DeviceConfig`) |
| `sync#Parameters` | operate | Runs the device's (controller's) `_SyncParameters` request |
| `transfer#Content` | operate | Runs `transfer#DeviceContent` with the device's `_TransferContent` request |
| `get#Observability` | view | The chosen parameter's log as a report frame and the device log, in a range (§3.8) |
| `get#Choices` | view | The choice sources of §3.7 |

## 5. From the Java screens

| Java screen | Here |
| --- | --- |
| `Device.xml`, `dashboard.xml` (four links) | Root and Home (§3.1) |
| `Device/FindDevice`, `EditDevice`, `FindParameter` | Devices › Find, DeviceDetail with Overview, Parameters, Content |
| `Device/DeviceObservability`, `DeviceGroup/DeviceObservability` (Grafana) | The Observability tab of DeviceDetail and GroupDetail (§3.8): a report panel, as System › Monitor › Metrics draws, instead of the Grafana iframe; the Grafana panel of `EditDevice` and `EditDeviceGroup` is not carried over |
| `DeviceGroup/FindDeviceGroup`, `EditDeviceGroup`, `EditDeviceGroupMembers`, `FindParameter`, `DeviceObservability` | Groups › Find, GroupDetail with Members, Parameters, Content |
| `DeviceConfig/FindDeviceConfig`, `EditDeviceConfig`, `FindParameter` | Configurations › Find, ConfigDetail |
| `DeviceRuleSet/FindDeviceRuleSet`, `EditDeviceRuleSet`, `EditDeviceRules` | Processes › Find, ProcessDetail with Tasks |

Every column and find of the Java lists is kept (the device list's, the parameters', the members', the configurations'
and the processes'), shown with names instead of ids and chosen with Columns; the Java FindDevice's `configId` column
named no field of `Device` and is left out. Deliberate differences: the Groovy JSON transitions are the one
`choices` transition; the gateway services are `moqui.device.DeviceServices`' (the Java screens named
`DeviceGatewayServices`); the Java `updateParameter` transition the parameter lists posted to did not exist, and is
`update#ParameterValue`.

## 6. Tests

Regression (`test/Devices/`): `DevicesAccess` (each permission's holder and a non-holder on one verb of the rule, with
the same parameters; the root refused to a user without the group), `DevicesRules` (the task apply checks, the group's
controller, the parameter update's limits, the content and request rules, every choice once with a selected value),
`DevicesScreens` (each screen rendered once, with a text it shows). The golden-path client walk
`test/client/Devices/DevicesWalk` (find a device, open it, apply a task). Acceptance (`test/acceptance/Devices/`): the
terminal screen sweep `DevicesTui`. A server-static sweep needs mr-boss's `ServerStaticLib`, which this component does not
depend on; it is left for when that library is the framework's.

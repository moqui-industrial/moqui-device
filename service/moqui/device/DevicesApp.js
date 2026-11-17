/*
 * This software is in the public domain under CC0 1.0 Universal plus a
 * Grant of Patent License.
 *
 * To the extent possible under law, the author(s) have dedicated all
 * copyright and related and neighboring rights to this software to the
 * public domain worldwide. This software is distributed without any
 * warranty.
 *
 * You should have received a copy of the CC0 Public Domain Dedication
 * along with this software (see the LICENSE.md file). If not, see
 * <http://creativecommons.org/publicdomain/zero/1.0/>.
 */

// The Devices app (plan/design-devices.md): its access, lists, records, choices and the requests an operator runs. Every
// operation checks the permission of what it reads or writes first (require), then reads and writes without artifact
// authorization: the app's grant opens navigation only. A refusal names the reason code DEVICE_PERMISSION; a record that
// does not exist, DEVICE_UNAVAILABLE.

const PERMISSIONS = {read: "DEVICE_VIEW", edit: "DEVICE_EDIT", operate: "DEVICE_OPERATE"}
const CHOICE_LIMIT = 50
// member statuses that take a member out of service, and the purposes of a group's controller
const DOWN_MEMBER_STATUSES = ["DgmsDown", "DgmsFault", "DgmsError"]
const CONTROLLER_PURPOSE = "DgmpController"
// the requests the app runs on a device, by the names the Java device screens used: {deviceId}_<suffix>
const REQUEST_SUFFIXES = {exportProcess: "_ExportProcess", syncParameters: "_SyncParameters", transferContent: "_TransferContent"}

function capabilities() {
    const read = ec.user.hasPermission(PERMISSIONS.read)
    return {
        read,
        edit: read && ec.user.hasPermission(PERMISSIONS.edit),
        operate: read && ec.user.hasPermission(PERMISSIONS.operate)
    }
}

function require(kind) {
    const can = capabilities()
    if (!can[kind]) {
        const words = {read: "read devices", edit: "edit the device model", operate: "run requests on devices"}
        throw new Error("DEVICE_PERMISSION: You may not " + words[kind])
    }
    return can
}

function unavailable(what, id) {
    return new Error("DEVICE_UNAVAILABLE: " + what + " " + id + " is not available")
}

// ---- reads

function find(entityName) {
    return ec.entity.find(entityName).disableAuthz()
}

function one(entityName, conditions) {
    return find(entityName).condition(conditions).one()
}

function rows(query) {
    return Array.from(query.list())
}

function blank(value) {
    return value == null || String(value).trim() === ""
}

function text(value) {
    return blank(value) ? null : String(value).trim()
}

// the description of each id, read in one query
function descriptions(entityName, keyField, ids) {
    const wanted = Array.from(new Set(ids.filter(id => !blank(id))))
    const found = {}
    if (!wanted.length) return found
    for (const row of rows(find(entityName).condition(keyField, "in", wanted).selectField(keyField + ",description"))) {
        found[row[keyField]] = row.description || row[keyField]
    }
    return found
}

// the name field of each id, read in one query; the id when the record has no name
function names(entityName, keyField, nameField, ids) {
    const wanted = Array.from(new Set(ids.filter(id => !blank(id))))
    const found = {}
    if (!wanted.length) return found
    for (const row of rows(find(entityName).condition(keyField, "in", wanted).selectField(keyField + "," + nameField))) {
        found[row[keyField]] = row[nameField] || row[keyField]
    }
    return found
}

function enumTexts(ids) {
    return descriptions("moqui.basic.Enumeration", "enumId", ids)
}

function statusTexts(ids) {
    return descriptions("moqui.basic.StatusItem", "statusId", ids)
}

function dateText(value) {
    return value ? ec.l10n.format(value, "yyyy-MM-dd HH:mm") : null
}

function numberText(value) {
    return value == null ? null : ec.l10n.format(value, "#,##0.########")
}

// a chip's color by status: running is positive, an error or emergency negative, a stop or transition a warning
function statusColor(statusId) {
    const id = String(statusId || "")
    if (!id) return "grey-6"
    if (/Error|Fault|Emergency|Down/.test(id)) return "negative"
    if (/Run|Alive/.test(id)) return "positive"
    if (/Stop|Homing|Inhibit|Init/.test(id)) return "warning"
    return "grey-8"
}

// a page of a query: the rows of the page and the paging fields of a form-list, named after the list
function page(query, listName, parameters, defaultSize = 20) {
    const pageSize = Math.max(1, Math.min(100, Number(parameters.pageSize || defaultSize)))
    const count = query.count()
    const maxIndex = Math.max(0, Math.ceil(count / pageSize) - 1)
    const pageIndex = Math.max(0, Math.min(maxIndex, Number(parameters.pageIndex || 0)))
    const list = rows(query.offset(pageIndex * pageSize).limit(pageSize))
    return {
        list,
        paging: {
            [listName + "Count"]: count,
            [listName + "PageIndex"]: pageIndex,
            [listName + "PageSize"]: pageSize,
            [listName + "PageMaxIndex"]: maxIndex,
            [listName + "PageRangeLow"]: count ? pageIndex * pageSize + 1 : 0,
            [listName + "PageRangeHigh"]: Math.min(count, (pageIndex + 1) * pageSize)
        }
    }
}

// a text search over fields, ignoring case, in the query
function textCondition(term, fields) {
    const factory = ec.entity.conditionFactory
    const pattern = "%" + term + "%"
    return factory.makeCondition(
        fields.map(field => factory.makeCondition(field, "like", pattern).ignoreCase()),
        "or"
    )
}

// ---- context

function sharedContext(p) {
    const appRoot = p.appRoot || "Devices"
    const base = "//" + appRoot + "/"
    return {
        capabilities: capabilities(),
        sharedLinks: {
            Home: base + "Home",
            "Devices/Find": base + "Devices/Find",
            "Devices/DeviceDetail": base + "Devices/DeviceDetail",
            "Groups/Find": base + "Groups/Find",
            "Groups/GroupDetail": base + "Groups/GroupDetail",
            "Configs/Find": base + "Configs/Find",
            "Configs/ConfigDetail": base + "Configs/ConfigDetail",
            "Processes/Find": base + "Processes/Find",
            "Processes/ProcessDetail": base + "Processes/ProcessDetail"
        }
    }
}

function home() {
    require("read")
    const counts = {
        devices: find("moqui.device.PhysicalDevice").count(),
        groups: find("moqui.device.DeviceGroup").count(),
        processes: find("moqui.device.DeviceRuleSet").conditionDate("fromDate", "thruDate", null).count(),
        configs: find("moqui.device.DeviceConfig").conditionDate("fromDate", "thruDate", null).count()
    }
    const downQuery = find("moqui.device.DeviceGroupMember").condition("statusId", "in", DOWN_MEMBER_STATUSES)
    counts.membersDown = downQuery.count()
    const down = rows(downQuery.orderBy("deviceId,sequenceNum,memberDeviceId").limit(10))
    return {counts, membersDown: memberRows(down)}
}

// ---- devices and groups

// the fields of a device row (the Java FindDevice list's columns), with names and texts for its ids
function deviceRows(list) {
    const enums = enumTexts(
        list.flatMap(row => [row.deviceTypeEnumId, row.purposeEnumId, row.controlMethodEnumId, row.operatingModeEnumId])
    )
    const statuses = statusTexts(list.map(row => row.statusId))
    const statusTypes = descriptions("moqui.basic.StatusType", "statusTypeId", list.map(row => row.statusTypeId))
    const statusFlows = descriptions("moqui.basic.StatusFlow", "statusFlowId", list.map(row => row.statusFlowId))
    const ruleSetNames = names("moqui.device.DeviceRuleSet", "deviceRuleSetId", "ruleSetName", list.map(row => row.deviceRuleSetId))
    const ruleNames = names("moqui.device.DeviceRule", "deviceRuleId", "ruleName", list.map(row => row.deviceRuleId))
    const parentNames = deviceNameMap(list.map(row => row.parentDeviceId))
    return list.map(row => ({
        deviceId: row.deviceId,
        name: row.deviceName || row.groupName || row.deviceId,
        parentDeviceId: row.parentDeviceId || null,
        parentText: row.parentDeviceId ? parentNames[row.parentDeviceId] || row.parentDeviceId : null,
        typeText: enums[row.deviceTypeEnumId] || null,
        purposeText: enums[row.purposeEnumId] || null,
        controlMethodText: enums[row.controlMethodEnumId] || null,
        operatingModeText: enums[row.operatingModeEnumId] || null,
        statusTypeText: statusTypes[row.statusTypeId] || null,
        statusFlowText: statusFlows[row.statusFlowId] || null,
        statusId: row.statusId || null,
        statusText: statuses[row.statusId] || null,
        statusColor: statusColor(row.statusId),
        deviceRuleSetId: row.deviceRuleSetId || null,
        processText: row.deviceRuleSetId ? ruleSetNames[row.deviceRuleSetId] || row.deviceRuleSetId : null,
        deviceRuleId: row.deviceRuleId || null,
        taskText: row.deviceRuleId ? ruleNames[row.deviceRuleId] || row.deviceRuleId : null,
        coordinateSystemId: row.coordinateSystemId || null,
        transformationId: row.transformationId || null,
        approximatedFunctionId: row.approximatedFunctionId || null,
        vendorName: row.vendorName || null,
        modelName: row.modelName || null,
        vendorModel: [row.vendorName, row.modelName].filter(Boolean).join(" ") || null,
        version: row.version || null,
        hardwareVersion: row.hardwareVersion || null,
        firmwareVersion: row.firmwareVersion || null,
        operatingSystem: row.operatingSystem || null,
        softwareApplication: row.softwareApplication || null,
        serialNumber: row.serialNumber || null,
        uuid: row.uuid || null,
        hash: row.hash || null,
        geoPointId: row.geoPointId || null,
        location: row.location || null,
        cycleTimeText: numberText(row.cycleTime),
        isMulticore: row.isMulticore === "Y" ? "Yes" : row.isMulticore === "N" ? "No" : null,
        fromDateText: dateText(row.fromDate),
        thruDateText: dateText(row.thruDate),
        description: row.description || null
    }))
}

// the list's filters: ids compared equal, texts found ignoring case anywhere in the field
const DEVICE_EQUAL_FILTERS = ["parentDeviceId", "deviceTypeEnumId", "purposeEnumId", "controlMethodEnumId", "operatingModeEnumId",
    "statusTypeId", "statusFlowId", "statusId", "deviceRuleSetId", "deviceRuleId", "approximatedFunctionId", "coordinateSystemId",
    "transformationId", "geoPointId", "isMulticore"]
const DEVICE_TEXT_FILTERS = ["vendorName", "modelName", "version", "hardwareVersion", "firmwareVersion", "operatingSystem",
    "softwareApplication", "serialNumber", "uuid", "hash", "location", "description"]
// the list's columns it may be sorted by (orderByField, with "-" for descending and "^" ignoring case), and their fields
const DEVICE_ORDER_FIELDS = {
    deviceId: "deviceId",
    parentText: "parentDeviceId",
    typeText: "deviceTypeEnumId",
    purposeText: "purposeEnumId",
    statusText: "statusId",
    processText: "deviceRuleSetId",
    vendorText: "vendorName",
    modelText: "modelName",
    serialText: "serialNumber",
    locationText: "location",
    cycleTimeText: "cycleTime",
    fromDateText: "fromDate",
    thruDateText: "thruDate"
}

function findDevices(p) {
    require("read")
    const groups = p.kind === "group"
    const query = find("moqui.device.DeviceDetail").condition(groups ? "groupName" : "deviceName", "is-not-null", null)
    const term = text(p.text)
    if (term) {
        query.condition(
            textCondition(term, groups ? ["deviceId", "groupName", "description"]
                : ["deviceId", "deviceName", "serialNumber", "vendorName", "modelName", "location", "description"])
        )
    }
    for (const field of DEVICE_EQUAL_FILTERS) if (text(p[field])) query.condition(field, text(p[field]))
    for (const field of DEVICE_TEXT_FILTERS) {
        if (text(p[field])) query.condition(ec.entity.conditionFactory.makeCondition(field, "like", "%" + text(p[field]) + "%").ignoreCase())
    }
    // ranges: the cycle time and the dates, each bound when given
    if (!blank(p.cycleTimeFrom)) query.condition("cycleTime", "greater-equals", toDecimal(String(p.cycleTimeFrom)))
    if (!blank(p.cycleTimeThru)) query.condition("cycleTime", "less-equals", toDecimal(String(p.cycleTimeThru)))
    if (!blank(p.fromDateFrom)) query.condition("fromDate", "greater-equals", p.fromDateFrom)
    if (!blank(p.fromDateThru)) query.condition("fromDate", "less-equals", p.fromDateThru)
    if (!blank(p.thruDateFrom)) query.condition("thruDate", "greater-equals", p.thruDateFrom)
    if (!blank(p.thruDateThru)) query.condition("thruDate", "less-equals", p.thruDateThru)
    const order = text(p.orderByField) || ""
    const prefix = (order.match(/^[-+^]+/) || [""])[0]
    const column = order.substring(prefix.length)
    const field = column === "name" ? (groups ? "groupName" : "deviceName") : DEVICE_ORDER_FIELDS[column]
    query.orderBy(field ? [prefix.replace("+", "") + field, "deviceId"] : groups ? "^groupName,deviceId" : "^deviceName,deviceId")
    const {list, paging} = page(query, "deviceList", p)
    const result = deviceRows(list)
    if (groups && result.length) {
        const counts = {}
        for (const member of rows(find("moqui.device.DeviceGroupMember").condition("deviceId", "in", result.map(row => row.deviceId))
                .selectField("deviceId,memberDeviceId"))) {
            counts[member.deviceId] = (counts[member.deviceId] || 0) + 1
        }
        for (const row of result) row.memberCount = counts[row.deviceId] || 0
    }
    return Object.assign({deviceList: result}, paging)
}

// a device's or group's name by id, read in one query
function deviceNameMap(ids) {
    const wanted = Array.from(new Set(ids.filter(id => !blank(id))))
    const found = {}
    if (!wanted.length) return found
    for (const row of rows(find("moqui.device.DeviceDetail").condition("deviceId", "in", wanted))) {
        found[row.deviceId] = row.deviceName || row.groupName || row.deviceId
    }
    return found
}

function memberRows(members) {
    const deviceNames = deviceNameMap(members.flatMap(row => [row.deviceId, row.memberDeviceId]))
    const groupIds = new Set(
        members.length
            ? rows(find("moqui.device.DeviceGroup").condition("deviceId", "in", members.map(row => row.memberDeviceId)).selectField("deviceId"))
                  .map(row => row.deviceId)
            : []
    )
    const purposes = enumTexts(members.map(row => row.purposeEnumId))
    const statuses = statusTexts(members.map(row => row.statusId))
    const flows = descriptions("moqui.basic.StatusFlow", "statusFlowId", members.map(row => row.statusFlowId))
    return members.map(row => ({
        groupId: row.deviceId,
        groupName: deviceNames[row.deviceId] || row.deviceId,
        memberDeviceId: row.memberDeviceId,
        memberName: deviceNames[row.memberDeviceId] || row.memberDeviceId,
        memberIsGroup: groupIds.has(row.memberDeviceId),
        purposeText: purposes[row.purposeEnumId] || null,
        sequenceNum: row.sequenceNum,
        statusId: row.statusId || null,
        statusText: statuses[row.statusId] || row.statusId || null,
        statusFlowText: flows[row.statusFlowId] || row.statusFlowId || null,
        purposeEnumId: row.purposeEnumId || null,
        statusColor: statusColor(row.statusId),
        description: row.description || null
    }))
}

// the purposes under DgmpController, itself included
function controllerPurposes() {
    const found = [CONTROLLER_PURPOSE]
    for (let index = 0; index < found.length; index++) {
        for (const row of rows(find("moqui.basic.Enumeration").condition("parentEnumId", found[index]).selectField("enumId"))) {
            if (!found.includes(row.enumId)) found.push(row.enumId)
        }
    }
    return found
}

// a group's controller: the first member, by sequence, with a controller purpose that is a physical device and not out of service
function groupController(groupId) {
    const candidates = rows(
        find("moqui.device.DeviceGroupMember")
            .condition("deviceId", groupId)
            .condition("purposeEnumId", "in", controllerPurposes())
            .orderBy("sequenceNum,memberDeviceId")
    )
    for (const candidate of candidates) {
        if (candidate.statusId && DOWN_MEMBER_STATUSES.includes(candidate.statusId)) continue
        if (one("moqui.device.PhysicalDevice", {deviceId: candidate.memberDeviceId})) return candidate.memberDeviceId
    }
    return null
}

function deviceRecord(deviceId) {
    const device = one("moqui.device.DeviceDetail", {deviceId})
    if (!device) throw unavailable("Device", deviceId)
    return device
}

// a device or group with its header, identity, process and task, members or groups, and the requests the app may run on it
function getDevice(p) {
    const can = require("read")
    const device = deviceRecord(p.deviceId)
    const isGroup = !!one("moqui.device.DeviceGroup", {deviceId: p.deviceId})
    const [row] = deviceRows([device])
    const enums = enumTexts([device.controlMethodEnumId, device.operatingModeEnumId])
    const parent = device.parentDeviceId ? one("moqui.device.DeviceDetail", {deviceId: device.parentDeviceId}) : null
    const controllerId = isGroup ? groupController(p.deviceId) : null
    const controller = controllerId ? one("moqui.device.DeviceDetail", {deviceId: controllerId}) : null
    // the export and synchronization run on the device, or on a group's controller; the transfer on the record itself
    const target = isGroup ? controllerId : p.deviceId
    const requestExists = name => !!(name && one("moqui.device.DeviceRequest", {requestName: name}))
    const requests = {
        exportProcess: target && device.deviceRuleSetId ? requestExists(target + REQUEST_SUFFIXES.exportProcess) : false,
        syncParameters: target ? requestExists(target + REQUEST_SUFFIXES.syncParameters) : false,
        transferContent: requestExists(p.deviceId + REQUEST_SUFFIXES.transferContent)
    }
    const groupsOf = isGroup
        ? []
        : memberRows(rows(find("moqui.device.DeviceGroupMember").condition("memberDeviceId", p.deviceId).orderBy("deviceId")))
    const record = Object.assign({}, row, {
        isGroup,
        description: device.description || null,
        caption: [row.typeText, row.vendorModel, row.location].filter(Boolean).join(" · "),
        controlMethodText: enums[device.controlMethodEnumId] || null,
        operatingModeText: enums[device.operatingModeEnumId] || null,
        deviceRuleSetId: device.deviceRuleSetId || null,
        deviceRuleId: device.deviceRuleId || null,
        parentDeviceId: device.parentDeviceId || null,
        parentName: parent ? parent.deviceName || parent.groupName || parent.deviceId : null,
        controllerDeviceId: controllerId,
        controllerName: controller ? controller.deviceName || controllerId : null,
        version: device.version || null,
        hardwareVersion: device.hardwareVersion || null,
        firmwareVersion: device.firmwareVersion || null,
        operatingSystem: device.operatingSystem || null,
        softwareApplication: device.softwareApplication || null,
        uuid: device.uuid || null,
        cycleTime: numberText(device.cycleTime),
        isMulticore: device.isMulticore === "Y" ? "Yes" : device.isMulticore === "N" ? "No" : null,
        fromDateText: dateText(device.fromDate),
        thruDateText: dateText(device.thruDate)
    })
    return {
        device: record,
        groups: groupsOf,
        requests,
        actions: {
            applyTask: can.operate,
            exportProcess: can.operate && requests.exportProcess,
            syncParameters: can.operate && requests.syncParameters,
            transferContent: can.operate && requests.transferContent
        }
    }
}

function findMembers(p) {
    require("read")
    if (!one("moqui.device.DeviceGroup", {deviceId: p.deviceId})) throw unavailable("Device group", p.deviceId)
    const query = find("moqui.device.DeviceGroupMember").condition("deviceId", p.deviceId).orderBy("sequenceNum,memberDeviceId")
    if (text(p.purposeEnumId)) query.condition("purposeEnumId", text(p.purposeEnumId))
    if (text(p.statusId)) query.condition("statusId", text(p.statusId))
    const {list, paging} = page(query, "memberList", p, 50)
    return Object.assign({memberList: memberRows(list)}, paging)
}

// ---- parameters

function findParameters(p) {
    const can = require("read")
    const query = find("moqui.math.ParameterDetail")
    let withDevice = false
    if (text(p.deviceId)) {
        deviceRecord(p.deviceId)
        // a group's parameters are its own and those of its members
        const memberIds = rows(find("moqui.device.DeviceGroupMember").condition("deviceId", p.deviceId).selectField("memberDeviceId"))
            .map(row => row.memberDeviceId)
        withDevice = memberIds.length > 0
        query.condition("deviceId", "in", [p.deviceId].concat(memberIds))
    } else if (text(p.deviceConfigId)) {
        if (!one("moqui.device.DeviceConfig", {deviceConfigId: p.deviceConfigId})) throw unavailable("Configuration", p.deviceConfigId)
        query.condition("deviceConfigId", p.deviceConfigId).condition("deviceId", null)
    } else {
        throw new Error("A device or a configuration is required")
    }
    const term = text(p.text)
    if (term) query.condition(textCondition(term, ["parameterCode", "parameterName", "parameterAlias", "parameterId", "description"]))
    for (const field of PARAMETER_EQUAL_FILTERS) if (text(p[field])) query.condition(field, text(p[field]))
    query.orderBy(withDevice ? "deviceId,sequenceNum,parameterCode,parameterId" : "sequenceNum,parameterCode,parameterId")
    const {list, paging} = page(query, "parameterList", p, 25)
    const enums = enumTexts(
        list.flatMap(row => [row.parameterTypeEnumId, row.parameterEnumId, row.purposeEnumId, row.groupEnumId, row.classEnumId,
            row.permissionEnumId, row.uomTypeEnumId])
    )
    const uoms = descriptions("moqui.basic.Uom", "uomId", list.map(row => row.parameterUomId))
    const numericTypes = numericParameterTypes(list.map(row => row.parameterTypeEnumId))
    const deviceNames = withDevice ? deviceNameMap(list.map(row => row.deviceId)) : {}
    const parameterList = list.map(row => ({
        parameterId: row.parameterId,
        deviceId: row.deviceId || null,
        deviceName: withDevice ? deviceNames[row.deviceId] || row.deviceId : null,
        isNumeric: numericTypes.has(row.parameterTypeEnumId),
        parameterCode: row.parameterCode,
        parameterName: row.parameterName,
        parameterAlias: row.parameterAlias || null,
        description: row.description || null,
        parameterDefId: row.parameterDefId,
        parentParameterDefId: row.parentParameterDefId || null,
        externalId: row.externalId || null,
        userId: row.userId || null,
        purposeText: enums[row.purposeEnumId] || null,
        groupText: enums[row.groupEnumId] || null,
        classText: enums[row.classEnumId] || null,
        permissionText: enums[row.permissionEnumId] || null,
        uomTypeText: enums[row.uomTypeEnumId] || null,
        isRequired: row.isRequired === "Y" ? "Yes" : row.isRequired === "N" ? "No" : null,
        hasValue: row.hasValue === "Y" ? "Yes" : row.hasValue === "N" ? "No" : null,
        priority: row.priority,
        sequenceNum: row.sequenceNum,
        minText: numberText(row.minValue),
        maxText: numberText(row.maxValue),
        defaultText: row.defaultValue != null ? numberText(row.defaultValue) : row.defaultTextValue || row.defaultEnumId || null,
        enumText: row.parameterEnumId ? enums[row.parameterEnumId] || row.parameterEnumId : null,
        typeText: enums[row.parameterTypeEnumId] || row.parameterTypeEnumId,
        numericValue: row.numericValue,
        symbolicValue: row.symbolicValue || null,
        parameterEnumId: row.parameterEnumId || null,
        valueText:
            row.numericValue != null ? numberText(row.numericValue)
            : row.symbolicValue || (row.parameterEnumId ? enums[row.parameterEnumId] || row.parameterEnumId : null),
        uomText: uoms[row.parameterUomId] || null,
        rangeText: row.minValue != null || row.maxValue != null
            ? (numberText(row.minValue) || "…") + " – " + (numberText(row.maxValue) || "…") : null,
        editable: can.edit
    }))
    return Object.assign({parameterList, withDevice}, paging)
}

// a parameter list's filters, compared equal (the Java FindParameter's enumerations)
const PARAMETER_EQUAL_FILTERS = ["parameterTypeEnumId", "purposeEnumId", "groupEnumId", "classEnumId", "permissionEnumId", "parameterDefId"]

// the parameter types that hold a number: PtNumber and the types under it (moqui-math's ParameterType)
function numericParameterTypes(ids) {
    const numeric = new Set()
    const wanted = Array.from(new Set(ids.filter(id => !blank(id))))
    if (!wanted.length) return numeric
    for (const row of rows(find("moqui.basic.Enumeration").condition("enumId", "in", wanted).selectField("enumId,parentEnumId"))) {
        if (row.enumId === "PtNumber" || row.parentEnumId === "PtNumber" || String(row.enumId).startsWith("PtNumber")) numeric.add(row.enumId)
    }
    return numeric
}

// a parameter's value: only a parameter of a device or a configuration, and within the range of its definition
function updateParameterValue(p) {
    require("edit")
    const parameter = one("moqui.math.Parameter", {parameterId: p.parameterId})
    if (!parameter || (!parameter.deviceId && !parameter.deviceConfigId)) throw unavailable("Parameter", p.parameterId)
    const fields = {parameterId: p.parameterId}
    if (!blank(p.numericValue)) {
        const value = toDecimal(String(p.numericValue).trim())
        const definition = one("moqui.math.ParameterDef", {parameterDefId: parameter.parameterDefId})
        if (definition && definition.minValue != null && value.compare(definition.minValue) < 0)
            throw new Error("DEVICE_VALUE_RANGE: The value is below the minimum " + numberText(definition.minValue))
        if (definition && definition.maxValue != null && value.compare(definition.maxValue) > 0)
            throw new Error("DEVICE_VALUE_RANGE: The value is above the maximum " + numberText(definition.maxValue))
        fields.numericValue = value
    }
    if (p.symbolicValue !== undefined) fields.symbolicValue = text(p.symbolicValue)
    if (p.parameterEnumId !== undefined) fields.parameterEnumId = text(p.parameterEnumId)
    if (!blank(p.sequenceNum)) fields.sequenceNum = Number(p.sequenceNum)
    ec.service.sync().name("update#moqui.math.Parameter").parameters(fields).disableAuthz().call()
    return {}
}

// ---- configurations and processes

function configRows(list) {
    const enums = enumTexts(list.flatMap(row => [row.configTypeEnumId, row.purposeEnumId, row.deviceTypeEnumId, row.controlMethodEnumId]))
    const parents = names("moqui.device.DeviceConfig", "deviceConfigId", "configName", list.map(row => row.parentConfigId))
    return list.map(row => ({
        deviceConfigId: row.deviceConfigId,
        name: row.configName || row.deviceConfigId,
        parentConfigId: row.parentConfigId || null,
        parentText: row.parentConfigId ? parents[row.parentConfigId] || row.parentConfigId : null,
        description: row.description || null,
        typeText: enums[row.configTypeEnumId] || null,
        purposeText: enums[row.purposeEnumId] || null,
        deviceTypeText: enums[row.deviceTypeEnumId] || null,
        controlMethodText: enums[row.controlMethodEnumId] || null,
        approximatedFunctionId: row.approximatedFunctionId || null,
        fromDateText: dateText(row.fromDate),
        thruDateText: dateText(row.thruDate)
    }))
}

function findConfigs(p) {
    require("read")
    const query = find("moqui.device.DeviceConfig")
    const term = text(p.text)
    if (term) query.condition(textCondition(term, ["deviceConfigId", "configName", "description"]))
    if (text(p.configTypeEnumId)) query.condition("configTypeEnumId", p.configTypeEnumId)
    if (text(p.deviceTypeEnumId)) query.condition("deviceTypeEnumId", p.deviceTypeEnumId)
    for (const field of ["purposeEnumId", "controlMethodEnumId", "approximatedFunctionId", "parentConfigId"]) {
        if (text(p[field])) query.condition(field, text(p[field]))
    }
    query.orderBy("^configName,deviceConfigId")
    const {list, paging} = page(query, "configList", p)
    return Object.assign({configList: configRows(list)}, paging)
}

function getConfig(p) {
    const can = require("read")
    const config = one("moqui.device.DeviceConfig", {deviceConfigId: p.deviceConfigId})
    if (!config) throw unavailable("Configuration", p.deviceConfigId)
    const [row] = configRows([config])
    const parent = config.parentConfigId ? one("moqui.device.DeviceConfig", {deviceConfigId: config.parentConfigId}) : null
    return {
        config: Object.assign(row, {
            parentConfigId: config.parentConfigId || null,
            parentName: parent ? parent.configName || parent.deviceConfigId : null,
            configName: config.configName || null,
            description: config.description || null,
            controlMethodEnumId: config.controlMethodEnumId || null,
            fromDate: config.fromDate,
            thruDate: config.thruDate,
            caption: [row.typeText, row.purposeText, row.deviceTypeText].filter(Boolean).join(" · ")
        }),
        canEdit: can.edit
    }
}

function updateConfig(p) {
    require("edit")
    if (!one("moqui.device.DeviceConfig", {deviceConfigId: p.deviceConfigId})) throw unavailable("Configuration", p.deviceConfigId)
    const fields = {deviceConfigId: p.deviceConfigId}
    for (const name of ["configName", "description", "controlMethodEnumId", "approximatedFunctionId", "fromDate", "thruDate"]) {
        if (p[name] !== undefined) fields[name] = blank(p[name]) ? null : p[name]
    }
    ec.service.sync().name("update#moqui.device.DeviceConfig").parameters(fields).disableAuthz().call()
    return {}
}

function processRows(list) {
    const purposes = enumTexts(list.map(row => row.purposeEnumId))
    const parents = names("moqui.device.DeviceRuleSet", "deviceRuleSetId", "ruleSetName", list.map(row => row.parentRuleSetId))
    return list.map(row => ({
        deviceRuleSetId: row.deviceRuleSetId,
        name: row.ruleSetName || row.deviceRuleSetId,
        purposeText: purposes[row.purposeEnumId] || null,
        parentText: row.parentRuleSetId ? parents[row.parentRuleSetId] || row.parentRuleSetId : null,
        sequenceNum: row.sequenceNum,
        parentRuleSetId: row.parentRuleSetId || null,
        description: row.description || null,
        fromDateText: dateText(row.fromDate),
        thruDateText: dateText(row.thruDate)
    }))
}

function findProcesses(p) {
    require("read")
    const query = find("moqui.device.DeviceRuleSet")
    const term = text(p.text)
    if (term) query.condition(textCondition(term, ["deviceRuleSetId", "ruleSetName", "description"]))
    if (text(p.purposeEnumId)) query.condition("purposeEnumId", p.purposeEnumId)
    if (text(p.parentRuleSetId)) query.condition("parentRuleSetId", text(p.parentRuleSetId))
    query.orderBy("sequenceNum,^ruleSetName,deviceRuleSetId")
    const {list, paging} = page(query, "processList", p)
    return Object.assign({processList: processRows(list)}, paging)
}

function getProcess(p) {
    const can = require("read")
    const process = one("moqui.device.DeviceRuleSet", {deviceRuleSetId: p.deviceRuleSetId})
    if (!process) throw unavailable("Process", p.deviceRuleSetId)
    const [row] = processRows([process])
    const tasks = rows(find("moqui.device.DeviceRule").condition("deviceRuleSetId", p.deviceRuleSetId).orderBy("priority,fromDate,deviceRuleId"))
    const types = enumTexts(tasks.map(task => task.ruleTypeEnumId))
    const configNames = names("moqui.device.DeviceConfig", "deviceConfigId", "configName", tasks.map(task => task.deviceConfigId))
    const deviceNames = deviceNameMap(tasks.map(task => task.deviceId))
    const running = rows(find("moqui.device.DeviceDetail").condition("deviceRuleSetId", p.deviceRuleSetId).orderBy("deviceId").limit(50))
    return {
        process: Object.assign(row, {
            ruleSetName: process.ruleSetName || null,
            description: process.description || null,
            parentRuleSetId: process.parentRuleSetId || null,
            purposeEnumId: process.purposeEnumId || null,
            fromDate: process.fromDate,
            thruDate: process.thruDate,
            caption: [row.purposeText, row.parentText ? "part of " + row.parentText : null].filter(Boolean).join(" · ")
        }),
        taskList: tasks.map(task => ({
            deviceRuleId: task.deviceRuleId,
            deviceRuleSetId: task.deviceRuleSetId,
            ruleName: task.ruleName || task.deviceRuleId,
            ruleTypeEnumId: task.ruleTypeEnumId || null,
            typeText: types[task.ruleTypeEnumId] || null,
            deviceId: task.deviceId || null,
            deviceName: task.deviceId ? deviceNames[task.deviceId] || task.deviceId : null,
            deviceConfigId: task.deviceConfigId || null,
            configName: task.deviceConfigId ? configNames[task.deviceConfigId] || task.deviceConfigId : null,
            priority: task.priority,
            description: task.description || null,
            fromDate: task.fromDate,
            thruDate: task.thruDate,
            fromDateText: dateText(task.fromDate),
            thruDateText: dateText(task.thruDate)
        })),
        runningList: deviceRows(running),
        canEdit: can.edit
    }
}

function storeProcess(p) {
    require("edit")
    const fields = {}
    for (const name of ["parentRuleSetId", "purposeEnumId", "sequenceNum", "ruleSetName", "description", "fromDate", "thruDate"]) {
        if (p[name] !== undefined) fields[name] = blank(p[name]) ? null : p[name]
    }
    if (!blank(p.deviceRuleSetId)) {
        if (!one("moqui.device.DeviceRuleSet", {deviceRuleSetId: p.deviceRuleSetId})) throw unavailable("Process", p.deviceRuleSetId)
        if (fields.parentRuleSetId === p.deviceRuleSetId) throw new Error("DEVICE_PROCESS_PARENT: A process cannot be its own parent")
        fields.deviceRuleSetId = p.deviceRuleSetId
        ec.service.sync().name("update#moqui.device.DeviceRuleSet").parameters(fields).disableAuthz().call()
        return {deviceRuleSetId: p.deviceRuleSetId}
    }
    if (blank(fields.ruleSetName)) throw new Error("DEVICE_PROCESS_NAME: A process needs a name")
    const created = ec.service.sync().name("create#moqui.device.DeviceRuleSet").parameters(fields).disableAuthz().call()
    return {deviceRuleSetId: created.deviceRuleSetId}
}

function storeTask(p) {
    require("edit")
    if (!one("moqui.device.DeviceRuleSet", {deviceRuleSetId: p.deviceRuleSetId})) throw unavailable("Process", p.deviceRuleSetId)
    const fields = {deviceRuleSetId: p.deviceRuleSetId}
    for (const name of ["deviceId", "ruleTypeEnumId", "deviceConfigId", "ruleName", "description", "priority", "fromDate", "thruDate"]) {
        if (p[name] !== undefined) fields[name] = blank(p[name]) ? null : p[name]
    }
    if (fields.deviceId && !one("moqui.device.Device", {deviceId: fields.deviceId})) throw unavailable("Device", fields.deviceId)
    if (fields.deviceConfigId && !one("moqui.device.DeviceConfig", {deviceConfigId: fields.deviceConfigId}))
        throw unavailable("Configuration", fields.deviceConfigId)
    if (!blank(p.deviceRuleId)) {
        const task = one("moqui.device.DeviceRule", {deviceRuleId: p.deviceRuleId})
        if (!task || task.deviceRuleSetId !== p.deviceRuleSetId) throw unavailable("Task", p.deviceRuleId)
        fields.deviceRuleId = p.deviceRuleId
        ec.service.sync().name("update#moqui.device.DeviceRule").parameters(fields).disableAuthz().call()
        return {deviceRuleId: p.deviceRuleId}
    }
    if (blank(fields.ruleName)) throw new Error("DEVICE_TASK_NAME: A task needs a name")
    const created = ec.service.sync().name("create#moqui.device.DeviceRule").parameters(fields).disableAuthz().call()
    return {deviceRuleId: created.deviceRuleId}
}

function deleteTask(p) {
    require("edit")
    const task = one("moqui.device.DeviceRule", {deviceRuleId: p.deviceRuleId})
    if (!task || (p.deviceRuleSetId && task.deviceRuleSetId !== p.deviceRuleSetId)) throw unavailable("Task", p.deviceRuleId)
    if (find("moqui.device.Device").condition("deviceRuleId", p.deviceRuleId).count())
        throw new Error("DEVICE_TASK_IN_USE: A device runs this task; apply another task to it first")
    ec.service.sync().name("delete#moqui.device.DeviceRule").parameters({deviceRuleId: p.deviceRuleId}).disableAuthz().call()
    return {}
}

// ---- observability

// the time ranges an observability view offers, in hours back from now (all: no lower bound)
const OBSERVABILITY_RANGES = {"1h": 1, "24h": 24, "7d": 168, "30d": 720, "365d": 8760, all: null}
const MAX_POINTS = 5000

// the devices whose logs a record shows: a device's own, or a group's and its members', through nested groups
function loggedDevices(deviceId) {
    const ids = [deviceId]
    for (let index = 0; index < ids.length; index++) {
        for (const row of rows(find("moqui.device.DeviceGroupMember").condition("deviceId", ids[index]).selectField("memberDeviceId"))) {
            if (!ids.includes(row.memberDeviceId)) ids.push(row.memberDeviceId)
        }
    }
    return ids
}

// a device's observability (the Java DeviceObservability without Grafana): the time series of one logged parameter as a
// report frame, and its DeviceLog rows, newest first and paged, both within the range
function observability(p) {
    require("read")
    deviceRecord(p.deviceId)
    const deviceIds = loggedDevices(p.deviceId)
    const range = Object.hasOwn(OBSERVABILITY_RANGES, p.range) ? p.range : "7d"
    const hours = OBSERVABILITY_RANGES[range]
    const since = hours == null ? null : new Date(ec.user.timestampMillis(ec.user.nowTimestamp) - hours * 3600000)
    // the parameters of these devices that have a log, the selected one first in the choice
    const parameters = rows(find("moqui.math.ParameterDetail").condition("deviceId", "in", deviceIds).orderBy("deviceId,sequenceNum,parameterCode"))
    const logged = []
    for (const parameter of parameters) {
        if (find("moqui.math.ParameterLog").condition("parameterId", parameter.parameterId).limit(1).count()) logged.push(parameter)
    }
    const names = deviceIds.length > 1 ? deviceNameMap(deviceIds) : {}
    const parameterOptions = logged.map(parameter => ({
        value: parameter.parameterId,
        text: (deviceIds.length > 1 ? (names[parameter.deviceId] || parameter.deviceId) + " · " : "") + (parameter.parameterName || parameter.parameterCode)
    }))
    // the chosen parameter, else the first that holds a number (a chart), else the first logged
    const numeric = numericParameterTypes(logged.map(parameter => parameter.parameterTypeEnumId))
    const firstNumeric = logged.find(parameter => numeric.has(parameter.parameterTypeEnumId))
    const parameterId = logged.some(parameter => parameter.parameterId === p.parameterId) ? p.parameterId
        : firstNumeric ? firstNumeric.parameterId : logged.length ? logged[0].parameterId : null
    let frame = {fields: []}
    let panel = null
    let pointCount = 0
    if (parameterId) {
        const parameter = logged.find(row => row.parameterId === parameterId)
        const query = find("moqui.math.ParameterLog").condition("parameterId", parameterId)
        if (since) query.condition("observedDate", "greater-equals", since)
        const points = rows(query.orderBy("-observedDate").limit(MAX_POINTS)).reverse()
        pointCount = points.length
        const values = points.map(point => (point.numericValue != null ? point.numericValue.toNumber() : null))
        const label = parameter.parameterName || parameter.parameterCode
        frame = {
            fields: [
                {name: "time", type: "time", values: points.map(point => ec.user.timestampMillis(point.observedDate))},
                {name: label, type: "number", values}
            ]
        }
        const uom = parameter.parameterUomId ? one("moqui.basic.Uom", {uomId: parameter.parameterUomId}) : null
        panel = {
            title: label + (uom ? " (" + (uom.abbreviation || uom.description) + ")" : ""),
            visualization: "timeSeries",
            fieldConfig: {defaults: uom && uom.abbreviation ? {unit: uom.abbreviation} : {}}
        }
        // a log of texts (states, messages) has no number to draw: its values are listed instead
        if (values.every(value => value == null)) {
            panel = null
            frame = {
                fields: [
                    {name: "time", type: "time", values: points.map(point => ec.user.timestampMillis(point.observedDate))},
                    {name: label, type: "string", values: points.map(point => point.symbolicValue || point.parameterEnumId || null)}
                ]
            }
        }
    }
    const logQuery = find("moqui.device.DeviceLog").condition("deviceId", "in", deviceIds)
    if (since) logQuery.condition("observedDate", "greater-equals", since)
    logQuery.orderBy("-observedDate,-sequenceNum")
    const {list, paging} = page(logQuery, "deviceLogList", p, 20)
    const logNames = deviceNameMap(list.map(row => row.deviceId))
    const deviceLogList = list.map(row => ({
        deviceLogId: row.deviceLogId,
        deviceName: logNames[row.deviceId] || row.deviceId,
        observedText: dateText(row.observedDate),
        sequenceNum: row.sequenceNum,
        payload: String(row.payload || "")
    }))
    return Object.assign({range, parameterId, parameterOptions, frame, panel, pointCount, deviceLogList}, paging)
}

// ---- content

function contentList(p) {
    const can = require("read")
    deviceRecord(p.deviceId)
    const list = rows(find("moqui.device.DeviceContent").condition("deviceId", p.deviceId).orderBy("-contentDate,deviceContentId").limit(100))
    const types = enumTexts(list.map(row => row.contentTypeEnumId))
    const users = {}
    const userIds = list.map(row => row.userId).filter(Boolean)
    if (userIds.length) {
        for (const user of rows(find("moqui.security.UserAccount").condition("userId", "in", userIds).selectField("userId,username,userFullName"))) {
            users[user.userId] = user.userFullName || user.username
        }
    }
    const transfer = can.operate && !!one("moqui.device.DeviceRequest", {requestName: p.deviceId + REQUEST_SUFFIXES.transferContent})
    return {
        contentList: list.map(row => ({
            deviceContentId: row.deviceContentId,
            deviceId: row.deviceId,
            contentTypeEnumId: row.contentTypeEnumId || null,
            typeText: types[row.contentTypeEnumId] || "No type",
            fileName: row.contentLocation ? String(row.contentLocation).split("/").pop() : null,
            description: row.description || null,
            byText: [users[row.userId], dateText(row.contentDate)].filter(Boolean).join(" · ") || null,
            canTransfer: transfer && !!row.contentLocation
        })),
        canEdit: can.edit
    }
}

function contentOf(p) {
    const content = one("moqui.device.DeviceContent", {deviceContentId: p.deviceContentId})
    if (!content || (p.deviceId && content.deviceId !== p.deviceId)) throw unavailable("Content", p.deviceContentId)
    return content
}

function contentFile(p) {
    require("read")
    const content = contentOf(p)
    if (!content.contentLocation) throw new Error("DEVICE_CONTENT_EMPTY: This content has no file")
    return {contentLocation: content.contentLocation}
}

// a content write: the device exists, and an existing content is the device's
function checkContent(p) {
    require("edit")
    deviceRecord(p.deviceId)
    if (!blank(p.deviceContentId)) contentOf(p)
    return {}
}

function deleteContent(p) {
    require("edit")
    contentOf(p)
    ec.service.sync().name("delete#moqui.device.DeviceContent").parameters({deviceContentId: p.deviceContentId}).disableAuthz().call()
    return {}
}

// ---- requests on the plant

function requestOf(deviceId, suffix, words) {
    const requestName = deviceId + suffix
    if (!one("moqui.device.DeviceRequest", {requestName})) {
        throw new Error("DEVICE_NO_REQUEST: " + deviceId + " has no request to " + words + " (" + requestName + ")")
    }
    return requestName
}

// the device a request of the record runs on: the device itself, or a group's controller
function operatedDevice(deviceId) {
    deviceRecord(deviceId)
    if (!one("moqui.device.DeviceGroup", {deviceId})) return deviceId
    const controller = groupController(deviceId)
    if (!controller) throw new Error("DEVICE_NO_CONTROLLER: Group " + deviceId + " has no controller in service")
    return controller
}

function applyTask(p) {
    require("operate")
    const device = deviceRecord(p.deviceId)
    const task = one("moqui.device.DeviceRule", {deviceRuleId: p.deviceRuleId})
    if (!task) throw unavailable("Task", p.deviceRuleId)
    if (task.deviceRuleSetId !== p.deviceRuleSetId)
        throw new Error("DEVICE_TASK_PROCESS: Task " + p.deviceRuleId + " is not a task of process " + p.deviceRuleSetId)
    if (task.deviceId && task.deviceId !== p.deviceId)
        throw new Error("DEVICE_TASK_DEVICE: Task " + p.deviceRuleId + " runs on " + task.deviceId + ", not on " + p.deviceId)
    if (task.deviceConfigId) {
        ec.service.sync().name("moqui.device.DeviceServices.apply#DeviceConfig")
            .parameters({deviceConfigId: task.deviceConfigId, deviceId: p.deviceId}).disableAuthz().call()
        if (ec.message.hasError()) return {}
    }
    ec.service.sync().name("update#moqui.device.Device")
        .parameters({deviceId: device.deviceId, deviceRuleSetId: p.deviceRuleSetId, deviceRuleId: p.deviceRuleId}).disableAuthz().call()
    return {}
}

function exportProcess(p) {
    require("operate")
    const device = deviceRecord(p.deviceId)
    if (!device.deviceRuleSetId) throw new Error("DEVICE_NO_PROCESS: " + p.deviceId + " runs no process; apply a task first")
    const target = operatedDevice(p.deviceId)
    const requestName = requestOf(target, REQUEST_SUFFIXES.exportProcess, "export a process recipe")
    const out = ec.service.sync().name("moqui.device.DeviceServices.export#DeviceConfig")
        .parameters({deviceRuleSetId: device.deviceRuleSetId, deviceId: target, requestName}).disableAuthz().call() || {}
    return {status: out.status || null, transferredFiles: out.transferredFiles || []}
}

function syncParameters(p) {
    require("operate")
    const target = operatedDevice(p.deviceId)
    const requestName = requestOf(target, REQUEST_SUFFIXES.syncParameters, "synchronize its parameters")
    const out = ec.service.sync().name("moqui.device.DeviceServices.run#DeviceRequest").parameters({requestName}).disableAuthz().call() || {}
    return {status: out.status || null}
}

function transferContent(p) {
    require("operate")
    const content = contentOf(p)
    const requestName = requestOf(content.deviceId, REQUEST_SUFFIXES.transferContent, "transfer content")
    const out = ec.service.sync().name("moqui.device.DeviceServices.transfer#DeviceContent")
        .parameters({deviceContentId: content.deviceContentId, requestName}).disableAuthz().call() || {}
    return {status: out.status || null, transferredFiles: out.transferredFiles || []}
}

// ---- choices

function enumChoices(enumTypeId) {
    return (term, selected) => {
        const query = find("moqui.basic.Enumeration").condition("enumTypeId", enumTypeId)
        if (term) query.condition(textCondition(term, ["description", "enumId"]))
        return {
            options: rows(query.orderBy("sequenceNum,description").limit(CHOICE_LIMIT)).map(row => ({value: row.enumId, label: row.description || row.enumId})),
            label: id => {
                const row = one("moqui.basic.Enumeration", {enumId: id})
                return row && row.enumTypeId === enumTypeId ? row.description || id : null
            }
        }
    }
}

const choiceSources = {
    devices: term => {
        const query = find("moqui.device.DeviceDetail")
        if (term) query.condition(textCondition(term, ["deviceId", "deviceName", "groupName"]))
        return {
            options: rows(query.orderBy("deviceId").limit(CHOICE_LIMIT))
                .filter(row => row.deviceName || row.groupName)
                .map(row => ({value: row.deviceId, label: (row.deviceName || row.groupName) + " · " + row.deviceId})),
            label: id => {
                const row = one("moqui.device.DeviceDetail", {deviceId: id})
                return row ? (row.deviceName || row.groupName || id) + " · " + id : null
            }
        }
    },
    // a device's processes: its own and those of no device
    processes: (term, selected, p) => {
        const factory = ec.entity.conditionFactory
        const query = find("moqui.device.DeviceRuleSet").conditionDate("fromDate", "thruDate", null)
        if (text(p.deviceId)) {
            query.condition(factory.makeCondition(factory.makeCondition("deviceId", "equals", p.deviceId), "or",
                factory.makeCondition("deviceId", "equals", null)))
        }
        if (term) query.condition(textCondition(term, ["deviceRuleSetId", "ruleSetName"]))
        return {
            options: rows(query.orderBy("sequenceNum,^ruleSetName").limit(CHOICE_LIMIT))
                .map(row => ({value: row.deviceRuleSetId, label: row.ruleSetName || row.deviceRuleSetId})),
            label: id => {
                const row = one("moqui.device.DeviceRuleSet", {deviceRuleSetId: id})
                return row ? row.ruleSetName || id : null
            }
        }
    },
    // a process's tasks that may run on the device: those of no device or of this device
    tasks: (term, selected, p) => {
        const options = []
        if (text(p.deviceRuleSetId)) {
            const query = find("moqui.device.DeviceRule").condition("deviceRuleSetId", p.deviceRuleSetId).conditionDate("fromDate", "thruDate", null)
            if (term) query.condition(textCondition(term, ["deviceRuleId", "ruleName"]))
            for (const row of rows(query.orderBy("priority,^ruleName").limit(CHOICE_LIMIT))) {
                if (row.deviceId && p.deviceId && row.deviceId !== p.deviceId) continue
                options.push({value: row.deviceRuleId, label: (row.priority != null ? row.priority + " · " : "") + (row.ruleName || row.deviceRuleId)})
            }
        }
        return {
            options,
            label: id => {
                const row = one("moqui.device.DeviceRule", {deviceRuleId: id})
                return row && (!p.deviceRuleSetId || row.deviceRuleSetId === p.deviceRuleSetId) ? row.ruleName || id : null
            }
        }
    },
    configs: term => {
        const query = find("moqui.device.DeviceConfig")
        if (term) query.condition(textCondition(term, ["deviceConfigId", "configName"]))
        return {
            options: rows(query.orderBy("^configName,deviceConfigId").limit(CHOICE_LIMIT))
                .map(row => ({value: row.deviceConfigId, label: (row.configName || row.deviceConfigId) + " · " + row.deviceConfigId})),
            label: id => {
                const row = one("moqui.device.DeviceConfig", {deviceConfigId: id})
                return row ? (row.configName || id) + " · " + id : null
            }
        }
    },
    // trajectories have no name: the id is the label, as in the Java screens
    trajectories: term => {
        const query = find("moqui.math.Trajectory")
        if (term) query.condition(textCondition(term, ["approximatedFunctionId"]))
        return {
            options: rows(query.orderBy("approximatedFunctionId").limit(CHOICE_LIMIT))
                .map(row => ({value: row.approximatedFunctionId, label: row.approximatedFunctionId})),
            label: id => (one("moqui.math.Trajectory", {approximatedFunctionId: id}) ? id : null)
        }
    },
    deviceTypes: enumChoices("DeviceType"),
    devicePurposes: enumChoices("DevicePurpose"),
    controlMethods: enumChoices("DeviceControlMethod"),
    operatingModes: enumChoices("DeviceOperatingMode"),
    statusTypes: term => {
        const query = find("moqui.basic.StatusType")
        if (term) query.condition(textCondition(term, ["description", "statusTypeId"]))
        return {
            options: rows(query.orderBy("description").limit(CHOICE_LIMIT)).map(row => ({value: row.statusTypeId, label: row.description || row.statusTypeId})),
            label: id => {
                const row = one("moqui.basic.StatusType", {statusTypeId: id})
                return row ? row.description || id : null
            }
        }
    },
    statusFlows: term => {
        const query = find("moqui.basic.StatusFlow")
        if (term) query.condition(textCondition(term, ["description", "statusFlowId"]))
        return {
            options: rows(query.orderBy("description").limit(CHOICE_LIMIT)).map(row => ({value: row.statusFlowId, label: row.description || row.statusFlowId})),
            label: id => {
                const row = one("moqui.basic.StatusFlow", {statusFlowId: id})
                return row ? row.description || id : null
            }
        }
    },
    memberPurposes: enumChoices("DeviceGroupMemberPurpose"),
    memberStatuses: term => {
        const query = find("moqui.basic.StatusItem").condition("statusTypeId", "DeviceGroupMemberStatus")
        if (term) query.condition(textCondition(term, ["description", "statusId"]))
        return {
            options: rows(query.orderBy("sequenceNum").limit(CHOICE_LIMIT)).map(row => ({value: row.statusId, label: row.description || row.statusId})),
            label: id => {
                const row = one("moqui.basic.StatusItem", {statusId: id})
                return row && row.statusTypeId === "DeviceGroupMemberStatus" ? row.description || id : null
            }
        }
    },
    parameterTypes: enumChoices("ParameterType"),
    parameterPurposes: enumChoices("ParameterPurpose"),
    parameterGroups: enumChoices("ParameterGroup"),
    parameterClasses: enumChoices("ParameterClass"),
    parameterPermissions: enumChoices("ParameterPermission"),
    configPurposes: enumChoices("DeviceConfigPurpose"),
    // the statuses of the devices' status types
    deviceStatuses: term => {
        const query = find("moqui.basic.StatusItem").condition("statusTypeId", "in", ["DeviceBasicStatus", "DeviceAdvancedStatus"])
        if (term) query.condition(textCondition(term, ["description", "statusId"]))
        const label = row => row.description + " · " + (row.statusTypeId === "DeviceBasicStatus" ? "basic" : "advanced")
        return {
            options: rows(query.orderBy("statusTypeId,sequenceNum").limit(CHOICE_LIMIT)).map(row => ({value: row.statusId, label: label(row)})),
            label: id => {
                const row = one("moqui.basic.StatusItem", {statusId: id})
                return row ? label(row) : null
            }
        }
    },
    configTypes: enumChoices("DeviceConfigType"),
    processPurposes: enumChoices("DeviceRuleSetPurpose"),
    taskTypes: enumChoices("DeviceRuleType"),
    contentTypes: enumChoices("DeviceContentType")
}

function choices(p) {
    require("read")
    if (!Object.hasOwn(choiceSources, p.choice)) throw new Error("Unknown Devices choice " + p.choice)
    const source = choiceSources[p.choice](text(p.term), text(p.selected), p)
    const options = source.options
    const selected = text(p.selected)
    if (selected && !options.some(option => option.value === selected)) {
        const label = source.label(selected)
        if (label) options.unshift({value: selected, label})
    }
    return {options}
}

const operations = {
    sharedContext,
    home,
    findDevices,
    getDevice,
    findMembers,
    findParameters,
    updateParameterValue,
    findConfigs,
    getConfig,
    updateConfig,
    findProcesses,
    getProcess,
    storeProcess,
    storeTask,
    deleteTask,
    observability,
    contentList,
    contentFile,
    checkContent,
    deleteContent,
    applyTask,
    exportProcess,
    syncParameters,
    transferContent,
    choices
}

function run(op, parameters) {
    if (!operations[op]) throw new Error("Unknown Devices operation " + op)
    return operations[op](parameters || {})
}

;({execute: run, capabilities})
